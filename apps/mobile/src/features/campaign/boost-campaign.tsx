import { usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Linking, View } from 'react-native'

import { Icon } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Badge, Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type BoostReview, type BoostView, type Features } from '../../lib/api'
import { explorerTxUrl, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { useWalletSigner, WalletDeclinedError } from '../../lib/wallet-sign'
import { type CampaignSummary, formatRaw } from '../../shared'

const SKR_DECIMALS = 6

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** The "Boosted with SKR" label: paid placement, always labelled as such (D-50). */
export function BoostedBadge({ until }: { until: string }) {
  return <Badge label={`Boosted with SKR · until ${when(until)}`} tone="skr" />
}

/**
 * D-50: the creator pays the owner-approved SKR package from their own wallet to feature their funded, live drop.
 * The xStock stays the reward; SKR only buys placement. Everything charged and every condition is shown first.
 */
export function BoostCampaign({ campaign, boost }: { campaign: CampaignSummary; boost: Extract<Features['boost'], { enabled: true }> }) {
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const { sign, walletStuck, abandon } = useWalletSigner()
  const [review, setReview] = useState<BoostReview | null>(null)
  const [step, setStep] = useState<'idle' | 'preparing' | 'review' | 'signing' | 'submitting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [done, setDone] = useState<BoostView | null>(null)
  const price = `${formatRaw(BigInt(boost.priceRaw), SKR_DECIMALS, 6)} SKR`

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] }),
      queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] }),
      queryClient.invalidateQueries({ queryKey: ['history'] }),
    ])

  function fail(e: unknown, fallback: string) {
    haptics.error()
    if (e instanceof ApiError && e.code === 'NO_VERIFIED_WALLET') return setError('Connect and verify the wallet that holds your SKR first (You → Wallets).')
    setError(e instanceof ApiError || e instanceof WalletDeclinedError || e instanceof Error ? e.message : fallback)
  }

  async function onReview() {
    setError(null)
    setStep('preparing')
    try {
      setReview((await api.boostPrepare(getAccessToken, campaign.id)).review)
      setStep('review')
    } catch (e) {
      fail(e, 'Could not prepare the boost')
      setStep('idle')
    }
  }

  async function onApprove() {
    if (!review) return
    setError(null)
    setNotice(null)
    setStep('signing')
    try {
      const fresh = await api.boostPrepare(getAccessToken, campaign.id, review.payerWallet)
      if (fresh.review.amountRaw !== review.amountRaw || fresh.review.destination !== review.destination || fresh.review.hours !== review.hours) {
        setReview(fresh.review)
        setNotice('The boost package changed since you reviewed it. Check it again, then approve.')
        setStep('review')
        return
      }
      const signed = await sign(fresh.transaction, fresh.review.payerWallet)
      setStep('submitting')
      setPending(fresh.boostId)
      const res = await api.boostSubmit(getAccessToken, campaign.id, fresh.boostId, signed)
      haptics.success()
      setDone(res.boost)
      await refresh()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRMATION_TIMEOUT') {
        setNotice('Paid — Solana hasn’t confirmed it yet. Tap “Check again” in a moment. The boost starts only once it’s verified.')
      } else if (e instanceof ApiError && e.code === 'EXPIRED') {
        haptics.error()
        setError('That took a little too long and expired on the network. Approve again straight away.')
      } else {
        fail(e, 'The boost payment did not go through.')
      }
      setStep('review')
    }
  }

  async function onCheckAgain() {
    if (!pending) return
    try {
      const res = await api.boost(getAccessToken, campaign.id, pending)
      if (res.boost.status === 'CONFIRMED') {
        haptics.success()
        setDone(res.boost)
        await refresh()
      } else if (res.boost.status === 'FAILED' || res.boost.status === 'EXPIRED') {
        setNotice(null)
        setError('That payment didn’t go through. Nothing was charged except possibly the network fee.')
      } else setNotice('Still confirming. Try again in a few seconds.')
    } catch (e) {
      fail(e, 'Could not check')
    }
  }

  if (done) {
    return (
      <Card style={{ gap: space.sm }} tone="lime">
        <Row>
          <Icon name="bolt" size={20} stroke={color.lime} />
          <T variant="heading">Boosted with SKR</T>
        </Row>
        <T variant="label" color={color.text}>{`Featured from ${when(done.startsAt!)} until ${when(done.endsAt!)}, verified on Solana.`}</T>
        {done.signature ? (
          <Button onPress={() => void Linking.openURL(explorerTxUrl(done.signature!, 'mainnet-beta'))} size="sm" variant="ghost">
            View payment on explorer
          </Button>
        ) : null}
      </Card>
    )
  }

  return (
    <Card style={{ gap: space.md, borderColor: step === 'idle' ? color.border : color.limeLine }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="heading">Boost with SKR</T>
        <Badge label="Sponsored" tone="skr" />
      </Row>
      <T variant="label">{`${price} features this drop for ${boost.hours} hours: first in its club and eligible for Featured on Home, labelled “Boosted with SKR”. The stock reward and claim rules don’t change.`}</T>
      {review ? (
        <View style={{ gap: space.sm }}>
          <Line label="You pay" value={`${formatRaw(BigInt(review.amountRaw), SKR_DECIMALS, 6)} SKR + network fee`} />
          <Line label="Paid to (Blink)" value={shortAddress(review.destination, 6, 6)} />
          <Line label="From your wallet" value={shortAddress(review.payerWallet, 6, 6)} />
          <Line label="Featured for" value={`${review.hours} hours`} />
          <Line label="Starts" value={review.startsAt.includes('T') ? `after the current boost (${when(review.startsAt)})` : review.startsAt} />
          <Line label="Refundable" value="No" />
          <T variant="caption">{review.ifDropEnds} Blink doesn’t promise views, claims or results.</T>
        </View>
      ) : null}
      <Notice message={notice} tone="info" />
      <Notice message={error} />
      {walletStuck ? (
        <Button onPress={() => { abandon(); setStep('review') }} variant="ghost">
          Wallet didn’t open — try again
        </Button>
      ) : null}
      {review ? (
        <Button disabled={step === 'signing' || step === 'submitting'} icon="wallet" loading={step === 'signing' || step === 'submitting'} onPress={() => void onApprove()}>
          {step === 'submitting' ? 'Confirming on Solana…' : `Pay ${price} in wallet`}
        </Button>
      ) : (
        <Button icon="bolt" loading={step === 'preparing'} onPress={() => void onReview()} variant="secondary">
          Review boost
        </Button>
      )}
      {pending && notice ? (
        <Button onPress={() => void onCheckAgain()} variant="ghost">
          Check again
        </Button>
      ) : null}
    </Card>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="label">{label}</T>
      <T style={{ flex: 1, textAlign: 'right', marginLeft: space.md }} variant="bodyStrong">
        {value}
      </T>
    </Row>
  )
}

import { usePrivy } from '@privy-io/expo'
import { getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Icon, type IconName } from '../../design/icons'
import { color, space } from '../../design/tokens'
import { Button, Card, Notice, Row, T } from '../../design/ui'
import { api, ApiError, type PreparedFunding } from '../../lib/api'
import { shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import { type CampaignSummary, PRODUCT_COPY } from '../../shared'

type Step = 'idle' | 'preparing' | 'review' | 'signing' | 'submitting' | 'done'

function formatSol(lamports: string) {
  const n = Number(lamports) / 1e9
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4)
}

function Point({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <Row style={{ alignItems: 'flex-start' }}>
      <View style={styles.pointIcon}>
        <Icon name={icon} size={16} stroke={color.lime} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{title}</T>
        <T variant="label">{body}</T>
      </View>
    </Row>
  )
}

/**
 * Creator-only: fund the campaign account and approve Blink's exact allowance in ONE wallet signature
 * (MASTER_PROMPT §9–§13). The action is explained in plain language before the wallet opens (§26).
 */
export function FundCampaign({ campaign, amountLabel }: { campaign: CampaignSummary; amountLabel: string }) {
  const { getAccessToken } = usePrivy()
  const { connect, signTransactions, account } = useMobileWallet()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<Step>('idle')
  const [plan, setPlan] = useState<PreparedFunding | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsCheck, setNeedsCheck] = useState(false)
  const router = useRouter()
  const [signature, setSignature] = useState<string | null>(null)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['campaign', campaign.id] }),
      queryClient.invalidateQueries({ queryKey: ['my-campaigns'] }),
      queryClient.invalidateQueries({ queryKey: ['campaigns', 'live'] }),
      queryClient.invalidateQueries({ queryKey: ['holdings'] }),
    ])

  function fail(e: unknown, fallback: string) {
    haptics.error()
    // D-20: creators distributing xStocks must confirm eligibility first.
    setNeedsCheck(e instanceof ApiError && e.code === 'NEEDS_ELIGIBILITY')
    setError(e instanceof ApiError || e instanceof Error ? e.message : fallback)
  }

  async function onPrepare() {
    setError(null)
    setStep('preparing')
    try {
      setPlan(await api.fundingPrepare(getAccessToken, campaign.id))
      setStep('review')
    } catch (e) {
      fail(e, 'Could not prepare funding')
      setStep('idle')
    }
  }

  async function onSign() {
    if (!plan) return
    setError(null)
    try {
      // The wallet must be the campaign's creator wallet.
      const active = account ?? (await connect())
      if (active.address.toString() !== campaign.creatorWallet) {
        throw new Error(`Switch to wallet ${shortAddress(campaign.creatorWallet)} in your wallet app, then try again.`)
      }
      setStep('signing')
      const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(plan.transaction))
      const signed = await signTransactions(unsigned)
      setStep('submitting')
      const result = await api.fundingSubmit(getAccessToken, campaign.id, getBase64EncodedWireTransaction(signed))
      setSignature(result.signature)
      await refresh()
      if (result.verified) {
        haptics.success()
        setStep('done')
      } else {
        setError('Sent, but the network hasn’t shown the funded account yet. Tap “Check again” in a moment.')
        setStep('idle')
      }
    } catch (e) {
      fail(e, 'Funding did not complete')
      setStep('review')
    }
  }

  async function onVerify() {
    setError(null)
    try {
      const res = await api.fundingVerify(getAccessToken, campaign.id)
      await refresh()
      if (res.verified) haptics.success()
      else setError('Not funded yet. If you signed, wait a few seconds and check again.')
    } catch (e) {
      fail(e, 'Could not check')
    }
  }

  if (step === 'done') {
    return (
      <Card style={{ gap: space.sm }} tone="lime">
        <Row>
          <Icon name="check" size={20} stroke={color.lime} strokeWidth={2.4} />
          <T variant="heading">Funded — your campaign is live</T>
        </Row>
        <T variant="label" color={color.text}>
          {PRODUCT_COPY.treasuryStatement}
        </T>
        {signature ? <T variant="caption">{`Transaction ${shortAddress(signature, 8, 8)}`}</T> : null}
      </Card>
    )
  }

  if (step === 'review' || step === 'signing' || step === 'submitting') {
    return (
      <Card style={{ gap: space.lg, borderColor: color.limeLine }}>
        <View style={{ gap: 4 }}>
          <T variant="overline">One approval</T>
          <T variant="title">Approve in your wallet</T>
          <T variant="label">Your wallet will show one transaction that does exactly this:</T>
        </View>
        <Point
          body={`${formatSol(plan?.summary.rentLamports ?? '0')} SOL deposit, returned when you close the campaign.`}
          icon="layers"
          title="Creates your campaign account"
        />
        <Point body="It stays in an account you own." icon="arrowRight" title={`Moves ${amountLabel} into it`} />
        <Point body="Never more. You can revoke any time." icon="shield" title={`Lets Blink hand out up to exactly ${amountLabel}`} />
        <T variant="caption">{`Network: ${campaign.cluster} · plus a small network fee`}</T>
        <Notice message={error} />
        <Button disabled={step !== 'review'} icon="wallet" loading={step === 'submitting'} onPress={() => void onSign()}>
          {step === 'signing' ? 'Waiting for your wallet…' : step === 'submitting' ? 'Confirming on Solana…' : 'Open wallet to approve'}
        </Button>
        {step === 'review' ? (
          <Button
            onPress={() => {
              setStep('idle')
              setPlan(null)
            }}
            size="md"
            variant="ghost"
          >
            Cancel
          </Button>
        ) : null}
      </Card>
    )
  }

  return (
    <Card style={{ gap: space.md, borderColor: color.limeLine }}>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={styles.pointIcon}>
          <Icon name="bolt" size={18} stroke={color.lime} strokeWidth={2.2} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="heading">Fund & go live</T>
          <T variant="label">{`Move ${amountLabel} into a campaign account you own and approve Blink to distribute exactly that.`}</T>
        </View>
      </Row>
      <Notice message={error} />
      {needsCheck ? (
        <Button icon="shield" onPress={() => router.push({ pathname: '/eligibility', params: { next: `/campaign/${campaign.id}` } })} variant="secondary">
          Confirm eligibility
        </Button>
      ) : null}
      <Button iconRight="arrowRight" loading={step === 'preparing'} onPress={() => void onPrepare()}>
        Review funding
      </Button>
      {campaign.status === 'AWAITING_FUNDING' ? (
        <Button icon="refresh" onPress={() => void onVerify()} size="md" variant="secondary">
          Check again
        </Button>
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  pointIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: color.limeSoft, alignItems: 'center', justifyContent: 'center' },
})

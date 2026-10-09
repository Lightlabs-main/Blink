import { usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, space } from '../design/tokens'
import { Button, Card, Chip, NavBar, Notice, Row, Screen, T } from '../design/ui'
import { api, ApiError, type TipReview, type TipView } from '../lib/api'
import { useFeatures } from '../lib/data'
import { explorerTxUrl, shortAddress } from '../lib/format'
import { haptics } from '../lib/haptics'
import { useWalletSigner, WalletDeclinedError } from '../lib/wallet-sign'
import { formatRaw, parseAmountToRaw } from '../shared'

const SKR_DECIMALS = 6
const PRESETS = ['1', '5', '10', '25']

function sol(lamports: string) {
  const n = Number(lamports) / 1e9
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4)
}

/**
 * D-49: tip SKR to a club member. Your own wallet (MWA) signs and pays; Blink builds the exact transfer, shows who
 * and which wallet receives it, relays it only unchanged, and calls it sent only after verifying it on Solana.
 */
export default function ClubTip() {
  const router = useRouter()
  const { slug, to, name } = useLocalSearchParams<{ slug: string; to: string; name?: string }>()
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const { sign, walletStuck, abandon } = useWalletSigner()
  const [amount, setAmount] = useState('1')
  const [review, setReview] = useState<TipReview | null>(null)
  const [step, setStep] = useState<'pick' | 'preparing' | 'review' | 'signing' | 'submitting'>('pick')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [done, setDone] = useState<TipView | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const recipient = typeof name === 'string' && name ? name : 'this member'

  function rawAmount(): bigint | null {
    try {
      const raw = parseAmountToRaw(amount, SKR_DECIMALS)
      return raw > 0n ? raw : null
    } catch {
      return null
    }
  }

  function fail(e: unknown, fallback: string) {
    haptics.error()
    if (e instanceof ApiError && e.code === 'NO_VERIFIED_WALLET') {
      setError('Connect and verify the wallet that holds your SKR first (You → Wallets).')
      return
    }
    setError(e instanceof ApiError || e instanceof WalletDeclinedError || e instanceof Error ? e.message : fallback)
  }

  async function onReview() {
    const raw = rawAmount()
    if (!raw) return setError('Enter an amount of SKR.')
    setError(null)
    setNotice(null)
    setStep('preparing')
    try {
      const res = await api.tipPrepare(getAccessToken, String(slug), { to: String(to), amountRaw: raw.toString() })
      setReview(res.review)
      setStep('review')
    } catch (e) {
      fail(e, 'Could not prepare the tip')
      setStep('pick')
    }
  }

  async function onApprove() {
    const raw = rawAmount()
    if (!review || !raw) return
    setError(null)
    setNotice(null)
    setStep('signing')
    try {
      // A fresh transaction right before the wallet opens: Solana transactions expire about a minute after they're built.
      const fresh = await api.tipPrepare(getAccessToken, String(slug), { to: String(to), amountRaw: raw.toString(), wallet: review.senderWallet })
      if (fresh.review.recipientWallet !== review.recipientWallet || fresh.review.amountRaw !== review.amountRaw) {
        // Never sign something materially different from what the person reviewed.
        setReview(fresh.review)
        setNotice('Their receiving wallet changed since you reviewed. Check the details again, then approve.')
        setStep('review')
        return
      }
      const signed = await sign(fresh.transaction, fresh.review.senderWallet)
      setStep('submitting')
      setPendingId(fresh.tipId)
      const res = await api.tipSubmit(getAccessToken, fresh.tipId, signed)
      haptics.success()
      setDone(res.tip)
      await queryClient.invalidateQueries({ queryKey: ['history'] })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRMATION_TIMEOUT') {
        setNotice('Sent — Solana hasn’t confirmed it yet. Tap “Check again” in a moment.')
        setStep('review')
        return
      }
      if (e instanceof ApiError && e.code === 'EXPIRED') {
        haptics.error()
        setError('That took a little too long and expired on the network. Tap “Approve in wallet” again and approve straight away.')
      } else {
        fail(e, 'The tip did not go through.')
      }
      setStep('review')
    }
  }

  async function onCheckAgain() {
    if (!pendingId) return
    try {
      const res = await api.tip(getAccessToken, pendingId)
      if (res.tip.status === 'CONFIRMED') {
        haptics.success()
        setDone(res.tip)
        await queryClient.invalidateQueries({ queryKey: ['history'] })
      } else if (res.tip.status === 'FAILED' || res.tip.status === 'EXPIRED') {
        setNotice(null)
        setError('That transfer didn’t go through. Nothing was sent.')
      } else {
        setNotice('Still confirming. Try again in a few seconds.')
      }
    } catch (e) {
      fail(e, 'Could not check')
    }
  }

  if (done) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Tip SKR" />
        <Card style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }} tone="lime">
          <View style={styles.badge}>
            <Icon name="check" size={26} stroke={color.onMarker} strokeWidth={2.6} />
          </View>
          <T align="center" variant="title">{`You tipped ${done.to.skrName ?? recipient} ${formatRaw(BigInt(done.amountRaw), SKR_DECIMALS, 6)} SKR`}</T>
          <T align="center" variant="label">Verified on Solana. It’s in both of your Receipts & Activity, and they’ve been notified.</T>
        </Card>
        <Button onPress={() => router.back()}>Back</Button>
        {done.signature ? (
          <Button onPress={() => void Linking.openURL(explorerTxUrl(done.signature!, 'mainnet-beta'))} variant="ghost">
            View on explorer
          </Button>
        ) : null}
      </Screen>
    )
  }

  if (features.data && !features.data.tips.enabled) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Tip SKR" />
        <Notice message="SKR tips aren’t available right now." tone="info" />
      </Screen>
    )
  }

  const busy = step === 'preparing' || step === 'signing' || step === 'submitting'
  return (
    <Screen>
      <NavBar onBack={() => router.back()} title={`Tip ${recipient}`} />
      {step === 'pick' || step === 'preparing' ? (
        <>
          <Card style={{ gap: space.md }}>
            <T variant="overline">Amount</T>
            <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
              {PRESETS.map((p) => (
                <Chip key={p} label={`${p} SKR`} onPress={() => setAmount(p)} selected={amount === p} />
              ))}
            </Row>
            <Row>
              <TextInput
                inputMode="decimal"
                onChangeText={(v) => setAmount(v.replace(',', '.'))}
                placeholder="0"
                placeholderTextColor={color.textMuted}
                style={[styles.amount, font('display')]}
                value={amount}
              />
              <T style={{ ...font('display'), fontSize: 24, color: color.textMuted }}>SKR</T>
            </Row>
          </Card>
          <T variant="caption">You’ll see exactly who and which wallet receives it before your wallet opens. Your wallet pays the small network fee.</T>
          <Notice message={error} />
          <Button disabled={!rawAmount() || busy} icon="send" loading={step === 'preparing'} onPress={() => void onReview()}>
            Review tip
          </Button>
        </>
      ) : review ? (
        <>
          <Card style={{ gap: space.md, borderColor: color.limeLine }}>
            <T variant="overline">Review</T>
            <T variant="title">{`${formatRaw(BigInt(review.amountRaw), SKR_DECIMALS, 6)} SKR`}</T>
            <Detail label="To" value={review.recipient.skrName ?? review.recipient.label} />
            <Detail label="Their wallet" value={`${shortAddress(review.recipientWallet, 6, 6)} · ${review.recipientWalletKind === 'VERIFIED_WALLET' ? 'verified by them' : 'their Blink wallet'}`} />
            <Detail label="From your wallet" value={shortAddress(review.senderWallet, 6, 6)} />
            <Detail label="Network fee" value={`≈ ${sol(review.networkFeeLamports)} SOL`} />
            {review.createsRecipientAccount ? <Detail label="Their SKR account" value={`opened for them · ${sol(review.rentLamports)} SOL rent, paid by you`} /> : null}
            <Detail label="Network" value={review.network} />
            <T variant="caption">Token transfers can’t be undone. Only verified SKR (mint SKRbvo…ZhW3) is sent.</T>
          </Card>
          <Notice message={notice} tone="info" />
          <Notice message={error} />
          {walletStuck ? (
            <Card style={{ gap: space.sm }} tone="raised">
              <T variant="label">Your wallet app didn’t open. Make sure a Solana wallet (Seed Vault, Phantom or Solflare) is installed, then try again.</T>
              <Button onPress={() => { abandon(); setStep('review') }} variant="ghost">Try again</Button>
            </Card>
          ) : null}
          <Button disabled={busy} icon="wallet" loading={step === 'signing' || step === 'submitting'} onPress={() => void onApprove()}>
            {step === 'submitting' ? 'Confirming on Solana…' : 'Approve in wallet'}
          </Button>
          {pendingId && notice ? (
            <Button onPress={() => void onCheckAgain()} variant="ghost">
              Check again
            </Button>
          ) : null}
          <Button disabled={busy} onPress={() => setStep('pick')} variant="ghost">
            Change amount
          </Button>
        </>
      ) : null}
    </Screen>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <T variant="label">{label}</T>
      <T style={{ flex: 1, textAlign: 'right', marginLeft: space.md }} variant="bodyStrong">
        {value}
      </T>
    </Row>
  )
}

const styles = StyleSheet.create({
  amount: { flex: 1, fontSize: 40, color: color.text, paddingVertical: space.sm },
  badge: { width: 56, height: 56, borderRadius: 28, backgroundColor: color.marker, alignItems: 'center', justifyContent: 'center' },
})

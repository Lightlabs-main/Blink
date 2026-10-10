import { useEmbeddedSolanaWallet, usePrivy } from '@privy-io/expo'
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, type SignatureBytes } from '@solana/kit'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, space } from '../design/tokens'
import { Button, Card, Chip, NavBar, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../design/ui'
import { PeoplePicker } from '../features/gifts/people-picker'
import { api, ApiError, type FoundPerson, type TipReview } from '../lib/api'
import { useFeatures } from '../lib/data'
import { explorerTxUrl, shortAddress } from '../lib/format'
import { haptics } from '../lib/haptics'
import { useWalletSigner, WalletDeclinedError } from '../lib/wallet-sign'
import { formatRaw, parseAmountToRaw } from '../shared'

const SKR_DECIMALS = 6
const SKR_PRESETS = ['1', '5', '10', '25']

function sol(lamports: string) {
  const n = Number(lamports) / 1e9
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4)
}

/** Exact amount for "Max" (formatRaw rounds for display). */
function exact(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals)
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${raw / scale}.${frac}` : `${raw / scale}`
}

/**
 * Gift a person, found by Blink username or .skr name: stock from your Blink wallet (Blink pays the fee, as in club
 * gifts) or SKR from your own wallet (you approve in your wallet app). Nothing is "sent" until Solana confirms it.
 */
export default function GiftPerson() {
  const router = useRouter()
  const params = useLocalSearchParams<{ to?: string }>()
  const { getAccessToken } = usePrivy()
  const solana = useEmbeddedSolanaWallet()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const { sign, walletStuck, abandon } = useWalletSigner()
  const [people, setPeople] = useState<FoundPerson[]>([])
  const [kind, setKind] = useState<'STOCK' | 'SKR'>('STOCK')
  const [mint, setMint] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [review, setReview] = useState<TipReview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ text: string; signature: string | null; pending: boolean } | null>(null)

  const wallet = useQuery({ queryKey: ['stock-wallet'], queryFn: () => api.stockWallet(getAccessToken) })
  const stocks = (wallet.data?.wallet.assets ?? []).filter((a) => BigInt(a.raw) > 0n)
  const selected = stocks.find((a) => a.mint === mint) ?? stocks[0]
  const person = people[0] ?? null
  const skrOn = Boolean(features.data?.tips.enabled)
  const name = person?.skrName ?? person?.label ?? (typeof params.to === 'string' ? params.to : '')

  function fail(e: unknown, fallback: string) {
    haptics.error()
    if (e instanceof ApiError && e.code === 'NO_VERIFIED_WALLET') return setError('Connect and verify the wallet that holds your SKR first (You → Wallets).')
    setError(e instanceof ApiError || e instanceof WalletDeclinedError || e instanceof Error ? e.message : fallback)
  }

  async function onGiftStock() {
    if (!person || !selected || !wallet.data) return
    setError(null)
    let raw: bigint
    try {
      raw = parseAmountToRaw(amount, selected.decimals)
    } catch (e) {
      return setError(e instanceof Error ? e.message : 'Enter an amount')
    }
    if (raw <= 0n) return setError('Enter an amount')
    if (raw > BigInt(selected.raw)) return setError(`You have ${formatRaw(BigInt(selected.raw), selected.decimals)} ${selected.symbol}.`)
    const embedded = 'wallets' in solana ? solana.wallets?.find((x) => x.address === wallet.data!.wallet.wallet) : undefined
    if (!embedded) return setError('Your Blink wallet is still connecting. Try again in a moment.')
    setBusy(true)
    try {
      const { prepared } = await api.giftPersonPrepare(getAccessToken, { to: person.handle, asset: selected.mint, amountRaw: raw.toString() })
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
      // Same signing as Send and club gifts (D-32): the Blink wallet signs the message bytes in the app.
      const provider = await embedded.getProvider()
      const { signature } = await provider.request({ method: 'signMessage', params: { message: getBase64Decoder().decode(tx.messageBytes) } })
      const signed = { ...tx, signatures: { ...tx.signatures, [wallet.data.wallet.wallet]: getBase64Encoder().encode(signature) as SignatureBytes } }
      const res = await api.giftPersonSubmit(getAccessToken, getBase64Decoder().decode(getTransactionEncoder().encode(signed)))
      haptics.success()
      setDone({ text: `${amount} ${selected.symbol} to ${name}`, signature: res.gift.signature, pending: res.gift.status !== 'CONFIRMED' })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-wallet'] }), queryClient.invalidateQueries({ queryKey: ['history'] })])
    } catch (e) {
      fail(e, 'The gift did not go through.')
    } finally {
      setBusy(false)
    }
  }

  function skrRaw(): bigint | null {
    try {
      const r = parseAmountToRaw(amount, SKR_DECIMALS)
      return r > 0n ? r : null
    } catch {
      return null
    }
  }

  async function onReviewSkr() {
    const raw = skrRaw()
    if (!person || !raw) return setError('Enter an amount of SKR.')
    setError(null)
    setBusy(true)
    try {
      setReview((await api.skrGiftPrepare(getAccessToken, { to: person.handle, amountRaw: raw.toString() })).review)
    } catch (e) {
      fail(e, 'Could not prepare the gift')
    } finally {
      setBusy(false)
    }
  }

  async function onApproveSkr() {
    const raw = skrRaw()
    if (!person || !review || !raw) return
    setError(null)
    setBusy(true)
    try {
      // Fresh transaction right before the wallet opens (they expire about a minute after they're built).
      const fresh = await api.skrGiftPrepare(getAccessToken, { to: person.handle, amountRaw: raw.toString(), wallet: review.senderWallet })
      if (fresh.review.recipientWallet !== review.recipientWallet) {
        setReview(fresh.review)
        setError('Their receiving wallet changed since you reviewed. Check it again, then approve.')
        return
      }
      const signed = await sign(fresh.transaction, fresh.review.senderWallet)
      const res = await api.tipSubmit(getAccessToken, fresh.tipId, signed)
      haptics.success()
      setDone({ text: `${formatRaw(BigInt(res.tip.amountRaw), SKR_DECIMALS, 6)} SKR to ${name}`, signature: res.tip.signature, pending: false })
      await queryClient.invalidateQueries({ queryKey: ['history'] })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIRMATION_TIMEOUT') {
        setDone({ text: `SKR to ${name}`, signature: null, pending: true })
      } else fail(e, 'The gift did not go through.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Gift" />
        <Card style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }} tone={done.pending ? 'raised' : 'lime'}>
          <View style={styles.badge}>
            <Icon name={done.pending ? 'clock' : 'check'} size={26} stroke={color.onMarker} strokeWidth={2.6} />
          </View>
          <T align="center" variant="title">
            {done.pending ? 'Still confirming…' : `Sent ${done.text} ✓`}
          </T>
          <T align="center" variant="label">
            {done.pending ? 'Solana hasn’t confirmed it yet. It shows in your Activity once it does.' : 'They’ve been notified. It’s in your Receipts & Activity.'}
          </T>
        </Card>
        <Button onPress={() => router.back()}>Done</Button>
        {done.signature ? (
          <Button onPress={() => void Linking.openURL(explorerTxUrl(done.signature!, 'mainnet-beta'))} variant="ghost">
            View on explorer
          </Button>
        ) : null}
      </Screen>
    )
  }

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Gift a person" />
      <PeoplePicker
        multiple={false}
        onChange={(p) => {
          setPeople(p)
          setReview(null)
        }}
        value={people}
      />

      {person ? (
        <>
          <Row gap={space.sm}>
            <Chip label="Stock" onPress={() => { setKind('STOCK'); setReview(null); setAmount('') }} selected={kind === 'STOCK'} />
            {skrOn ? <Chip label="SKR" onPress={() => { setKind('SKR'); setReview(null); setAmount('1') }} selected={kind === 'SKR'} /> : null}
          </Row>

          {kind === 'STOCK' ? (
            wallet.isPending ? (
              <Skeleton height={120} />
            ) : stocks.length === 0 ? (
              <Notice message="You need stock in your Blink wallet to gift it. Win a drop or receive some first." tone="info" />
            ) : (
              <>
                <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
                  {stocks.map((s) => (
                    <Chip key={s.mint} label={`${s.symbol} · ${formatRaw(BigInt(s.raw), s.decimals, 4)}`} onPress={() => setMint(s.mint)} selected={selected?.mint === s.mint} />
                  ))}
                </Row>
                {selected ? (
                  <Card style={{ gap: space.md }}>
                    <Row>
                      <StockAvatar isTest={selected.isTest} logo={selected.logo} size={40} symbol={selected.symbol} />
                      <View style={{ flex: 1 }}>
                        <T variant="bodyStrong">{selected.symbol}</T>
                        <T variant="caption">{`You have ${formatRaw(BigInt(selected.raw), selected.decimals, 6)}`}</T>
                      </View>
                      <Chip label="Max" onPress={() => setAmount(exact(BigInt(selected.raw), selected.decimals))} selected={false} />
                    </Row>
                    <TextInput inputMode="decimal" onChangeText={(v) => setAmount(v.replace(',', '.'))} placeholder="0.00" placeholderTextColor={color.textMuted} style={[styles.amount, font('display')]} value={amount} />
                  </Card>
                ) : null}
                <T variant="caption">{`From your Blink wallet to ${name}'s Blink wallet. Blink pays the network fee. They need xStocks eligibility. Gifts can't be undone.`}</T>
                <Notice message={error} />
                <Button disabled={!amount || busy} icon="gift" loading={busy} onPress={() => void onGiftStock()}>
                  {selected ? `Gift ${amount || '0'} ${selected.symbol}` : 'Gift'}
                </Button>
              </>
            )
          ) : review ? (
            <>
              <Card style={{ gap: space.md, borderColor: color.limeLine }}>
                <T variant="overline">Review</T>
                <T variant="title">{`${formatRaw(BigInt(review.amountRaw), SKR_DECIMALS, 6)} SKR`}</T>
                <Line label="To" value={name} />
                <Line label="Their wallet" value={`${shortAddress(review.recipientWallet, 6, 6)} · ${review.recipientWalletKind === 'VERIFIED_WALLET' ? 'verified by them' : 'their Blink wallet'}`} />
                <Line label="From your wallet" value={shortAddress(review.senderWallet, 6, 6)} />
                <Line label="Network fee" value={`≈ ${sol(review.networkFeeLamports)} SOL`} />
                {review.createsRecipientAccount ? <Line label="Their SKR account" value={`opened · ${sol(review.rentLamports)} SOL rent, paid by you`} /> : null}
                <Line label="Network" value={review.network} />
                <T variant="caption">Token transfers can’t be undone.</T>
              </Card>
              <Notice message={error} />
              {walletStuck ? (
                <Button onPress={abandon} variant="ghost">
                  Wallet didn’t open — try again
                </Button>
              ) : null}
              <Button disabled={busy} icon="wallet" loading={busy} onPress={() => void onApproveSkr()}>
                Approve in wallet
              </Button>
              <Button disabled={busy} onPress={() => setReview(null)} variant="ghost">
                Change amount
              </Button>
            </>
          ) : (
            <>
              <Card style={{ gap: space.md }}>
                <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
                  {SKR_PRESETS.map((p) => (
                    <Chip key={p} label={`${p} SKR`} onPress={() => setAmount(p)} selected={amount === p} />
                  ))}
                </Row>
                <TextInput inputMode="decimal" onChangeText={(v) => setAmount(v.replace(',', '.'))} placeholder="0" placeholderTextColor={color.textMuted} style={[styles.amount, font('display')]} value={amount} />
              </Card>
              <T variant="caption">From your own wallet (Seed Vault, Phantom or Solflare); you’ll see who and which wallet receives it before approving.</T>
              <Notice message={error} />
              <Button disabled={!skrRaw() || busy} icon="send" loading={busy} onPress={() => void onReviewSkr()}>
                Review gift
              </Button>
            </>
          )}
        </>
      ) : null}
    </Screen>
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

const styles = StyleSheet.create({
  amount: { fontSize: 40, color: color.text, paddingVertical: space.sm },
  badge: { width: 56, height: 56, borderRadius: 28, backgroundColor: color.marker, alignItems: 'center', justifyContent: 'center' },
})

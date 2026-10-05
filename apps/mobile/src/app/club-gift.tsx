import { useEmbeddedSolanaWallet, usePrivy } from '@privy-io/expo'
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, type SignatureBytes } from '@solana/kit'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, space } from '../design/tokens'
import { Button, Card, Chip, EmptyState, NavBar, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../design/ui'
import { api, ApiError } from '../lib/api'
import { explorerTxUrl } from '../lib/format'
import { haptics } from '../lib/haptics'
import { formatRaw, parseAmountToRaw } from '../shared'

/** Exact amount for "Max" (formatRaw rounds for display). */
function exact(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals)
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${raw / scale}.${frac}` : `${raw / scale}`
}

/**
 * D-44: gift xStock to a club member from your Blink wallet. Blink finds their wallet (you never see it), pays the
 * network fee, and posts the gift in the chat only once Solana confirms it. Both of you need xStocks eligibility.
 */
export default function ClubGift() {
  const router = useRouter()
  const { slug, to, name } = useLocalSearchParams<{ slug: string; to: string; name?: string }>()
  const { getAccessToken } = usePrivy()
  const solana = useEmbeddedSolanaWallet()
  const queryClient = useQueryClient()
  const [mint, setMint] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ status: 'CONFIRMED' | 'PENDING'; signature: string; cluster: string } | null>(null)

  const wallet = useQuery({ queryKey: ['stock-wallet'], queryFn: () => api.stockWallet(getAccessToken) })
  const w = wallet.data?.wallet
  const stocks = (w?.assets ?? []).filter((a) => BigInt(a.raw) > 0n)
  const selected = stocks.find((a) => a.mint === mint) ?? stocks[0]
  const recipient = typeof name === 'string' && name ? name : 'this member'

  async function onGift() {
    if (!w || !selected) return
    setError(null)
    let raw: bigint
    try {
      raw = parseAmountToRaw(amount, selected.decimals)
    } catch (e) {
      return setError(e instanceof Error ? e.message : 'Enter an amount')
    }
    if (raw <= 0n) return setError('Enter an amount')
    if (raw > BigInt(selected.raw)) return setError(`You have ${formatRaw(BigInt(selected.raw), selected.decimals)} ${selected.symbol}.`)
    const embedded = 'wallets' in solana ? solana.wallets?.find((x) => x.address === w.wallet) : undefined
    if (!embedded) return setError('Your Blink wallet is still connecting. Try again in a moment.')

    setBusy(true)
    try {
      const { prepared } = await api.giftPrepare(getAccessToken, String(slug), { to: String(to), asset: selected.mint, amountRaw: raw.toString() })
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
      // Same signing as Send (D-32): the Blink wallet signs the message bytes in the app.
      const provider = await embedded.getProvider()
      const { signature } = await provider.request({ method: 'signMessage', params: { message: getBase64Decoder().decode(tx.messageBytes) } })
      const signed = { ...tx, signatures: { ...tx.signatures, [w.wallet]: getBase64Encoder().encode(signature) as SignatureBytes } }
      const res = await api.giftSubmit(getAccessToken, String(slug), getBase64Decoder().decode(getTransactionEncoder().encode(signed)))
      haptics.success()
      setDone({ status: res.gift.status, signature: res.gift.signature, cluster: res.message?.gift?.cluster ?? 'devnet' })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-wallet'] }), queryClient.invalidateQueries({ queryKey: ['history'] })])
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'The gift did not go through.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} title="Gift" />
        <Card style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }} tone={done.status === 'CONFIRMED' ? 'lime' : 'raised'}>
          <View style={styles.badge}>
            <Icon name={done.status === 'CONFIRMED' ? 'check' : 'clock'} size={26} stroke={color.onMarker} strokeWidth={2.6} />
          </View>
          <T align="center" variant="title">
            {done.status === 'CONFIRMED' ? `Gift sent to ${recipient} ✓` : 'Still confirming…'}
          </T>
          <T align="center" variant="label">
            {done.status === 'CONFIRMED'
              ? 'It’s in the club chat and in their Receipts & Activity.'
              : 'Solana hasn’t confirmed it yet. It shows in your Activity; it won’t appear in the chat until it’s confirmed.'}
          </T>
        </Card>
        <Button onPress={() => router.back()}>Back to the chat</Button>
        <Button onPress={() => void Linking.openURL(explorerTxUrl(done.signature, done.cluster))} variant="ghost">
          View on explorer
        </Button>
      </Screen>
    )
  }

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title={`Gift ${recipient}`} />
      {wallet.isPending ? (
        <Skeleton height={120} />
      ) : stocks.length === 0 ? (
        <EmptyState action="Find a drop" body="You need stock in your Blink wallet to gift it. Win a drop or receive some first." icon="gift" onAction={() => router.push('/drops')} title="No stock to gift" />
      ) : (
        <>
          <View style={{ gap: space.sm }}>
            <T variant="overline">Stock</T>
            <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
              {stocks.map((s) => (
                <Chip key={s.mint} label={`${s.symbol} · ${formatRaw(BigInt(s.raw), s.decimals, 4)}`} onPress={() => setMint(s.mint)} selected={selected?.mint === s.mint} />
              ))}
            </Row>
          </View>
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
              <TextInput
                inputMode="decimal"
                onChangeText={(v) => setAmount(v.replace(',', '.'))}
                placeholder="0.00"
                placeholderTextColor={color.textMuted}
                style={[styles.amount, font('display')]}
                value={amount}
              />
            </Card>
          ) : null}
          <T variant="caption">
            {`Sent from your Blink wallet to ${recipient}'s Blink wallet. Blink pays the network fee. You'll never see their wallet address, and it appears in the chat once Solana confirms it. Gifts can't be undone.`}
          </T>
          <Notice message={error} />
          <Button disabled={!amount || busy} icon="gift" loading={busy} onPress={() => void onGift()}>
            {selected ? `Gift ${amount || '0'} ${selected.symbol}` : 'Gift'}
          </Button>
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  amount: { fontSize: 40, color: color.text, paddingVertical: space.sm, borderBottomWidth: 1, borderColor: color.border },
  badge: { width: 56, height: 56, borderRadius: 28, backgroundColor: color.marker, alignItems: 'center', justifyContent: 'center' },
})

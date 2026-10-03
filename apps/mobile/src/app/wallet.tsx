import { useEmbeddedSolanaWallet, usePrivy } from '@privy-io/expo'
import { getBase64Decoder, getBase64Encoder, getTransactionDecoder, getTransactionEncoder, type SignatureBytes } from '@solana/kit'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Linking, Share, StyleSheet, TextInput, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'

import { font } from '../design/fonts'
import { color, radius, space } from '../design/tokens'
import { Button, Card, Chip, NavBar, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../design/ui'
import { api, ApiError, type StockWallet } from '../lib/api'
import { useNetwork } from '../lib/data'
import { explorerTxUrl, shortAddress } from '../lib/format'
import { haptics } from '../lib/haptics'
import { formatRaw, parseAmountToRaw } from '../shared'

const SOL = { key: 'SOL', symbol: 'SOL', decimals: 9, logo: null as string | null, isTest: false }
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

type Holding = { key: string; symbol: string; decimals: number; logo: string | null; isTest: boolean; raw: bigint }

function holdingsOf(w: StockWallet | undefined): Holding[] {
  if (!w) return []
  return [
    ...w.assets.filter((a) => BigInt(a.raw) > 0n).map((a) => ({ key: a.mint, symbol: a.symbol, decimals: a.decimals, logo: a.logo, isTest: a.isTest, raw: BigInt(a.raw) })),
    { ...SOL, raw: BigInt(w.solLamports) },
  ]
}

/** Exact amount for "Max" (formatRaw rounds for display). */
function exact(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals)
  const frac = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${raw / scale}.${frac}` : `${raw / scale}`
}

/**
 * D-32: the Blink stock wallet (the wallet Blink created at sign-in). Receive shows the address and QR; Send moves
 * stock or SOL to any Solana address. Blink pays the network fee, so the wallet needs no SOL; the wallet signs in
 * the app (Privy) and Blink's server only adds its fee signature.
 */
export default function StockWalletScreen() {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const solana = useEmbeddedSolanaWallet()
  const queryClient = useQueryClient()
  const network = useNetwork()
  const cluster = network.data?.cluster ?? 'devnet'
  const [tab, setTab] = useState<'send' | 'receive'>('send')
  const [assetKey, setAssetKey] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ signature: string; label: string } | null>(null)

  const wallet = useQuery({ queryKey: ['stock-wallet'], queryFn: () => api.stockWallet(getAccessToken), refetchInterval: busy ? false : 20_000 })
  const w = wallet.data?.wallet
  const holdings = holdingsOf(w)
  const selected = holdings.find((h) => h.key === assetKey) ?? holdings.find((h) => h.raw > 0n && h.key !== 'SOL') ?? holdings[holdings.length - 1]

  async function onSend() {
    if (!w || !selected) return
    setError(null)
    setSent(null)
    let raw: bigint
    try {
      raw = parseAmountToRaw(amount, selected.decimals)
    } catch (e) {
      return setError(e instanceof Error ? e.message : 'Enter an amount')
    }
    const dest = to.trim()
    if (raw <= 0n) return setError('Enter an amount')
    if (raw > selected.raw) return setError(`You have ${formatRaw(selected.raw, selected.decimals)} ${selected.symbol}.`)
    if (!BASE58.test(dest)) return setError('Paste a valid Solana address.')
    if (dest === w.wallet) return setError('That is this wallet’s own address.')
    const embedded = 'wallets' in solana ? solana.wallets?.find((x) => x.address === w.wallet) : undefined
    if (!embedded) return setError('Your Blink wallet is still connecting. Try again in a moment.')

    setBusy(true)
    try {
      const { prepared } = await api.sendPrepare(getAccessToken, { asset: selected.key, to: dest, amountRaw: raw.toString() })
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
      // Privy signs a Solana transaction by signing its message bytes (this is what its provider does internally).
      const provider = await embedded.getProvider()
      const { signature } = await provider.request({ method: 'signMessage', params: { message: getBase64Decoder().decode(tx.messageBytes) } })
      const signed = { ...tx, signatures: { ...tx.signatures, [w.wallet]: getBase64Encoder().encode(signature) as SignatureBytes } }
      const result = await api.sendSubmit(getAccessToken, getBase64Decoder().decode(getTransactionEncoder().encode(signed)))
      haptics.success()
      setSent({ signature: result.signature, label: `${amount} ${selected.symbol} to ${shortAddress(dest)}` })
      setAmount('')
      setTo('')
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['stock-wallet'] }), queryClient.invalidateQueries({ queryKey: ['holdings'] })])
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'The transfer did not go through.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <NavBar onBack={() => router.back()} title="Stock wallet" />

      <Card>
        <View style={{ gap: space.md }}>
          <T variant="overline">Created for you by Blink</T>
          {wallet.isLoading ? (
            <Skeleton height={20} width={200} />
          ) : (
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="numeric">{w ? shortAddress(w.wallet, 6, 6) : '—'}</T>
              {w ? (
                <Button icon="share" onPress={() => void Share.share({ message: w.wallet })} size="sm" variant="secondary">
                  Share
                </Button>
              ) : null}
            </Row>
          )}
          <View style={{ gap: space.sm }}>
            {holdings.map((h) => (
              <Row key={h.key} style={{ justifyContent: 'space-between' }}>
                <Row>
                  <StockAvatar isTest={h.isTest} logo={h.logo} size={30} symbol={h.symbol} />
                  <T variant="bodyStrong">{h.symbol}</T>
                </Row>
                <T variant="numeric">{formatRaw(h.raw, h.decimals, 4)}</T>
              </Row>
            ))}
          </View>
        </View>
      </Card>

      <Row gap={space.sm}>
        <Chip icon="arrowUpRight" label="Send" onPress={() => setTab('send')} selected={tab === 'send'} />
        <Chip icon="scan" label="Receive" onPress={() => setTab('receive')} selected={tab === 'receive'} />
      </Row>

      {tab === 'receive' ? (
        <Card>
          <View style={{ alignItems: 'center', gap: space.lg }}>
            {w ? (
              <View style={styles.qr}>
                <QRCode backgroundColor="#ffffff" color="#0D0D0B" size={200} value={w.wallet} />
              </View>
            ) : null}
            <T align="center" variant="numeric" style={{ fontSize: 13 }}>
              {w?.wallet ?? ''}
            </T>
            <T align="center" variant="caption">
              Send only Solana tokens (SOL and xStocks) to this address.{cluster !== 'mainnet-beta' ? ' This is a devnet test wallet.' : ''}
            </T>
            {w ? (
              <Button icon="share" onPress={() => void Share.share({ message: w.wallet })} style={{ alignSelf: 'stretch' }}>
                Share address
              </Button>
            ) : null}
          </View>
        </Card>
      ) : (
        <View style={{ gap: space.md }}>
          <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
            {holdings.map((h) => (
              <Chip key={h.key} label={h.symbol} onPress={() => setAssetKey(h.key)} selected={selected?.key === h.key} />
            ))}
          </Row>
          <View style={styles.field}>
            <TextInput
              inputMode="decimal"
              onChangeText={(v) => setAmount(v.replace(',', '.'))}
              placeholder="0"
              placeholderTextColor={color.textMuted}
              selectionColor={color.lime}
              style={[styles.amount, font('display')]}
              value={amount}
            />
            <T variant="bodyStrong">{selected?.symbol ?? ''}</T>
            {selected ? <Chip label="Max" onPress={() => setAmount(exact(selected.raw, selected.decimals))} selected={false} /> : null}
          </View>
          <View style={styles.field}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setTo}
              placeholder="Recipient’s Solana address"
              placeholderTextColor={color.textMuted}
              selectionColor={color.lime}
              style={[styles.address, font('numeric')]}
              value={to}
            />
          </View>
          <T variant="caption">Blink pays the network fee. Transfers on Solana can’t be reversed, so check the address.</T>
          <Notice message={error} />
          <Button disabled={busy || !amount || !to} icon="arrowUpRight" loading={busy} onPress={() => void onSend()}>
            {selected ? `Send ${selected.symbol}` : 'Send'}
          </Button>
        </View>
      )}

      {sent ? (
        <Card tone="lime">
          <View style={{ gap: space.sm }}>
            <T variant="heading">Sent</T>
            <T variant="label">{sent.label}</T>
            <Button onPress={() => void Linking.openURL(explorerTxUrl(sent.signature, cluster))} size="sm" variant="secondary">
              View on Solana Explorer
            </Button>
          </View>
        </Card>
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  qr: { padding: 14, borderRadius: radius.lg, backgroundColor: '#ffffff' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  amount: { flex: 1, fontSize: 30, paddingVertical: space.md, color: color.text },
  address: { flex: 1, fontSize: 14, paddingVertical: space.lg, color: color.text },
})

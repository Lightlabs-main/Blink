import { usePrivy } from '@privy-io/expo'
import { address, getAddressEncoder, getBase58Decoder, getBase64Decoder, getBase64Encoder, getTransactionDecoder } from '@solana/kit'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { transact } from '@wallet-ui/react-native-kit'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { color, radius, space } from '../design/tokens'
import { Badge, Button, Card, Chip, DoubleRule, EmptyState, NavBar, Notice, Row, Screen, Skeleton, T } from '../design/ui'
import { identity } from '../features/core/data-access/app-providers'
import { api, ApiError, type SkrAction, type SkrPosition } from '../lib/api'
import { useMe } from '../lib/data'
import { shortAddress } from '../lib/format'
import { haptics } from '../lib/haptics'
import { formatRaw, parseAmountToRaw } from '../shared'

const SKR_DECIMALS = 6
const skr = (raw: string | bigint) => formatRaw(BigInt(raw), SKR_DECIMALS, 2)

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function remaining(ms: number) {
  if (ms <= 0) return 'ready'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.ceil((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}

/**
 * D-23: stake SKR with Solana Mobile's guardian pool from inside Blink. Real SKR on MAINNET: Blink builds and
 * simulates the transaction, the user's own wallet app signs and sends it. Blink never holds SKR.
 */
export default function SkrStaking() {
  const router = useRouter()
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const me = useMe()
  const wallets = me.data?.verifiedCreatorWallets ?? []
  const [picked, setPicked] = useState<string | null>(null)
  const wallet = picked && wallets.includes(picked) ? picked : (wallets[0] ?? null)
  const [mode, setMode] = useState<'stake' | 'unstake'>('stake')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<SkrAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const now = useNow(30_000)

  const position = useQuery({
    queryKey: ['skr', wallet],
    queryFn: () => api.skrPosition(getAccessToken, wallet!),
    enabled: Boolean(wallet),
    refetchInterval: busy ? false : 20_000,
  })
  const p: SkrPosition | undefined = position.data?.position

  async function run(action: SkrAction, opts: { amountRaw?: bigint; all?: boolean } = {}) {
    if (!wallet) return
    setError(null)
    setSent(null)
    setBusy(action)
    try {
      const { prepared } = await api.skrPrepare(getAccessToken, {
        wallet,
        action,
        amountRaw: opts.amountRaw ? opts.amountRaw.toString() : undefined,
        all: opts.all,
      })
      const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
      const [signature] = await transact(async (w) => {
        // Mainnet, whatever cluster Blink's drops run on: SKR exists only there.
        const auth = await w.authorize({ chain: 'solana:mainnet', identity })
        const shared = auth.accounts.map((a) => a.address)
        // MWA reports accounts as base64 public keys.
        const wanted = getBase64Decoder().decode(getAddressEncoder().encode(address(wallet)))
        if (!shared.includes(wanted)) throw new Error(`Switch to ${shortAddress(wallet)} in your wallet app, then try again.`)
        return await w.signAndSendTransactions({ minContextSlot: Number(prepared.minContextSlot), transactions: [tx] })
      })
      if (!signature) throw new Error('Your wallet app did not send the transaction')
      haptics.success()
      setSent(getBase58Decoder().decode(signature))
      setAmount('')
      // Give the network a moment, then re-read the position.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['skr', wallet] }), 4000)
    } catch (e) {
      haptics.error()
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
    }
  }

  function onSubmit() {
    if (!p) return
    let raw: bigint
    try {
      raw = parseAmountToRaw(amount, SKR_DECIMALS)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enter an amount')
      return
    }
    if (raw <= 0n) return setError('Enter an amount')
    const max = BigInt(mode === 'stake' ? p.walletRaw : p.stakedRaw)
    if (raw > max) return setError(mode === 'stake' ? 'That is more SKR than this wallet holds.' : 'That is more than you have staked.')
    // "Max" unstakes every share, so no dust is left behind by rounding.
    void run(mode, raw === max && mode === 'unstake' ? { all: true } : { amountRaw: raw })
  }

  if (me.isSuccess && !wallets.length) {
    return (
      <Screen>
        <NavBar onBack={() => router.back()} />
        <EmptyState
          action="Link wallet"
          body="Link the wallet that holds your SKR (on a Seeker, that is Seed Vault). Blink only builds the transaction; your wallet signs it."
          icon="wallet"
          onAction={() => router.push('/login/wallet')}
          title="Link your SKR wallet"
        />
      </Screen>
    )
  }

  const unstaking = p ? BigInt(p.unstakingRaw) : 0n
  const readyAt = p?.withdrawableAt ? Date.parse(p.withdrawableAt) : null
  const ready = readyAt !== null && readyAt <= now

  return (
    <Screen>
      <NavBar onBack={() => router.back()} />
      <View style={{ gap: space.sm }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T variant="overline">Solana Mobile staking</T>
          <Badge label="Mainnet · real SKR" tone="warn" />
        </Row>
        <T variant="display">Stake SKR</T>
        <T variant="body">Stake with Solana Mobile’s guardian pool without leaving Blink. Your wallet signs; Blink never holds your SKR.</T>
      </View>
      <DoubleRule />

      {wallets.length > 1 ? (
        <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
          {wallets.map((w) => (
            <Chip key={w} label={shortAddress(w)} onPress={() => setPicked(w)} selected={w === wallet} />
          ))}
        </Row>
      ) : null}

      <Card>
        {position.isLoading || !p ? (
          position.isError ? (
            <Notice message={position.error instanceof Error ? position.error.message : 'Could not read SKR right now.'} tone="warn" />
          ) : (
            <View style={{ gap: space.md }}>
              <Skeleton height={28} width={180} />
              <Skeleton height={18} width={120} />
            </View>
          )
        ) : (
          <View style={{ gap: space.md }}>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <View>
                <T variant="caption">Staked</T>
                <T style={[font('display'), { fontSize: 40, lineHeight: 44, color: color.text }]}>{skr(p.stakedRaw)}</T>
              </View>
              <T variant="overline">SKR</T>
            </Row>
            <View style={styles.ledger}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">In wallet {shortAddress(p.wallet)}</T>
                <T variant="numeric">{skr(p.walletRaw)}</T>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">Unstaking</T>
                <T variant="numeric">{skr(p.unstakingRaw)}</T>
              </Row>
              <Row style={{ justifyContent: 'space-between' }}>
                <T variant="label">Cooldown</T>
                <T variant="numeric">{Math.round(p.cooldownSeconds / 3600)}h</T>
              </Row>
            </View>
          </View>
        )}
      </Card>

      {p && unstaking > 0n ? (
        <Card tone="lime">
          <View style={{ gap: space.md }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="heading">{skr(unstaking)} SKR unstaking</T>
              <Badge label={readyAt ? remaining(readyAt - now) : '—'} tone={ready ? 'live' : 'neutral'} />
            </Row>
            <T variant="caption">
              {ready ? 'The cooldown is over. Withdraw to move it back to your wallet.' : 'You can cancel to stake it again, or withdraw once the cooldown ends.'}
            </T>
            <Row gap={space.sm}>
              <Button disabled={!ready || busy !== null} loading={busy === 'withdraw'} onPress={() => void run('withdraw')} style={{ flex: 1 }}>
                Withdraw
              </Button>
              <Button disabled={busy !== null} loading={busy === 'cancel_unstake'} onPress={() => void run('cancel_unstake')} style={{ flex: 1 }} variant="secondary">
                Cancel
              </Button>
            </Row>
          </View>
        </Card>
      ) : null}

      {p ? (
        <View style={{ gap: space.md }}>
          <Row gap={space.sm}>
            <Chip label="Stake" onPress={() => setMode('stake')} selected={mode === 'stake'} />
            <Chip label="Unstake" onPress={() => setMode('unstake')} selected={mode === 'unstake'} />
          </Row>
          <View style={styles.amountRow}>
            <TextInput
              inputMode="decimal"
              onChangeText={(v) => setAmount(v.replace(',', '.'))}
              placeholder="0"
              placeholderTextColor={color.textMuted}
              selectionColor={color.text}
              style={[styles.amountInput, font('display')]}
              value={amount}
            />
            <T variant="overline">SKR</T>
            <Chip label="Max" onPress={() => setAmount(skrExact(mode === 'stake' ? p.walletRaw : p.stakedRaw))} selected={false} />
          </View>
          <T variant="caption">
            {mode === 'stake'
              ? `Minimum ${skr(p.minStakeRaw)} SKR. A small SOL network fee is paid by your wallet.`
              : `Unstaking starts a ${Math.round(p.cooldownSeconds / 3600)}h cooldown. ${unstaking > 0n ? 'Finish the pending unstake first.' : ''}`}
          </T>
          <Button
            disabled={busy !== null || !amount || (mode === 'unstake' && unstaking > 0n)}
            loading={busy === mode}
            onPress={onSubmit}
            size="lg"
          >
            {mode === 'stake' ? 'Stake SKR' : 'Unstake SKR'}
          </Button>
        </View>
      ) : null}

      <Notice message={error} />
      {sent ? (
        <Card>
          <View style={{ gap: space.sm }}>
            <T variant="bodyStrong">Sent to Solana mainnet</T>
            <T variant="caption">Your balance updates in a few seconds.</T>
            <Button onPress={() => void Linking.openURL(`https://solscan.io/tx/${sent}`)} size="sm" variant="secondary">
              View on Solscan
            </Button>
          </View>
        </Card>
      ) : null}
      <T variant="caption">Staking uses the official SKR staking program. Rewards and the cooldown are set by Solana Mobile, not Blink.</T>
    </Screen>
  )
}

/** Full-precision amount for the "Max" chip (formatRaw trims to a few decimals). */
function skrExact(raw: string) {
  const v = BigInt(raw)
  const scale = 10n ** BigInt(SKR_DECIMALS)
  const frac = (v % scale).toString().padStart(SKR_DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${v / scale}.${frac}` : `${v / scale}`
}

const styles = StyleSheet.create({
  ledger: { gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderColor: color.border },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  amountInput: { flex: 1, fontSize: 32, paddingVertical: space.md, color: color.text },
})

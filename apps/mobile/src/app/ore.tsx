import { usePrivy } from '@privy-io/expo'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Linking, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../design/fonts'
import { Icon } from '../design/icons'
import { color, radius, space } from '../design/tokens'
import { Badge, Button, Card, Chip, NavBar, Notice, PulseDot, Row, Screen, SectionHeader, Skeleton, T } from '../design/ui'
import { api, ApiError, type OreDeployResult, type OreReview } from '../lib/api'
import { useFeatures, useOreBoard, useOreMe } from '../lib/data'
import { explorerTxUrl, shortAddress } from '../lib/format'
import { haptics } from '../lib/haptics'
import { useWalletSigner, WalletDeclinedError } from '../lib/wallet-sign'

/** Lamports → SOL text without float drift for display (amounts are always sent as integer lamports). */
function sol(lamports: string | bigint, max = 6) {
  const v = BigInt(lamports)
  const whole = v / 1_000_000_000n
  const frac = (v % 1_000_000_000n).toString().padStart(9, '0').slice(0, max).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/** Compact SOL for the grid cells. */
function compactSol(lamports: string) {
  const n = Number(lamports) / 1e9
  if (n === 0) return '0'
  if (n < 0.01) return '<0.01'
  return n < 10 ? n.toFixed(2) : n.toFixed(1)
}

/** Owner-capped presets: ¼, ½ and the full cap per square (integer lamports, never below 1,000). */
function presets(cap: bigint): bigint[] {
  return [...new Set([cap / 4n, cap / 2n, cap].filter((v) => v >= 1_000n))]
}

/**
 * D-51: the ORE live board, read from the ORE program's Board and Round accounts on mainnet (via Blink's API, which
 * decodes them from the official layout). Deploying commits real SOL from the person's own wallet (MWA): Blink
 * shows the full cost first, never deploys by itself and only records a deploy after verifying its DeployEvent.
 */
export default function OreBoardScreen() {
  const router = useRouter()
  const { getAccessToken, user } = usePrivy()
  const queryClient = useQueryClient()
  const features = useFeatures()
  const board = useOreBoard()
  const me = useOreMe()
  const { sign, walletStuck, abandon } = useWalletSigner()
  const cfg = board.data?.config ?? features.data?.ore
  const cap = cfg?.maxLamportsPerSquare ? BigInt(cfg.maxLamportsPerSquare) : null
  const maxSquares = cfg?.maxSquares ?? 1
  const [selected, setSelected] = useState<number[]>([])
  const [amount, setAmount] = useState<bigint | null>(null)
  const [review, setReview] = useState<OreReview | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [step, setStep] = useState<'pick' | 'preparing' | 'review' | 'signing' | 'submitting'>('pick')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<OreDeployResult | null>(null)
  const [verifySig, setVerifySig] = useState('')
  const [verifying, setVerifying] = useState(false)

  const amountChoices = useMemo(() => (cap ? presets(cap) : []), [cap])
  const chosenAmount = amount ?? amountChoices[0] ?? null

  // A new round makes a reviewed transaction stale: it can't be approved; the person reviews the new round again.
  // Their own square choice is kept, never changed for them.
  const roundId = board.data?.roundId ?? null
  const staleReview = Boolean(review && roundId && review.roundId !== roundId)

  const mineThisRound = me.data && me.data.roundId === roundId ? me.data.squaresThisRound : []
  const deployEnabled = Boolean(cfg?.deployEnabled && cap)
  const busy = step === 'preparing' || step === 'signing' || step === 'submitting'

  function toggle(i: number) {
    if (!deployEnabled || busy || mineThisRound.includes(i)) return
    haptics.tap()
    setError(null)
    setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : maxSquares === 1 ? [i] : s.length >= maxSquares ? s : [...s, i]))
  }

  function fail(e: unknown, fallback: string) {
    haptics.error()
    if (e instanceof ApiError && e.code === 'NO_VERIFIED_WALLET') return setError('Connect and verify a Solana wallet first (You → Wallets).')
    setError(e instanceof ApiError || e instanceof WalletDeclinedError || e instanceof Error ? e.message : fallback)
  }

  async function onReview() {
    if (!selected.length || !chosenAmount) return
    setError(null)
    setNotice(null)
    setStep('preparing')
    try {
      const res = await api.orePrepare(getAccessToken, { squares: selected, amountLamports: chosenAmount.toString() })
      setReview(res.review)
      setAccepted(false)
      setStep('review')
    } catch (e) {
      fail(e, 'Could not prepare the deploy')
      setStep('pick')
    }
  }

  async function onApprove() {
    if (!review || !accepted || !chosenAmount || staleReview) return
    setError(null)
    setNotice(null)
    setStep('signing')
    try {
      const fresh = await api.orePrepare(getAccessToken, { squares: selected, amountLamports: chosenAmount.toString(), wallet: review.wallet })
      // Different round, squares or total from what was reviewed: show it and require a new approval.
      if (fresh.review.roundId !== review.roundId || fresh.review.cost.total !== review.cost.total || fresh.review.squares.join() !== review.squares.join()) {
        setReview(fresh.review)
        setAccepted(false)
        setNotice(fresh.review.roundId !== review.roundId ? `A new round (#${fresh.review.roundId}) started. Check the details and approve again.` : 'The cost changed. Check the details and approve again.')
        setStep('review')
        return
      }
      const signed = await sign(fresh.transaction, fresh.review.wallet)
      setStep('submitting')
      const res = await api.oreSubmit(getAccessToken, signed)
      haptics.success()
      setResult(res.deploy)
      setSelected([])
      setReview(null)
      setStep('pick')
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['ore-me'] }), queryClient.invalidateQueries({ queryKey: ['history'] }), queryClient.invalidateQueries({ queryKey: ['profile'] })])
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EXPIRED') {
        haptics.error()
        setError('That took too long and expired on the network. Nothing was deployed. Review again and approve straight away.')
        setReview(null)
        setStep('pick')
        return
      }
      fail(e, 'The deploy did not go through.')
      setStep('review')
    }
  }

  async function onVerify() {
    setVerifying(true)
    setError(null)
    try {
      const res = await api.oreVerify(getAccessToken, verifySig.trim())
      haptics.success()
      setResult(res.deploy)
      setVerifySig('')
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['ore-me'] }), queryClient.invalidateQueries({ queryKey: ['history'] }), queryClient.invalidateQueries({ queryKey: ['profile'] })])
    } catch (e) {
      fail(e, 'Could not verify that deploy')
    } finally {
      setVerifying(false)
    }
  }

  const b = board.data
  const phaseText = !b ? '' : b.phase === 'MINING' ? `Mining · about ${b.secondsLeftEstimate}s left` : b.phase === 'WAITING' ? 'Waiting for the first deploy' : 'Round closed · next one opening'

  return (
    <Screen refreshControl={<RefreshControl onRefresh={() => void Promise.all([board.refetch(), me.refetch()])} refreshing={false} tintColor={color.text} />}>
      <NavBar onBack={() => router.back()} title="ORE Miners" />

      <Card style={{ gap: space.sm }} tone="raised">
        <Row>
          <Icon name="target" size={18} stroke={color.ogOre} />
          <T variant="heading">How ORE mining works</T>
        </Row>
        <T variant="label">
          Each round (about 1½ minutes), miners deploy SOL on squares of a 5×5 board. When it ends, the protocol picks one winning square; SOL on the other squares,
          minus protocol fees, goes to the miners on the winning square, and newly minted ORE goes to winners there. You can lose what you deploy, or get back only part of it. Deploying is not a
          fee and ORE rewards are never guaranteed.
        </T>
        <T variant="caption">Board read live from the ORE program on Solana mainnet (regolith-labs/ore). Blink isn’t affiliated with ORE.</T>
      </Card>

      {board.isError ? (
        <Notice message="The ORE board can’t be read right now. Pull to retry." tone="warn" />
      ) : !b ? (
        <Skeleton height={340} radius={radius.lg} />
      ) : (
        <Card style={{ gap: space.md }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <T variant="overline">{`Round #${b.roundId}`}</T>
              <Row gap={6}>
                {b.phase === 'MINING' ? <PulseDot /> : null}
                <T variant="bodyStrong">{phaseText}</T>
              </Row>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <T variant="numeric">{`${compactSol(b.totalDeployedLamports)} SOL`}</T>
              <T variant="caption">{`${b.totalMiners} miners`}</T>
            </View>
          </Row>
          <View style={{ gap: 6 }}>
            {[0, 1, 2, 3, 4].map((r) => (
              <View key={r} style={{ flexDirection: 'row', gap: 6 }}>
                {b.squares.slice(r * 5, r * 5 + 5).map((sq) => {
                  const on = selected.includes(sq.index)
                  const mine = mineThisRound.includes(sq.index)
                  return (
                    <Pressable
                      accessibilityLabel={`Square ${sq.index + 1}: ${compactSol(sq.deployedLamports)} SOL, ${sq.miners} miners${mine ? ', yours' : ''}`}
                      disabled={!deployEnabled || mine}
                      key={sq.index}
                      onPress={() => toggle(sq.index)}
                      style={[styles.cell, on && styles.cellOn, mine && styles.cellMine]}
                    >
                      <T style={[styles.cellNum, on && { color: color.onMarker }]}>{sq.index + 1}</T>
                      <T style={[styles.cellSol, on && { color: color.onMarker }]}>{compactSol(sq.deployedLamports)}</T>
                      <T style={[styles.cellMiners, on && { color: color.onMarker }]}>{mine ? 'yours' : `${sq.miners}`}</T>
                    </Pressable>
                  )
                })}
              </View>
            ))}
          </View>
          <T variant="caption">Each square shows SOL deployed (top) and the number of miners. Updated every few seconds.</T>
        </Card>
      )}

      {result ? (
        <Card style={{ gap: space.sm }} tone="lime">
          <Row>
            <Icon name="check" size={20} stroke={color.lime} strokeWidth={2.4} />
            <T variant="heading">Deploy verified on Solana</T>
          </Row>
          <T variant="label" color={color.text}>
            {`Round #${result.roundId} · square${result.squares.length === 1 ? '' : 's'} ${result.squares.map((q) => q + 1).join(', ')} · ${sol(result.totalLamports)} SOL deployed. You’re a verified ORE Miner ✓`}
          </T>
          <T variant="caption">This records your deploy; it doesn’t mean you won. Check the round’s outcome in your wallet or ore.supply.</T>
          <Button onPress={() => void Linking.openURL(explorerTxUrl(result.signature, 'mainnet-beta'))} size="sm" variant="ghost">
            View on explorer
          </Button>
        </Card>
      ) : null}

      {!deployEnabled ? (
        <Notice message="Deploying from Blink isn’t switched on yet. You can watch the live board and verify deploys you made with your own wallet." tone="info" />
      ) : step === 'review' || step === 'signing' || step === 'submitting' ? (
        review ? (
          <Card style={{ gap: space.md, borderColor: color.limeLine }}>
            <T variant="overline">{`Review · round #${review.roundId}`}</T>
            <T variant="title">{`Deploy ${sol(review.cost.stake)} SOL`}</T>
            <Detail label="Squares" value={review.squares.map((q) => q + 1).join(', ')} />
            <Detail label="Per square" value={`${sol(review.lamportsPerSquare)} SOL`} />
            {review.cost.minerRent !== '0' ? <Detail label="Miner account (first deploy)" value={`${sol(review.cost.minerRent)} SOL rent`} /> : null}
            {review.cost.checkpointFee !== '0' ? <Detail label="ORE checkpoint fee" value={`${sol(review.cost.checkpointFee)} SOL`} /> : null}
            <Detail label="Network fee" value={`≈ ${sol(review.cost.networkFee)} SOL`} />
            <Detail label="Total from your wallet" value={`up to ${sol(review.cost.total)} SOL`} />
            <Detail label="Wallet" value={shortAddress(review.wallet, 6, 6)} />
            <Detail label="Network" value={review.network} />
            {review.includesCheckpoint ? <T variant="caption">Includes settling your previous ORE round first, as the protocol requires.</T> : null}
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: accepted }} onPress={() => setAccepted((a) => !a)} style={styles.ack}>
              <View style={[styles.box, accepted && styles.boxOn]}>{accepted ? <Icon name="check" size={14} stroke={color.onMarker} strokeWidth={3} /> : null}</View>
              <T style={{ flex: 1 }} variant="label">
                {review.risk}
              </T>
            </Pressable>
            <Notice message={notice} tone="info" />
            <Notice message={error} />
            {walletStuck ? (
              <Button onPress={() => { abandon(); setStep('review') }} variant="ghost">
                Wallet didn’t open — try again
              </Button>
            ) : null}
            {staleReview ? (
              <>
                <Notice message={`Round #${review.roundId} ended. Your squares are still selected.`} tone="warn" />
                <Button icon="refresh" onPress={() => void onReview()}>
                  {`Review again for round #${roundId}`}
                </Button>
              </>
            ) : (
              <Button disabled={!accepted || busy} icon="wallet" loading={step === 'signing' || step === 'submitting'} onPress={() => void onApprove()}>
                {step === 'submitting' ? 'Verifying on Solana…' : 'Approve in wallet'}
              </Button>
            )}
            <Button disabled={busy} onPress={() => { setReview(null); setStep('pick') }} variant="ghost">
              Change squares or amount
            </Button>
          </Card>
        ) : null
      ) : (
        <Card style={{ gap: space.md }}>
          <T variant="heading">Deploy</T>
          <T variant="label">{selected.length ? `Square${selected.length === 1 ? '' : 's'} ${selected.map((q) => q + 1).join(', ')}` : `Tap ${maxSquares === 1 ? 'a square' : `up to ${maxSquares} squares`} on the board.`}</T>
          <View style={{ gap: space.sm }}>
            <T variant="overline">SOL per square</T>
            <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
              {amountChoices.map((a) => (
                <Chip key={a.toString()} label={`${sol(a)} SOL`} onPress={() => setAmount(a)} selected={chosenAmount === a} />
              ))}
            </Row>
            {cap ? <T variant="caption">{`Blink caps deploys at ${sol(cap)} SOL per square.`}</T> : null}
          </View>
          <Notice message={notice} tone="info" />
          <Notice message={error} />
          {!user ? (
            <Button onPress={() => router.push('/login')}>Sign in to deploy</Button>
          ) : (
            <Button disabled={!selected.length || !chosenAmount || busy || b?.phase === 'BETWEEN'} icon="target" loading={step === 'preparing'} onPress={() => void onReview()}>
              Review deploy
            </Button>
          )}
        </Card>
      )}

      {user ? (
        <View style={{ gap: space.md }}>
          <SectionHeader title="Your verified deploys" />
          <Card style={{ gap: space.sm }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T variant="bodyStrong">{me.data?.minerMark ? 'Verified ORE Miner ✓' : 'No verified deploy yet'}</T>
              {me.data?.minerMark ? <Badge label="ORE Miner" tone="warn" /> : null}
            </Row>
            {(me.data?.recent ?? []).map((d) => (
              <Pressable key={d.signature} onPress={() => void Linking.openURL(explorerTxUrl(d.signature, 'mainnet-beta'))}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T variant="label">{`Round #${d.roundId} · sq ${d.squares.map((q) => q + 1).join(', ')}`}</T>
                  <T variant="numeric">{`${sol(d.totalLamports)} SOL`}</T>
                </Row>
              </Pressable>
            ))}
            <T variant="caption">Mined with your own wallet elsewhere? Paste the transaction signature to verify it.</T>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setVerifySig}
              placeholder="Transaction signature"
              placeholderTextColor={color.textMuted}
              style={styles.input}
              value={verifySig}
            />
            <Button disabled={verifySig.trim().length < 64 || verifying} loading={verifying} onPress={() => void onVerify()} size="sm" variant="secondary">
              Verify deploy
            </Button>
          </Card>
        </View>
      ) : null}
    </Screen>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
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
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: radius.sm,
    backgroundColor: color.surface2,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  cellOn: { backgroundColor: color.marker, borderColor: color.marker },
  cellMine: { borderColor: color.ogOre, borderWidth: 1.5 },
  cellNum: { ...font('bodySemi'), fontSize: 10, color: color.textMuted },
  cellSol: { ...font('numeric'), fontSize: 12.5, color: color.text },
  cellMiners: { ...font('body'), fontSize: 9.5, color: color.textMuted },
  ack: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: color.borderStrong, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: color.marker, borderColor: color.marker },
  input: { ...font('numeric'), fontSize: 13, color: color.text, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
})

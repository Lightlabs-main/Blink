import { usePrivy } from '@privy-io/expo'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { font } from '../../design/fonts'
import { Icon } from '../../design/icons'
import { color, gutter, space } from '../../design/tokens'
import { Backdrop, Button, Loading, NavBar, Notice, T } from '../../design/ui'
import { ClaimReceipt, claimQueryKey, needsEligibility, sentence, useClaimRefresh, useMyClaim } from '../../features/campaign/claim-panel'
import { api, ApiError } from '../../lib/api'
import { displayShares, useAssetMap } from '../../lib/data'
import { haptics } from '../../lib/haptics'
import type { ClaimSummary } from '../../shared'

type Phase =
  | { name: 'intro' }
  | { name: 'countdown'; n: number }
  | { name: 'playing' }
  | { name: 'checking' }
  | { name: 'missed'; taps: number; attemptsLeft: number }
  | { name: 'claiming' }
  | { name: 'claimed'; claim: ClaimSummary }

/**
 * Counts down `durationMs`, reporting the time left every 100 ms, then calls onDone slightly after the end.
 * Returns the round clock: ms since the round started, used to timestamp taps (D-14).
 */
function runRoundTimer(durationMs: number, timers: ReturnType<typeof setTimeout>[], onTick: (leftMs: number) => void, onDone: () => void) {
  const startedAt = Date.now()
  const endsAt = startedAt + durationMs
  const tick = () => {
    const left = Math.max(0, endsAt - Date.now())
    onTick(left)
    if (left > 0) timers.push(setTimeout(tick, 100))
    // A little past the end so the server never sees a short round.
    else timers.push(setTimeout(onDone, 250))
  }
  tick()
  return () => Date.now() - startedAt
}

/** Full-screen Tap Rush (DECISIONS D-13, D-14): the server times the round and judges the tap timings. */
export default function TapRush() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const campaignId = String(id)
  const { getAccessToken } = usePrivy()
  const queryClient = useQueryClient()
  const refresh = useClaimRefresh(campaignId)
  const assets = useAssetMap()
  const campaign = useQuery({ queryKey: ['campaign', campaignId], queryFn: () => api.campaign(campaignId) })
  const mine = useMyClaim(campaignId)

  const [phase, setPhase] = useState<Phase>({ name: 'intro' })
  const [taps, setTaps] = useState(0)
  const [remainingMs, setRemainingMs] = useState(0)
  const [pressed, setPressed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const session = useRef<{ id: string } | null>(null)
  const tapTimes = useRef<number[]>([])
  const roundClock = useRef<{ elapsed: () => number; durationMs: number } | null>(null)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const c = campaign.data?.campaign
  const rules = c?.tapRush
  const back = () => (router.canGoBack() ? router.back() : router.replace(`/campaign/${campaignId}`))

  if (campaign.isPending) return <Loading label="Loading Tap Rush…" />
  if (!c || !rules) {
    return (
      <View style={[styles.page, { paddingTop: insets.top + space.lg }]}>
        <NavBar onBack={back} />
        <Notice message={campaign.error ? campaign.error.message : 'This drop is not a Tap Rush.'} />
      </View>
    )
  }

  const asset = assets.get(c.mint)
  const rewardLabel = `${c.rewardPerClaimRaw ? (displayShares(asset, c.rewardPerClaimRaw) ?? '') : ''} ${c.xstockSymbol}`.trim()
  // The query polls while a payout is confirming, so prefer it over the snapshot from the claim call.
  const existing = mine.data?.claim ?? (phase.name === 'claimed' ? phase.claim : undefined)
  const alreadyClaimed = existing && existing.status !== 'FAILED'

  function fail(e: unknown) {
    haptics.error()
    setBlocked(needsEligibility(e))
    setError(e instanceof ApiError || e instanceof Error ? sentence(e.message) : 'Something went wrong')
  }

  async function start() {
    setError(null)
    setTaps(0)
    tapTimes.current = []
    roundClock.current = null
    setPhase({ name: 'countdown', n: 3 })
    haptics.tap()
    // The server clock starts now; the countdown only adds time, so the round can never look too short.
    const started = api.tapRushStart(getAccessToken, campaignId)
    for (const n of [2, 1]) {
      timers.current.push(
        setTimeout(() => {
          haptics.tap()
          setPhase({ name: 'countdown', n })
        }, (3 - n) * 1000),
      )
    }
    try {
      const [{ session: s }] = await Promise.all([started, new Promise((r) => timers.current.push(setTimeout(r, 3000)))])
      session.current = s
      play(s.seconds * 1000)
    } catch (e) {
      timers.current.forEach(clearTimeout)
      setPhase({ name: 'intro' })
      fail(e)
    }
  }

  function play(durationMs: number) {
    haptics.success()
    setPhase({ name: 'playing' })
    const elapsed = runRoundTimer(durationMs, timers.current, setRemainingMs, () => void finish())
    roundClock.current = { elapsed, durationMs }
  }

  async function finish() {
    const s = session.current
    if (!s) return
    setPhase({ name: 'checking' })
    try {
      const result = await api.tapRushFinish(getAccessToken, campaignId, s.id, tapTimes.current)
      if (!result.qualified) {
        haptics.error()
        setPhase({ name: 'missed', taps: result.taps, attemptsLeft: result.attemptsLeft })
        return
      }
      setPhase({ name: 'claiming' })
      const { claim } = await api.claim(getAccessToken, campaignId, { tapSessionId: s.id })
      queryClient.setQueryData(claimQueryKey(campaignId), { claim })
      if (claim.status === 'PAID') haptics.success()
      void refresh()
      setPhase({ name: 'claimed', claim })
    } catch (e) {
      setPhase({ name: 'intro' })
      fail(e)
    }
  }

  function onTap() {
    const clock = roundClock.current
    if (phase.name !== 'playing' || !clock) return
    const at = Math.round(clock.elapsed())
    // Taps after the buzzer don't count.
    if (at > clock.durationMs) return
    tapTimes.current.push(at)
    setTaps(tapTimes.current.length)
    haptics.tap()
  }

  const progress = Math.min(1, taps / rules.goal)
  const reached = taps >= rules.goal

  if (phase.name === 'playing' || phase.name === 'countdown') {
    return (
      <View style={[styles.page, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}>
        <Backdrop tone={reached ? 'lime' : 'mixed'} height={600} />
        <View style={styles.hud}>
          <View>
            <T variant="overline">Taps</T>
            <T style={styles.hudNumber}>{`${taps}/${rules.goal}`}</T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T variant="overline">Time</T>
            <T style={styles.hudNumber}>{phase.name === 'playing' ? (remainingMs / 1000).toFixed(1) : rules.seconds.toFixed(1)}</T>
          </View>
        </View>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${progress * 100}%`, backgroundColor: reached ? color.success : color.lime }]} />
        </View>
        <View style={styles.center}>
          {phase.name === 'countdown' ? (
            <T style={styles.countdown}>{String(phase.n)}</T>
          ) : (
            <Pressable
              accessibilityLabel="Tap"
              accessibilityRole="button"
              onPressIn={() => {
                setPressed(true)
                onTap()
              }}
              onPressOut={() => setPressed(false)}
              style={[styles.tapTarget, reached && styles.tapTargetDone, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}
            >
              <Icon name={reached ? 'check' : 'bolt'} size={72} stroke={color.onLime} strokeWidth={2.4} />
              <T style={styles.tapLabel}>{reached ? 'Goal! Keep going' : 'TAP!'}</T>
            </Pressable>
          )}
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.page, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xl }]}>
      <Backdrop tone="lime" />
      <NavBar onBack={back} />
      <View style={{ flex: 1, justifyContent: 'center', gap: space.xl }}>
        {phase.name === 'checking' || phase.name === 'claiming' ? (
          <View style={{ alignItems: 'center', gap: space.md }}>
            <T variant="display" align="center">
              {phase.name === 'checking' ? 'Checking your score…' : `Sending ${rewardLabel}…`}
            </T>
            <T align="center">{phase.name === 'claiming' ? 'You made it! Your stock is on its way to your Blink wallet.' : ' '}</T>
            <Button loading onPress={() => {}} variant="secondary">
              Please wait
            </Button>
          </View>
        ) : alreadyClaimed && existing ? (
          <View style={{ gap: space.lg }}>
            <T variant="display">{existing.status === 'PAID' ? 'You earned it!' : 'Almost there'}</T>
            <ClaimReceipt asset={asset} claim={existing} />
            <Button onPress={() => router.replace('/home')} variant="secondary">
              Back to home
            </Button>
          </View>
        ) : (
          <View style={{ gap: space.lg }}>
            <View style={{ gap: space.sm }}>
              <T variant="overline">Tap Rush</T>
              <T variant="hero">{phase.name === 'missed' ? 'So close!' : `Win ${rewardLabel}`}</T>
              <T style={{ fontSize: 17 }}>
                {phase.name === 'missed'
                  ? `You tapped ${phase.taps} times — the goal is ${rules.goal}.`
                  : `Tap ${rules.goal} times in ${rules.seconds} seconds. Hit the goal and the reward is yours.`}
              </T>
            </View>
            <Notice message={error} />
            {blocked ? (
              <Button icon="shield" onPress={() => router.push({ pathname: '/eligibility', params: { next: `/tap-rush/${campaignId}` } })}>
                Confirm eligibility
              </Button>
            ) : null}
            {phase.name === 'missed' && phase.attemptsLeft === 0 ? (
              <Notice message="You’ve used all your tries for this drop." tone="warn" />
            ) : (
              <Button icon="bolt" onPress={() => void start()}>
                {phase.name === 'missed' ? `Try again · ${phase.attemptsLeft} left` : 'Start'}
              </Button>
            )}
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg, paddingHorizontal: gutter },
  hud: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  hudNumber: { ...font('display'), fontSize: 40, lineHeight: 46, color: color.text, fontVariant: ['tabular-nums'] },
  bar: { height: 10, borderRadius: 5, backgroundColor: color.surface3, overflow: 'hidden', marginTop: space.lg },
  barFill: { height: 10, borderRadius: 5 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  countdown: { ...font('display'), fontSize: 140, lineHeight: 150, color: color.lime },
  tapTarget: {
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: color.lime,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    shadowColor: color.lime,
    shadowOpacity: 0.6,
    shadowRadius: 40,
    elevation: 12,
  },
  tapTargetDone: { backgroundColor: color.success },
  tapLabel: { ...font('display'), fontSize: 26, color: color.onLime },
})

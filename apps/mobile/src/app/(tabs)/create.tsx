import { usePrivy } from '@privy-io/expo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon, type IconName } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Badge, Button, Card, Chip, EmptyState, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { describeCondition } from '../../features/campaign/quest-panel'
import { useMyClubs } from '../../features/clubs/club-ui'
import { type TokenRule, tokenGroup, TokenRuleCard } from '../../features/rules/rule-builder'
import { api, ApiError } from '../../lib/api'
import { useAssets, useHoldings, useMe } from '../../lib/data'
import { CAMPAIGN_TYPE_BLURB, CAMPAIGN_TYPE_ICON, CAMPAIGN_TYPE_LABEL, shortAddress } from '../../lib/format'
import { haptics } from '../../lib/haptics'
import {
  type CampaignType,
  maxClaims,
  parseAmountToRaw,
  PRODUCT_COPY,
  type QuestCondition,
  type QuestGroup,
  type QuestRequirements,
  rawToUiShares,
  TAP_RUSH_DEFAULTS,
  TAP_RUSH_LIMITS,
  uiSharesToRawFloor,
  VERIFIERS,
} from '../../shared'

type Conversion = { ok: true; raw: bigint; display: string } | { ok: false; error: string }
type StepId = 'experience' | 'eligibility' | 'action' | 'reward' | 'limits' | 'review'

const STEP_TITLE: Record<StepId, string> = {
  experience: 'What do you want your community to do?',
  eligibility: 'Who can join?',
  action: 'What must they complete?',
  reward: 'Choose the reward',
  limits: 'Set the limits',
  review: 'Review',
}

/** Experiences a creator can launch today; future ones are shown but not selectable. */
const EXPERIENCES: { type: CampaignType; label: string; blurb: string; icon: IconName }[] = [
  { type: 'TAP_RUSH', label: 'Tap Rush', blurb: 'A fast, live tapping challenge.', icon: 'target' },
  { type: 'EARLY_CLAIM', label: 'Flash Drop', blurb: 'Limited rewards. First qualified people win.', icon: 'clock' },
  { type: 'VERIFIED_QUEST', label: 'Verified Quest', blurb: 'Combine onchain requirements like Seeker, SKR or ORE.', icon: 'shield' },
  { type: 'GIFT', label: 'Gift', blurb: 'Send stock directly through a link or QR.', icon: 'gift' },
  { type: 'REFERRAL', label: 'Referral', blurb: 'People invite friends — both get rewarded.', icon: 'users' },
]

/** D-36: round lengths, and preset goals at about 3, 5 and 8 taps a second. */
const TAP_SECONDS = [10, 30, 60, 120] as const
const tapPresets = (seconds: number) => [
  { label: 'Easy', goal: Math.max(TAP_RUSH_LIMITS.minGoal, seconds * 3) },
  { label: 'Normal', goal: seconds * 5 },
  { label: 'Hard', goal: Math.min(TAP_RUSH_LIMITS.maxGoal, seconds * 8) },
  // The Blink default (1,000 taps) fits only the 2-minute round.
  ...(seconds * TAP_RUSH_LIMITS.maxGoalPerSecond >= TAP_RUSH_DEFAULTS.goal ? [{ label: 'Classic', goal: TAP_RUSH_DEFAULTS.goal }] : []),
]
const secondsLabel = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`)

/** D-36: round length + goal (presets or any custom number up to 1,000, never faster than 12 taps a second). */
function TapRushPicker({ goal, seconds, setGoal, setSeconds }: { goal: number; seconds: number; setGoal: (g: number) => void; setSeconds: (s: number) => void }) {
  const [custom, setCustom] = useState('')
  const max = Math.min(TAP_RUSH_LIMITS.maxGoal, seconds * TAP_RUSH_LIMITS.maxGoalPerSecond)
  const presets = tapPresets(seconds)
  return (
    <View style={{ gap: space.md }}>
      <T variant="label">Round length</T>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        {TAP_SECONDS.map((sec) => (
          <Chip
            key={sec}
            label={secondsLabel(sec)}
            onPress={() => {
              setSeconds(sec)
              setCustom('')
              setGoal(sec * 5)
            }}
            selected={seconds === sec}
          />
        ))}
      </Row>
      <T variant="label">Tap goal</T>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        {presets.map((l) => (
          <Chip
            key={l.label}
            label={`${l.label} · ${l.goal}`}
            onPress={() => {
              setCustom('')
              setGoal(l.goal)
            }}
            selected={!custom && goal === l.goal}
          />
        ))}
      </Row>
      <View style={styles.amountRow}>
        <TextInput
          inputMode="numeric"
          onChangeText={(v) => {
            const digits = v.replace(/[^0-9]/g, '').slice(0, 4)
            setCustom(digits)
            const n = Number(digits)
            if (n >= TAP_RUSH_LIMITS.minGoal && n <= max) setGoal(n)
          }}
          placeholder={`Custom goal (${TAP_RUSH_LIMITS.minGoal}–${max})`}
          placeholderTextColor={color.textMuted}
          selectionColor={color.lime}
          style={[styles.amountInput, font('bodyMedium'), { fontSize: 17 }]}
          value={custom}
        />
        <T variant="label">taps</T>
      </View>
      {custom && (Number(custom) < TAP_RUSH_LIMITS.minGoal || Number(custom) > max) ? (
        <Notice message={`Pick ${TAP_RUSH_LIMITS.minGoal}–${max} taps for a ${secondsLabel(seconds)} round (at most ${TAP_RUSH_LIMITS.maxGoalPerSecond} taps a second).`} tone="warn" />
      ) : (
        <T variant="caption">{`Players need ${goal} taps in ${secondsLabel(seconds)}.`}</T>
      )}
    </View>
  )
}

const DURATIONS = [
  { label: 'No end', hours: 0 },
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
] as const

/** Share amount → raw base units, rounded down (display multiplier aware). */
function toRaw(asset: { decimals: number; multiplier: number | null } | null, value: string): Conversion | null {
  if (!asset || !value) return null
  if (asset.multiplier === null) return { ok: false, error: 'Live data for this stock is unavailable right now.' }
  try {
    const raw = uiSharesToRawFloor(value, asset.decimals, asset.multiplier)
    if (raw <= 0n) return { ok: false, error: 'Amount is too small.' }
    return { ok: true, raw, display: rawToUiShares(raw, asset.decimals, asset.multiplier) }
  } catch {
    return { ok: false, error: 'Enter a number like 0.5' }
  }
}

/** ISO end time `hours` from now (outside the component so rendering stays pure). */
function endsAtFrom(hours: number) {
  return hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : undefined
}

function Option({ on, disabled, icon, title, body, onPress, badge }: { on: boolean; disabled?: boolean; icon: IconName; title: string; body: string; onPress?: () => void; badge?: string }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.option, on && styles.optionOn, disabled && { opacity: 0.5 }]}>
      <View style={[styles.optionIcon, on && { backgroundColor: color.lime }]}>
        <Icon name={icon} size={22} stroke={on ? color.onLime : color.lime} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="bodyStrong">{title}</T>
        <T variant="label">{body}</T>
      </View>
      {badge ? <Badge label={badge} tone="neutral" /> : <View style={[styles.radio, on && { borderColor: color.lime }]}>{on ? <View style={styles.radioDot} /> : null}</View>}
    </Pressable>
  )
}

/** D-40: post the drop in one of your clubs (optional). Shown in Limits, and in Eligibility for "club members only". */
function ClubPicker({
  clubId,
  setClubId,
  membersOnly,
  setMembersOnly,
}: {
  clubId: string | null
  setClubId: (id: string | null) => void
  membersOnly: boolean
  setMembersOnly: (v: boolean) => void
}) {
  const clubs = useMyClubs()
  const mine = clubs.data?.clubs ?? []
  return (
    <View style={{ gap: space.sm }}>
      <T variant="overline">Post in a club (optional)</T>
      {mine.length === 0 ? (
        <T variant="caption">Join or start a club to post drops in it.</T>
      ) : (
        <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
          <Chip label="No club" onPress={() => setClubId(null)} selected={!clubId} />
          {mine.map((c) => (
            <Chip icon="users" key={c.id} label={c.name} onPress={() => setClubId(c.id)} selected={clubId === c.id} />
          ))}
        </Row>
      )}
      {clubId ? (
        <>
          <T variant="overline">Who can take part</T>
          <Row gap={space.sm}>
            <Chip label="Everyone" onPress={() => setMembersOnly(false)} selected={!membersOnly} />
            <Chip icon="lock" label="Club members only" onPress={() => setMembersOnly(true)} selected={membersOnly} />
          </Row>
          <T variant="caption">{membersOnly ? 'Only members of this club can play, check in or claim. Other requirements still apply.' : 'Anyone can take part; it still shows in the club.'}</T>
        </>
      ) : null}
    </View>
  )
}

export default function Create() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { getAccessToken } = usePrivy()
  const me = useMe()
  const assets = useAssets()
  const holdings = useHoldings()
  const params = useLocalSearchParams<{ clubId?: string }>()
  const [clubId, setClubId] = useState<string | null>(typeof params.clubId === 'string' && /^[0-9a-f-]{36}$/.test(params.clubId) ? params.clubId : null)
  // D-41: club members only, for any drop type. D-40: an event check-in (action).
  const [membersOnly, setMembersOnly] = useState(Boolean(clubId))
  const [questCheckin, setQuestCheckin] = useState(false)

  const [stepIndex, setStepIndex] = useState(0)
  const [type, setType] = useState<CampaignType>('TAP_RUSH')
  const [mint, setMint] = useState<string | null>(null)
  const [shares, setShares] = useState('')
  const [perPerson, setPerPerson] = useState('')
  const [tapGoal, setTapGoal] = useState<number>(TAP_RUSH_DEFAULTS.goal)
  const [tapSeconds, setTapSeconds] = useState<number>(TAP_RUSH_DEFAULTS.seconds)
  const [hours, setHours] = useState(0)
  // Verified Quest building blocks.
  const [seeker, setSeeker] = useState(false)
  const [skrRule, setSkrRule] = useState<TokenRule>('off')
  const [skrMin, setSkrMin] = useState('')
  const [oreRule, setOreRule] = useState<TokenRule>('off')
  const [oreMin, setOreMin] = useState('')
  // D-33: an action — mine ORE after the campaign starts (the server records the start round).
  const [questOre, setQuestOre] = useState(false)
  // D-39: post on X with a personal code (+ optional required text).
  const [questX, setQuestX] = useState(false)
  const [xText, setXText] = useState('')
  const [questTap, setQuestTap] = useState(true)

  const isQuest = type === 'VERIFIED_QUEST'
  const steps: StepId[] = isQuest ? ['experience', 'eligibility', 'action', 'reward', 'limits', 'review'] : ['experience', 'reward', 'limits', 'review']
  const step = steps[Math.min(stepIndex, steps.length - 1)]!
  const hasTapRush = type === 'TAP_RUSH' || (isQuest && questTap)

  const creatorWallet = me.data?.verifiedCreatorWallets[0]
  const selected = assets.data?.xstocks.find((x) => x.mint === mint) ?? null

  const heldRaw = useMemo(() => {
    if (!selected || !creatorWallet || !holdings.data?.available) return null
    const b = holdings.data.wallets.find((w) => w.wallet === creatorWallet)?.balances?.[selected.mint]
    return b === undefined ? null : BigInt(b)
  }, [selected, creatorWallet, holdings.data])

  const heldFor = (assetMint: string) => {
    const b = holdings.data?.wallets.find((w) => w.wallet === creatorWallet)?.balances?.[assetMint]
    const a = assets.data?.xstocks.find((x) => x.mint === assetMint)
    return b && a?.multiplier != null ? rawToUiShares(BigInt(b), a.decimals, a.multiplier) : null
  }

  const conversion = useMemo(() => toRaw(selected, shares), [selected, shares])
  const reward = useMemo(() => toRaw(selected, perPerson), [selected, perPerson])
  const people = conversion?.ok && reward?.ok ? maxClaims(conversion.raw, reward.raw) : null
  const rewardError =
    reward && !reward.ok ? reward.error : conversion?.ok && reward?.ok && reward.raw > conversion.raw ? 'Each person can’t get more than the total.' : null
  const overHoldings = conversion?.ok && heldRaw !== null && conversion.raw > heldRaw

  // Requirements built from the simple choices (amounts converted with bigint, never floats).
  const quest = useMemo((): { ok: true; requirements: QuestRequirements } | { ok: false; error: string } => {
    const toMin = (v: string, token: 'SKR' | 'ORE') => {
      const decimals = VERIFIERS[token === 'SKR' ? 'SKR_BALANCE' : 'ORE_BALANCE'].amount!.decimals
      const raw = parseAmountToRaw(v, decimals)
      if (raw <= 0n) throw new Error(`enter a ${token} minimum above zero`)
      return raw.toString()
    }
    try {
      const eligibility: QuestGroup[] = []
      if (seeker) eligibility.push({ mode: 'ALL', conditions: [{ verifier: 'SEEKER_SGT' }] })
      const skr = skrRule === 'off' ? null : tokenGroup('SKR', skrRule, toMin(skrMin, 'SKR'))
      const ore = oreRule === 'off' ? null : tokenGroup('ORE', oreRule, toMin(oreMin, 'ORE'))
      if (skr) eligibility.push(skr)
      if (ore) eligibility.push(ore)
      const actions: QuestGroup[] = questTap ? [{ mode: 'ALL', conditions: [{ verifier: 'TAP_RUSH' }] }] : []
      if (questOre) actions.push({ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY' }] })
      if (questCheckin) actions.push({ mode: 'ALL', conditions: [{ verifier: 'QR_CHECKIN' }] })
      if (questX) {
        const must = xText.trim()
        if (must && (must.length < 2 || must.length > 60)) throw new Error('required X text must be 2–60 characters')
        actions.push({ mode: 'ALL', conditions: [{ verifier: 'X_QUEST', ...(must ? { mustInclude: must } : {}) }] })
      }
      if (!eligibility.length && !actions.length) return { ok: false, error: 'Add at least one requirement or action.' }
      return { ok: true, requirements: { eligibility, actions } }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Check the minimums.' }
    }
  }, [seeker, skrRule, skrMin, oreRule, oreMin, questTap, questOre, questX, xText, questCheckin])

  const create = useMutation({
    mutationFn: async () => {
      if (!selected || !conversion?.ok || !reward?.ok) throw new Error('Complete the form first')
      if (isQuest && !quest.ok) throw new Error(quest.error)
      return api.createCampaign(
        getAccessToken,
        {
          type,
          mint: selected.mint,
          allowanceRaw: conversion.raw.toString(),
          rewardPerClaimRaw: reward.raw.toString(),
          tapRush: hasTapRush ? { goal: tapGoal, seconds: tapSeconds } : undefined,
          requirements: isQuest && quest.ok ? quest.requirements : undefined,
          endsAt: endsAtFrom(hours),
          clubId: clubId ?? undefined,
          membersOnly: clubId ? membersOnly : undefined,
        },
        creatorWallet,
      )
    },
    onSuccess: ({ campaign }) => {
      haptics.success()
      void queryClient.invalidateQueries({ queryKey: ['my-campaigns'] })
      setStepIndex(0)
      setShares('')
      setPerPerson('')
      router.push(`/campaign/${campaign.id}`)
    },
    onError: () => haptics.error(),
  })

  function fillFraction(f: number) {
    if (heldRaw === null || !selected || selected.multiplier == null) return
    const raw = (heldRaw * BigInt(Math.round(f * 100))) / 100n
    setShares(rawToUiShares(raw, selected.decimals, selected.multiplier, 8))
  }

  if (me.isPending) {
    return (
      <Screen tabBar>
        <Skeleton height={34} width={200} />
        <Skeleton height={220} radius={20} />
      </Screen>
    )
  }

  if (!creatorWallet) {
    return (
      <Screen tabBar>
        <View style={{ gap: space.sm }}>
          <T variant="overline">Create</T>
          <T variant="display">Give away stock</T>
        </View>
        <EmptyState
          action="Connect my Solana wallet"
          body="Campaign stock comes from your own wallet, so connect it first. It’s added to this account — you stay signed in."
          icon="wallet"
          onAction={() => router.push('/login/wallet')}
          title="Creators use their own wallet"
        />
      </Screen>
    )
  }

  const canNext =
    (step === 'experience' && Boolean(type)) ||
    step === 'eligibility' ||
    (step === 'action' && quest.ok) ||
    (step === 'reward' && Boolean(selected) && !selected?.paused && Boolean(conversion?.ok) && Boolean(reward?.ok) && !rewardError && (people ?? 0n) > 0n) ||
    step === 'limits'

  // Plain-English summary for the review step (update §11 step 6).
  const conditions: QuestCondition[] = isQuest && quest.ok ? quest.requirements.eligibility.flatMap((g) => g.conditions) : []
  const audience = clubId && membersOnly ? 'Club members' : 'People'
  const who = conditions.length ? `${audience} who ${conditions.map((c) => describeCondition(c).replace(/^\w/, (m) => m.toLowerCase())).join(' and ')}` : clubId && membersOnly ? 'Club members' : 'Anyone'
  const doWhat = `${hasTapRush ? ` and win Tap Rush (${tapGoal} taps in ${secondsLabel(tapSeconds)})` : ''}${isQuest && questOre ? ' and mine ORE after it starts' : ''}${isQuest && questX ? ' and post on X with their code' : ''}${isQuest && questCheckin ? ' and check in at your event' : ''}`
  const sentence =
    selected && reward?.ok && people !== null
      ? `${who}${doWhat} can receive ${reward.display} ${selected.symbol} each. Up to ${people.toString()} ${people === 1n ? 'winner' : 'winners'}${
          hours ? `, for ${DURATIONS.find((d) => d.hours === hours)?.label}` : ''
        }.`
      : ''

  return (
    <Screen tabBar>
      <View style={{ gap: space.sm }}>
        <T variant="overline">New campaign</T>
        <T variant="display">{STEP_TITLE[step]}</T>
      </View>
      <View style={{ gap: space.md }}>
        <Row gap={6}>
          {steps.map((s, i) => (
            <View key={s} style={[styles.progress, { backgroundColor: i <= stepIndex ? color.lime : color.surface3 }]} />
          ))}
        </Row>
        <T variant="caption">{`Step ${stepIndex + 1} of ${steps.length + 1} · then fund & launch`}</T>
      </View>

      {step === 'experience' ? (
        <View style={{ gap: space.md }}>
          {EXPERIENCES.map((e) => (
            <Option
              body={e.blurb}
              icon={e.icon}
              key={e.type}
              on={type === e.type}
              onPress={() => {
                haptics.tap()
                setType(e.type)
              }}
              title={e.label}
            />
          ))}
          {/* D-40: a QR Event is a Verified Quest whose action is checking in with your event QR. */}
          <Option
            body="Reward people at a physical event: they scan your QR to check in."
            icon="scan"
            on={isQuest && questCheckin && !questTap}
            onPress={() => {
              haptics.tap()
              setType('VERIFIED_QUEST')
              setQuestCheckin(true)
              setQuestTap(false)
            }}
            title="QR Event"
          />
          <T variant="caption">Squads are built into every Tap Rush drop: up to 4 friends team up for a combined goal.</T>
        </View>
      ) : null}

      {step === 'eligibility' ? (
        <View style={{ gap: space.md }}>
          <T variant="label">Leave everything off to let everyone join. Each requirement you add must be met.</T>
          <Option
            body="Owns a Solana Seeker, proven by its Seeker Genesis Token."
            icon="phone"
            on={seeker}
            onPress={() => {
              haptics.tap()
              setSeeker((v) => !v)
            }}
            title="Verified Seeker"
          />
          <TokenRuleCard min={skrMin} rule={skrRule} setMin={setSkrMin} setRule={setSkrRule} token="SKR" />
          <TokenRuleCard min={oreMin} rule={oreRule} setMin={setOreMin} setRule={setOreRule} token="ORE" />
          <T variant="caption">To keep a drop to one club’s members, pick the club in Limits.</T>
          <T variant="caption">Checked onchain right before a reward is reserved. Blink never locks anyone’s tokens.</T>
        </View>
      ) : null}

      {step === 'action' ? (
        <View style={{ gap: space.md }}>
          <Option
            body="Hit a tap goal you choose, in a round from 10 seconds to 2 minutes."
            icon="target"
            on={questTap}
            onPress={() => {
              haptics.tap()
              setQuestTap((v) => !v)
            }}
            title="Tap Rush"
          />
          {questTap ? <TapRushPicker goal={tapGoal} seconds={tapSeconds} setGoal={setTapGoal} setSeconds={setTapSeconds} /> : null}
          <Option
            body="Mine ORE after the campaign starts. Earlier mining doesn’t count."
            icon="layers"
            on={questOre}
            onPress={() => {
              haptics.tap()
              setQuestOre((v) => !v)
            }}
            title="ORE mining"
          />
          <Option
            body="People scan your event QR in Blink to check in, once each. No location is collected."
            icon="scan"
            on={questCheckin}
            onPress={() => {
              haptics.tap()
              setQuestCheckin((v) => !v)
            }}
            title="Event check-in"
          />
          <Option
            body="Post on X with a personal Blink code. People paste their post link; Blink checks the public post. No X login."
            icon="share"
            on={questX}
            onPress={() => {
              haptics.tap()
              setQuestX((v) => !v)
            }}
            title="Post on X"
          />
          {questX ? (
            <View style={styles.amountRow}>
              <TextInput
                autoCapitalize="none"
                maxLength={60}
                onChangeText={setXText}
                placeholder="Required text (optional), e.g. #Blink or @yourbrand"
                placeholderTextColor={color.textMuted}
                selectionColor={color.lime}
                style={[styles.amountInput, font('body'), { fontSize: 15 }]}
                value={xText}
              />
            </View>
          ) : null}
          {!quest.ok ? <Notice message={quest.error} /> : null}
        </View>
      ) : null}

      {step === 'reward' ? (
        <View style={{ gap: space.md }}>
          {(assets.data?.xstocks ?? []).map((x) => {
            const on = mint === x.mint
            const held = heldFor(x.mint)
            return (
              <Pressable
                key={x.mint}
                onPress={() => {
                  haptics.tap()
                  setMint(x.mint)
                }}
                style={[styles.option, on && styles.optionOn]}
              >
                <StockAvatar isTest={x.isTest} logo={x.logo} size={44} symbol={x.symbol} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Row gap={6}>
                    <T variant="bodyStrong">{x.symbol}</T>
                    {x.paused ? <Badge label="Paused" tone="danger" /> : null}
                  </Row>
                  <T variant="label" numberOfLines={1}>
                    {x.name}
                  </T>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <T variant="caption">You hold</T>
                  <T variant="numeric" color={held && held !== '0' ? color.text : color.textMuted}>
                    {held ?? '0'}
                  </T>
                </View>
              </Pressable>
            )
          })}
          {selected ? (
            <>
              <Card style={{ gap: space.md }}>
                <T variant="heading">Total pool</T>
                <View style={styles.amountWrap}>
                  <TextInput
                    inputMode="decimal"
                    onChangeText={(v) => setShares(v.replace(',', '.'))}
                    placeholder="0.00"
                    placeholderTextColor={color.textMuted}
                    selectionColor={color.lime}
                    style={[styles.amountInput, font('display')]}
                    value={shares}
                  />
                  <T variant="title" color={color.textDim}>
                    {selected.symbol}
                  </T>
                </View>
                {heldRaw !== null ? (
                  <Row gap={space.sm}>
                    <Chip label="25%" onPress={() => fillFraction(0.25)} selected={false} />
                    <Chip label="50%" onPress={() => fillFraction(0.5)} selected={false} />
                    <Chip label="Max" onPress={() => fillFraction(1)} selected={false} />
                  </Row>
                ) : null}
                <T variant="caption">{`Wallet ${shortAddress(creatorWallet)} holds ${heldFor(selected.mint) ?? '0'} ${selected.symbol}`}</T>
                {conversion && !conversion.ok ? <Notice message={conversion.error} /> : null}
                {overHoldings ? <Notice message="That’s more than your wallet holds. You can save a draft, but you’ll need enough stock to fund it." tone="warn" /> : null}
              </Card>
              <Card style={{ gap: space.md }}>
                <T variant="heading">Each winner gets</T>
                <View style={styles.amountWrap}>
                  <TextInput
                    inputMode="decimal"
                    onChangeText={(v) => setPerPerson(v.replace(',', '.'))}
                    placeholder="0.00"
                    placeholderTextColor={color.textMuted}
                    selectionColor={color.lime}
                    style={[styles.amountInput, font('display'), { fontSize: 34 }]}
                    value={perPerson}
                  />
                  <T variant="heading" color={color.textDim}>
                    {selected.symbol}
                  </T>
                </View>
                {people !== null && !rewardError ? (
                  <T variant="label" color={color.text}>{`Enough for ${people.toString()} ${people === 1n ? 'winner' : 'winners'}.`}</T>
                ) : null}
                <Notice message={rewardError} />
              </Card>
            </>
          ) : null}
        </View>
      ) : null}

      {step === 'limits' ? (
        <View style={{ gap: space.md }}>
          <Card style={{ gap: space.md }}>
            <T variant="heading">How long does it run?</T>
            <T variant="label">It starts when you fund it. Unclaimed stock stays in your campaign account.</T>
            <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
              {DURATIONS.map((d) => (
                <Chip key={d.label} label={d.label} onPress={() => setHours(d.hours)} selected={hours === d.hours} />
              ))}
            </Row>
          </Card>
          <Card style={{ gap: space.md }}>
            <ClubPicker clubId={clubId} membersOnly={membersOnly} setClubId={setClubId} setMembersOnly={setMembersOnly} />
          </Card>
          {type === 'TAP_RUSH' ? (
            <Card style={{ gap: space.md }}>
              <T variant="heading">Tap Rush round</T>
              <TapRushPicker goal={tapGoal} seconds={tapSeconds} setGoal={setTapGoal} setSeconds={setTapSeconds} />
            </Card>
          ) : null}
          <Card style={{ gap: space.sm }}>
            <T variant="heading">Maximum winners</T>
            <T variant="label" color={color.text}>{people !== null ? `${people.toString()}, set by your pool and amount per winner.` : 'Set a reward first.'}</T>
          </Card>
        </View>
      ) : null}

      {step === 'review' && selected && conversion?.ok && reward?.ok ? (
        <Card style={{ gap: space.lg }}>
          <Row>
            <StockAvatar isTest={selected.isTest} logo={selected.logo} size={48} symbol={selected.symbol} />
            <View style={{ flex: 1 }}>
              <T variant="title">{CAMPAIGN_TYPE_LABEL[type]}</T>
              <T variant="label">{CAMPAIGN_TYPE_BLURB[type]}</T>
            </View>
            <Icon name={CAMPAIGN_TYPE_ICON[type]} size={22} stroke={color.lime} />
          </Row>
          <T variant="heading">{sentence}</T>
          <View style={{ gap: space.md }}>
            {[
              ['Maximum you can pay out', `${conversion.display} ${selected.symbol}`],
              ['Each winner', `${reward.display} ${selected.symbol}`],
              ['Funding wallet', shortAddress(creatorWallet)],
            ].map(([k, v]) => (
              <Row key={k} style={{ justifyContent: 'space-between' }}>
                <T variant="label">{k}</T>
                <T variant="bodyStrong" style={{ flexShrink: 1, textAlign: 'right' }}>
                  {v}
                </T>
              </Row>
            ))}
          </View>
          <Notice message={PRODUCT_COPY.treasuryStatement} tone="info" />
          <T variant="caption">{PRODUCT_COPY.issuerControlStatement}</T>
          <T variant="caption">Next you fund it from your wallet. Nothing leaves your wallet until you approve there.</T>
          <Notice message={create.error instanceof ApiError || create.error instanceof Error ? create.error.message : null} />
        </Card>
      ) : null}

      <Row gap={space.md}>
        {stepIndex > 0 ? (
          <Button icon="chevronLeft" onPress={() => setStepIndex((s) => s - 1)} style={{ flex: 1 }} variant="secondary">
            Back
          </Button>
        ) : null}
        {step !== 'review' ? (
          <Button disabled={!canNext} iconRight="arrowRight" onPress={() => setStepIndex((s) => s + 1)} style={{ flex: 2 }}>
            Continue
          </Button>
        ) : (
          <Button icon="check" loading={create.isPending} onPress={() => create.mutate()} style={{ flex: 2 }}>
            Create & fund
          </Button>
        )}
      </Row>
    </Screen>
  )
}

const styles = StyleSheet.create({
  progress: { flex: 1, height: 4, borderRadius: 2 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  optionOn: { borderColor: color.limeLine, backgroundColor: color.limeSoft },
  optionIcon: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: color.limeSoft },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.borderStrong, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.lime },
  amountWrap: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface },
  amountInput: { flex: 1, fontSize: 48, color: color.text, padding: 0 },
})

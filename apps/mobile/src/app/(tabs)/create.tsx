import { usePrivy } from '@privy-io/expo'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, TextInput, View } from 'react-native'

import { font } from '../../design/fonts'
import { Icon, type IconName } from '../../design/icons'
import { color, radius, space } from '../../design/tokens'
import { Badge, Button, Card, Chip, EmptyState, Notice, Row, Screen, Skeleton, StockAvatar, T } from '../../design/ui'
import { describeCondition } from '../../features/campaign/quest-panel'
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
  uiSharesToRawFloor,
  VERIFIERS,
} from '../../shared'

type Conversion = { ok: true; raw: bigint; display: string } | { ok: false; error: string }
type StepId = 'experience' | 'eligibility' | 'action' | 'reward' | 'limits' | 'review'
type TokenRule = 'off' | 'hold' | 'stake' | 'either' | 'total'

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
const COMING_SOON = [
  { label: 'QR Event', blurb: 'Reward people at a physical event.', icon: 'scan' as IconName },
  { label: 'Squad', blurb: 'Friends complete a challenge together.', icon: 'users' as IconName },
]

const TAP_LEVELS = [
  { label: 'Easy', goal: 30 },
  { label: 'Normal', goal: TAP_RUSH_DEFAULTS.goal },
  { label: 'Hard', goal: 80 },
] as const

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

/** One token rule → one requirement group ("either" becomes an ANY group). */
function tokenGroup(token: 'SKR' | 'ORE', rule: TokenRule, minRaw: string): QuestGroup | null {
  const held = token === 'SKR' ? 'SKR_BALANCE' : 'ORE_BALANCE'
  const staked = token === 'SKR' ? 'SKR_STAKED' : 'ORE_STAKED'
  if (rule === 'off') return null
  if (rule === 'hold') return { mode: 'ALL', conditions: [{ verifier: held, minRaw }] }
  if (rule === 'stake') return { mode: 'ALL', conditions: [{ verifier: staked, minRaw }] }
  if (rule === 'total' && token === 'SKR') return { mode: 'ALL', conditions: [{ verifier: 'SKR_TOTAL', minRaw }] }
  return { mode: 'ANY', conditions: [{ verifier: held, minRaw }, { verifier: staked, minRaw }] }
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

function TokenRuleCard({ token, rule, setRule, min, setMin }: { token: 'SKR' | 'ORE'; rule: TokenRule; setRule: (r: TokenRule) => void; min: string; setMin: (v: string) => void }) {
  const rules: [TokenRule, string][] =
    token === 'SKR'
      ? [['off', 'Off'], ['hold', 'Holds'], ['stake', 'Stakes'], ['either', 'Holds or stakes'], ['total', 'Held + staked']]
      : [['off', 'Off'], ['hold', 'Holds'], ['stake', 'Stakes'], ['either', 'Holds or stakes']]
  return (
    <Card style={{ gap: space.md }}>
      <Row>
        <Icon name="layers" size={18} stroke={color.violet} />
        <T variant="heading">{`${token} holders & stakers`}</T>
      </Row>
      <Row gap={space.sm} style={{ flexWrap: 'wrap' }}>
        {rules.map(([r, label]) => (
          <Chip key={r} label={label} onPress={() => setRule(r)} selected={rule === r} />
        ))}
      </Row>
      {rule !== 'off' ? (
        <View style={styles.amountWrap}>
          <TextInput
            inputMode="decimal"
            onChangeText={(v) => setMin(v.replace(',', '.'))}
            placeholder="Minimum"
            placeholderTextColor={color.textMuted}
            selectionColor={color.lime}
            style={[styles.amountInput, font('display'), { fontSize: 30 }]}
            value={min}
          />
          <T variant="heading" color={color.textDim}>
            {token}
          </T>
        </View>
      ) : null}
    </Card>
  )
}

export default function Create() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { getAccessToken } = usePrivy()
  const me = useMe()
  const assets = useAssets()
  const holdings = useHoldings()

  const [stepIndex, setStepIndex] = useState(0)
  const [type, setType] = useState<CampaignType>('TAP_RUSH')
  const [mint, setMint] = useState<string | null>(null)
  const [shares, setShares] = useState('')
  const [perPerson, setPerPerson] = useState('')
  const [tapGoal, setTapGoal] = useState<number>(TAP_RUSH_DEFAULTS.goal)
  const [hours, setHours] = useState(0)
  // Verified Quest building blocks.
  const [seeker, setSeeker] = useState(false)
  const [skrRule, setSkrRule] = useState<TokenRule>('off')
  const [skrMin, setSkrMin] = useState('')
  const [oreRule, setOreRule] = useState<TokenRule>('off')
  const [oreMin, setOreMin] = useState('')
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
      if (!eligibility.length && !actions.length) return { ok: false, error: 'Add at least one requirement or action.' }
      return { ok: true, requirements: { eligibility, actions } }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Check the minimums.' }
    }
  }, [seeker, skrRule, skrMin, oreRule, oreMin, questTap])

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
          tapRush: hasTapRush ? { goal: tapGoal, seconds: TAP_RUSH_DEFAULTS.seconds } : undefined,
          requirements: isQuest && quest.ok ? quest.requirements : undefined,
          endsAt: endsAtFrom(hours),
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
  const who = conditions.length ? `People who ${conditions.map((c) => describeCondition(c).replace(/^\w/, (m) => m.toLowerCase())).join(' and ')}` : 'Anyone'
  const doWhat = hasTapRush ? ` and win Tap Rush (${tapGoal} taps in ${TAP_RUSH_DEFAULTS.seconds}s)` : ''
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
          {COMING_SOON.map((e) => (
            <Option badge="Soon" body={e.blurb} disabled icon={e.icon} key={e.label} on={false} title={e.label} />
          ))}
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
          <T variant="caption">Checked onchain right before a reward is reserved. Blink never locks anyone’s tokens.</T>
        </View>
      ) : null}

      {step === 'action' ? (
        <View style={{ gap: space.md }}>
          <Option
            body="Hit the tap goal in a 10-second round."
            icon="target"
            on={questTap}
            onPress={() => {
              haptics.tap()
              setQuestTap((v) => !v)
            }}
            title="Tap Rush"
          />
          {questTap ? (
            <Row gap={space.sm}>
              {TAP_LEVELS.map((l) => (
                <Chip key={l.label} label={`${l.label} · ${l.goal}`} onPress={() => setTapGoal(l.goal)} selected={tapGoal === l.goal} />
              ))}
            </Row>
          ) : null}
          <Option badge="Soon" body="Verified ORE mining during the campaign." disabled icon="layers" on={false} title="ORE activity" />
          <Option badge="Soon" body="Scan a code at your event." disabled icon="scan" on={false} title="QR check-in" />
          <Option badge="Unavailable" body="Paused pending X platform policy review." disabled icon="share" on={false} title="X / Twitter" />
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
          {type === 'TAP_RUSH' ? (
            <Card style={{ gap: space.md }}>
              <T variant="heading">Tap goal</T>
              <T variant="label">{`Players must tap this many times in ${TAP_RUSH_DEFAULTS.seconds} seconds.`}</T>
              <Row gap={space.sm}>
                {TAP_LEVELS.map((l) => (
                  <Chip key={l.label} label={`${l.label} · ${l.goal}`} onPress={() => setTapGoal(l.goal)} selected={tapGoal === l.goal} />
                ))}
              </Row>
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
  amountInput: { flex: 1, fontSize: 48, color: color.text, padding: 0 },
})

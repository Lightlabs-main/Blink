/**
 * Shared domain model (owner: Claude). Contract changes must be recorded in docs/HANDOFF.md before Codex depends
 * on them (MASTER_PROMPT §4). Claim / Tap Rush / payout rules are owner-approved ASSUMPTIONS (DECISIONS D-13)
 * until the missing MASTER_PROMPT sections arrive.
 */

/** MASTER_PROMPT §0 — V1 campaign mechanics. Future (not V1): ORE Action, Market Challenge. */
/** EARLY_CLAIM is presented as "Flash Drop" (D-18); stored values stay backward compatible. */
export const CAMPAIGN_TYPES = ['GIFT', 'TAP_RUSH', 'EARLY_CLAIM', 'REFERRAL', 'SEEKER', 'VERIFIED_QUEST'] as const
export type CampaignType = (typeof CAMPAIGN_TYPES)[number]

/**
 * Campaign lifecycle following the delegated-treasury flow (MASTER_PROMPT §9 and §2 hero flow):
 * create → fund auxiliary account → approve exact allowance → LIVE → (paused if funding/delegation invalid) → closed.
 */
export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'AWAITING_FUNDING',
  'AWAITING_DELEGATION',
  'LIVE',
  'PAUSED',
  'ENDED',
  'CLOSED',
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

const TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ['AWAITING_FUNDING', 'CLOSED'],
  AWAITING_FUNDING: ['AWAITING_DELEGATION', 'CLOSED'],
  AWAITING_DELEGATION: ['LIVE', 'AWAITING_FUNDING', 'CLOSED'],
  LIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['LIVE', 'ENDED'],
  ENDED: ['CLOSED'],
  CLOSED: [],
}

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** MASTER_PROMPT §9: reasons Blink pauses a campaign automatically. */
export const PAUSE_REASONS = [
  'DELEGATION_REVOKED',
  'DELEGATE_CHANGED',
  'ALLOWANCE_EXHAUSTED',
  'INSUFFICIENT_BALANCE',
  'ACCOUNT_FROZEN',
  'MINT_STATE_CHANGED',
  'BUDGET_EXHAUSTED',
  'OWNER_PAUSED',
] as const
export type PauseReason = (typeof PAUSE_REASONS)[number]

/** MASTER_PROMPT §22. */
export type SolanaCluster = 'localnet' | 'devnet' | 'mainnet-beta'

/** Amounts cross the API as decimal strings of raw base units — never JS numbers. */
export type RawAmount = string

export interface CampaignSummary {
  id: string
  type: CampaignType
  status: CampaignStatus
  cluster: SolanaCluster
  creatorWallet: string
  mint: string
  xstockSymbol: string
  /** Deterministic CreateAccountWithSeed seed (MASTER_PROMPT §11). */
  campaignSeed: string
  /** Server-derived auxiliary Token-2022 account; never client-supplied. */
  campaignTokenAccount: string
  /** Delegate public key Blink uses for this campaign only (MASTER_PROMPT §14). Null until provisioned. */
  delegateAddress: string | null
  allowanceRaw: RawAmount
  /** Fixed amount each recipient receives (D-13). Null for campaigns created before claiming existed. */
  rewardPerClaimRaw: RawAmount | null
  /** Reserved + paid so far; never above allowanceRaw. */
  claimedRaw: RawAmount
  /** Tap Rush rules; null for other mechanics. */
  tapRush: TapRushRules | null
  /** Why Blink paused the drop (a PauseReason); null unless PAUSED. */
  pauseReason: string | null
  /** D-21: Verified Quest requirements, frozen at creation (null for other mechanics). */
  requirements: QuestRequirements | null
  /** D-21: optional campaign window (ISO), enforced server-side. */
  startsAt: string | null
  endsAt: string | null
  /** D-40: the club this drop belongs to, if any. */
  clubId: string | null
  /** D-41: only members of that club can take part (any mechanic). */
  membersOnly: boolean
  createdAt: string
}

/** Mechanics recipients can claim (D-13, D-14, D-17, D-21). */
export const CLAIMABLE_TYPES = ['GIFT', 'EARLY_CLAIM', 'TAP_RUSH', 'REFERRAL', 'SEEKER', 'VERIFIED_QUEST'] as const satisfies readonly CampaignType[]

export function isClaimableType(type: CampaignType): boolean {
  return (CLAIMABLE_TYPES as readonly CampaignType[]).includes(type)
}

/** Tap Rush: tap at least `goal` times within `seconds` to qualify for one reward. */
export interface TapRushRules {
  goal: number
  seconds: number
}

/** D-13 limits. maxTapsPerSecond rejects scripted results; humans top out well below it. */
export const TAP_RUSH_LIMITS = {
  minGoal: 10,
  /** D-36: creators can ask for up to 1,000 taps, with rounds up to 2 minutes. */
  maxGoal: 1000,
  minSeconds: 5,
  maxSeconds: 120,
  /** D-36: a goal must be winnable: at most this many taps per second on average across the round. */
  maxGoalPerSecond: 12,
  maxTapsPerSecond: 20,
  maxAttempts: 10,
  /** D-14: two taps closer than this are not a finger. */
  minTapIntervalMs: 25,
  /** D-14: coefficient of variation of tap intervals below this looks machine-timed. */
  minIntervalVariation: 0.05,
} as const

export type TapRoundVerdict = { ok: true } | { ok: false; reason: 'COUNT_MISMATCH' | 'OUT_OF_ORDER' | 'OUT_OF_ROUND' | 'TOO_FAST' | 'BURST' | 'ROBOTIC' }

/**
 * D-14: checks a Tap Rush round's tap timings (ms since the round started on the device) for human patterns.
 * Raises the bar for scripted results; a determined attacker can still synthesize human-like timings.
 */
export function assessTapRound(tapTimesMs: readonly number[], taps: number, seconds: number): TapRoundVerdict {
  if (tapTimesMs.length !== taps) return { ok: false, reason: 'COUNT_MISMATCH' }
  const roundMs = seconds * 1000
  for (let i = 0; i < tapTimesMs.length; i++) {
    const t = tapTimesMs[i]!
    if (t < 0 || t > roundMs + 300) return { ok: false, reason: 'OUT_OF_ROUND' }
    if (i > 0 && t < tapTimesMs[i - 1]!) return { ok: false, reason: 'OUT_OF_ORDER' }
  }
  const intervals: number[] = []
  for (let i = 1; i < tapTimesMs.length; i++) intervals.push(tapTimesMs[i]! - tapTimesMs[i - 1]!)
  // Two thumbs landing together can produce the odd tiny gap; only a pattern of them is rejected.
  const tooClose = intervals.filter((d) => d < TAP_RUSH_LIMITS.minTapIntervalMs).length
  if (tooClose > Math.max(1, Math.floor(intervals.length * 0.05))) return { ok: false, reason: 'TOO_FAST' }
  for (let i = 0, j = 0; i < tapTimesMs.length; i++) {
    while (tapTimesMs[i]! - tapTimesMs[j]! >= 1000) j++
    if (i - j + 1 > TAP_RUSH_LIMITS.maxTapsPerSecond) return { ok: false, reason: 'BURST' }
  }
  if (intervals.length >= 10) {
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const variance = intervals.reduce((a, d) => a + (d - mean) ** 2, 0) / intervals.length
    if (mean > 0 && Math.sqrt(variance) / mean < TAP_RUSH_LIMITS.minIntervalVariation) return { ok: false, reason: 'ROBOTIC' }
  }
  return { ok: true }
}

/** Final social update: 1,000 taps by default; at most 12 taps a second (D-36) makes that a 2-minute round. */
export const TAP_RUSH_DEFAULTS: TapRushRules = { goal: 1000, seconds: 120 }

/** How many full rewards fit in the pool. */
export function maxClaims(allowanceRaw: bigint, rewardPerClaimRaw: bigint): bigint {
  return rewardPerClaimRaw > 0n ? allowanceRaw / rewardPerClaimRaw : 0n
}

/**
 * RESERVED: amount held against the allowance, transaction not signed yet.
 * SENDING: signed and (possibly) sent; the signature is known, confirmation pending.
 * PAID: confirmed onchain. FAILED: never landed; the reservation was released and the user may retry.
 */
export const CLAIM_STATUSES = ['RESERVED', 'SENDING', 'PAID', 'FAILED'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** D-14: REFERRAL_BONUS is the referrer's reward when a friend claims through their invite code. */
export const CLAIM_KINDS = ['CLAIM', 'REFERRAL_BONUS'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

/** Referral invite codes: 8 characters from an unambiguous alphabet. */
export const REFERRAL_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/

export interface ClaimSummary {
  id: string
  campaignId: string
  kind: ClaimKind
  cluster: SolanaCluster
  mint: string
  xstockSymbol: string
  amountRaw: RawAmount
  /** The recipient's Privy embedded wallet (from Privy, never the client). */
  recipientWallet: string
  status: ClaimStatus
  txSignature: string | null
  failureReason: string | null
  createdAt: string
}

/** D-38: one line of the user's history; every line opens a receipt. */
/** CHECKIN and CLUB_JOINED (D-40) are offchain records: no amount, no transaction. */
export type HistoryKind = 'REWARD' | 'INVITE_BONUS' | 'SENT' | 'FUNDED' | 'CHECKIN' | 'CLUB_JOINED'

export interface HistoryItem {
  /** `<kind>:<source id>`, stable across refreshes. */
  id: string
  kind: HistoryKind
  cluster: SolanaCluster
  symbol: string
  /** null for SOL. */
  mint: string | null
  decimals: number
  amountRaw: RawAmount
  status: 'CONFIRMED' | 'PENDING' | 'FAILED'
  signature: string | null
  campaignId: string | null
  campaignType: CampaignType | null
  /** SENT: the recipient address. */
  counterparty: string | null
  /** CLUB_JOINED: the club's name; CHECKIN: the drop's stock symbol. */
  title?: string | null
  /** CLUB_JOINED: the club's slug, to open it. */
  clubSlug?: string | null
  at: string
}

/** The caller's invite for a REFERRAL drop and the bonus it earned (at most one per person, D-14). */
export interface ReferralSummary {
  campaignId: string
  code: string
  bonus: ClaimSummary | null
}

export interface TapRushSessionSummary {
  id: string
  campaignId: string
  goal: number
  seconds: number
  startedAt: string
  /** Attempts left for this user after this one. */
  attemptsLeft: number
}

/** Wording locked by MASTER_PROMPT §6 and §9. UI copy must use these, never "escrow" or "trustless". */
export const PRODUCT_COPY = {
  trustStatement:
    'Blink determines campaign eligibility; asset settlement is transparent and verifiable on Solana mainnet.',
  treasuryStatement:
    'Your campaign stock stays in an account you own. Blink can only distribute the amount you approve.',
  /** OQ-5 DRAFT — wording awaiting Maris's approval. Every supported xStock mint has a PermanentDelegate (the issuer). */
  issuerControlStatement:
    'xStocks are tokenized securities issued by a third party, which can freeze or move them in any wallet, as regulated issuers can.',
} as const

/* ───────────── xStocks eligibility (SECURITY.md §1, DECISIONS D-19 / D-20) ───────────── */

export type XStockRestrictionCategory = 'PROHIBITED' | 'NON_SERVICEABLE' | 'NOT_AVAILABLE' | 'CONSERVATIVE'

export interface XStockRestriction {
  /** ISO 3166-1 alpha-2. */
  code: string
  category: XStockRestrictionCategory
  /** Where the restriction comes from; ASSUMPTION entries are conservative blocks not yet seen in issuer text. */
  source: string
}

const BACKED = 'assets.backed.fi/legal-documentation/restricted-countries (VERIFIED 2026-10-01)'
const XSTOCKS = 'docs.xstocks.fi + xstocks.fi disclaimers (VERIFIED 2026-10-01)'
const UPDATE = 'Maris product update §21 — ASSUMPTION, not yet in issuer text'

/**
 * Policy XSTOCKS-ELIGIBILITY v1. Re-verify against the issuer's list before every release (SECURITY.md §1).
 * The method is Maris's decision (b): self-declared country + not-a-U.S.-person attestation, cross-checked with the
 * request's IP country (country only; no precise location stored).
 */
export const XSTOCK_POLICY = {
  id: 'XSTOCKS-ELIGIBILITY',
  version: '2026-10-02.1',
  method: 'SELF_DECLARED_PLUS_IP_COUNTRY',
  restrictions: [
    { code: 'US', category: 'PROHIBITED', source: `${BACKED}; ${XSTOCKS}` },
    { code: 'IR', category: 'PROHIBITED', source: BACKED },
    { code: 'KP', category: 'PROHIBITED', source: BACKED },
    { code: 'SY', category: 'PROHIBITED', source: BACKED },
    { code: 'GB', category: 'NOT_AVAILABLE', source: XSTOCKS },
    // NG is on the issuer's "non-serviceable" list but is allowed by owner decision D-22 (2026-10-02).
    ...['AF', 'BY', 'CF', 'CD', 'CU', 'ET', 'HT', 'IQ', 'LB', 'LY', 'ML', 'MZ', 'MM', 'NI', 'PH', 'RU', 'SO', 'SS', 'SD', 'VE', 'YE', 'ZW'].map(
      (code) => ({ code, category: 'NON_SERVICEABLE' as const, source: BACKED }),
    ),
    { code: 'CA', category: 'CONSERVATIVE', source: UPDATE },
    { code: 'AU', category: 'CONSERVATIVE', source: UPDATE },
  ] satisfies XStockRestriction[],
  /** Countries that need an extra attestation instead of a full block (issuer: "Occupied regions of Ukraine"). */
  regionAttestations: { UA: 'NOT_IN_OCCUPIED_REGION' } as Record<string, string>,
} as const

export type XStockEligibilityReason =
  | 'ELIGIBLE'
  | 'US_PERSON'
  | 'DECLARED_COUNTRY_RESTRICTED'
  | 'IP_COUNTRY_RESTRICTED'
  | 'IP_COUNTRY_UNKNOWN'
  | 'REGION_ATTESTATION_MISSING'
  | 'INVALID_COUNTRY'

export interface XStockEligibilityInput {
  declaredCountry: string
  /** "I am not a U.S. person" — must be explicitly true. */
  notUsPerson: boolean
  /** Extra attestations, e.g. NOT_IN_OCCUPIED_REGION for Ukraine. */
  attestations: string[]
  /** Country of the request IP, or null when it cannot be determined. */
  ipCountry: string | null
}

export function isRestrictedCountry(code: string): boolean {
  return XSTOCK_POLICY.restrictions.some((r) => r.code === code)
}

/** Pure decision; the server is the only caller whose result counts (SECURITY.md §2). Fails closed. */
export function evaluateXStockEligibility(input: XStockEligibilityInput): { eligible: boolean; reason: XStockEligibilityReason } {
  const declared = input.declaredCountry.toUpperCase()
  if (!/^[A-Z]{2}$/.test(declared)) return { eligible: false, reason: 'INVALID_COUNTRY' }
  if (!input.notUsPerson) return { eligible: false, reason: 'US_PERSON' }
  if (isRestrictedCountry(declared)) return { eligible: false, reason: 'DECLARED_COUNTRY_RESTRICTED' }
  const needed = XSTOCK_POLICY.regionAttestations[declared]
  if (needed && !input.attestations.includes(needed)) return { eligible: false, reason: 'REGION_ATTESTATION_MISSING' }
  if (!input.ipCountry) return { eligible: false, reason: 'IP_COUNTRY_UNKNOWN' }
  if (isRestrictedCountry(input.ipCountry.toUpperCase())) return { eligible: false, reason: 'IP_COUNTRY_RESTRICTED' }
  return { eligible: true, reason: 'ELIGIBLE' }
}

/** What the user sees about their own eligibility (never public). */
export interface XStockEligibilitySummary {
  policyId: string
  policyVersion: string
  /** False when the stored decision was made under an older policy version: the user must confirm again. */
  current: boolean
  declaredCountry: string
  eligible: boolean
  reason: XStockEligibilityReason
  decidedAt: string
}

/* ───────────── Verified Quest: reusable verifiers (D-21, docs/VERIFIER_ARCHITECTURE.md) ───────────── */

export const VERIFIER_TYPES = [
  'SEEKER_SGT',
  'SKR_BALANCE',
  'SKR_STAKED',
  'SKR_TOTAL',
  'ORE_BALANCE',
  'ORE_STAKED',
  'ORE_ACTIVITY',
  'TAP_RUSH',
  'X_QUEST',
  'CLUB_MEMBER',
  'QR_CHECKIN',
] as const
export type VerifierType = (typeof VERIFIER_TYPES)[number]

export type VerifierKind = 'ELIGIBILITY' | 'ACTION'
/** ENABLED: usable. DISABLED: shown as "coming soon", never satisfiable. BLOCKED: policy review required. */
export type VerifierAvailability = 'ENABLED' | 'DISABLED' | 'BLOCKED'

export interface VerifierDefinition {
  type: VerifierType
  version: number
  kind: VerifierKind
  label: string
  /** Creator-facing explanation; {min} is replaced with the configured minimum. */
  describe: string
  /** Token symbol + decimals for a minimum amount; null when the verifier takes no amount. */
  amount: { symbol: 'SKR' | 'ORE'; decimals: number } | null
  source: string
  chain: 'solana:mainnet' | 'blink'
  /** Read-only checks never ask the user to sign a transaction. */
  readOnly: boolean
  availability: VerifierAvailability
}

/**
 * The allowlisted registry. Protocol addresses live server-side in @blink/solana, never in campaign config.
 * Decimals: SKR 6 and ORE 11, read from the mints onchain 2026-10-01 (DEPENDENCIES.md); the server re-reads them.
 */
export const VERIFIERS: Record<VerifierType, VerifierDefinition> = {
  SEEKER_SGT: {
    type: 'SEEKER_SGT', version: 1, kind: 'ELIGIBILITY', label: 'Verified Seeker', describe: 'Owns a Solana Seeker (Seeker Genesis Token)',
    amount: null, source: 'Solana Mobile SGT checks (D-17)', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  SKR_BALANCE: {
    type: 'SKR_BALANCE', version: 1, kind: 'ELIGIBILITY', label: 'SKR holder', describe: 'Holds at least {min} SKR',
    amount: { symbol: 'SKR', decimals: 6 }, source: 'SKR token accounts', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  SKR_STAKED: {
    type: 'SKR_STAKED', version: 1, kind: 'ELIGIBILITY', label: 'SKR staker', describe: 'Has at least {min} SKR staked',
    amount: { symbol: 'SKR', decimals: 6 }, source: 'Solana Mobile SKR staking program, all guardian pools', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  SKR_TOTAL: {
    type: 'SKR_TOTAL', version: 1, kind: 'ELIGIBILITY', label: 'SKR held + staked', describe: 'Holds and stakes at least {min} SKR in total',
    amount: { symbol: 'SKR', decimals: 6 }, source: 'SKR token accounts + staking program', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  ORE_BALANCE: {
    type: 'ORE_BALANCE', version: 1, kind: 'ELIGIBILITY', label: 'ORE holder', describe: 'Holds at least {min} ORE',
    amount: { symbol: 'ORE', decimals: 11 }, source: 'ORE token accounts', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  ORE_STAKED: {
    type: 'ORE_STAKED', version: 1, kind: 'ELIGIBILITY', label: 'ORE staker', describe: 'Has at least {min} ORE staked',
    amount: { symbol: 'ORE', decimals: 11 }, source: 'Regolith Labs ore-stake program', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  ORE_ACTIVITY: {
    type: 'ORE_ACTIVITY', version: 1, kind: 'ACTION', label: 'ORE mining', describe: 'Mines ORE after the campaign starts',
    amount: null, source: 'Regolith Labs ORE program: Miner.round_id after the round recorded at creation (D-33)', chain: 'solana:mainnet', readOnly: true, availability: 'ENABLED',
  },
  TAP_RUSH: {
    type: 'TAP_RUSH', version: 1, kind: 'ACTION', label: 'Tap Rush', describe: 'Wins a Tap Rush round',
    amount: null, source: 'Blink server-timed round (D-13, D-14)', chain: 'blink', readOnly: true, availability: 'ENABLED',
  },
  X_QUEST: {
    type: 'X_QUEST', version: 1, kind: 'ACTION', label: 'Post on X', describe: 'Posts on X with their Blink code',
    amount: null, source: 'X public oEmbed: post text contains the person’s code, posted after the campaign started (D-39)', chain: 'blink', readOnly: true, availability: 'ENABLED',
  },
  CLUB_MEMBER: {
    type: 'CLUB_MEMBER', version: 1, kind: 'ELIGIBILITY', label: 'Club member', describe: 'Is a member of the drop’s club',
    amount: null, source: 'Blink club membership (D-40); never replaces the xStocks eligibility gate', chain: 'blink', readOnly: true, availability: 'ENABLED',
  },
  QR_CHECKIN: {
    type: 'QR_CHECKIN', version: 1, kind: 'ACTION', label: 'Event check-in', describe: 'Scans the event’s Blink QR code',
    amount: null, source: 'Blink event code: random, server-issued, one check-in per person (D-40)', chain: 'blink', readOnly: true, availability: 'ENABLED',
  },
}

export interface QuestCondition {
  verifier: VerifierType
  /** Minimum in raw base units (decimal string) for amount verifiers; absent otherwise. */
  minRaw?: RawAmount
  /**
   * ORE_ACTIVITY only, set by the SERVER at creation (never by the creator): the ORE round being mined when the
   * campaign was created. Mining in a later round qualifies, so mining from before the campaign never counts.
   */
  afterRound?: RawAmount
  /** X_QUEST only (D-39): text the post must also contain, e.g. "#Blink" or "@yourbrand". Set by the creator. */
  mustInclude?: string
}

export interface QuestGroup {
  mode: 'ALL' | 'ANY'
  conditions: QuestCondition[]
}

/** Every group must pass (implicit AND); inside a group, ALL or ANY. No deeper nesting (update §6). */
export interface QuestRequirements {
  eligibility: QuestGroup[]
  actions: QuestGroup[]
}

export const QUEST_LIMITS = { maxGroups: 4, maxConditionsPerGroup: 4 } as const

export const VERIFICATION_STATUSES = ['NOT_STARTED', 'CHECKING', 'PASSED', 'FAILED', 'PENDING', 'ERROR', 'STALE'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

/** Public/mobile summary of one condition's result. Sensitive evidence stays server-side. */
export interface ConditionResult {
  verifier: VerifierType
  status: VerificationStatus
  /** Raw amounts as strings: what qualified and what was required. */
  actualRaw?: RawAmount
  requiredRaw?: RawAmount
  detail?: string
}

export interface QuestEvaluation {
  qualified: boolean
  /** Same shape as the requirements, one result per condition. */
  eligibility: { mode: 'ALL' | 'ANY'; passed: boolean; results: ConditionResult[] }[]
  actions: { mode: 'ALL' | 'ANY'; passed: boolean; results: ConditionResult[] }[]
  checkedAt: string
}

/** Pure combination; only PASSED counts. ERROR / STALE / PENDING never satisfy a condition (fail closed). */
export function combineQuest(
  requirements: QuestRequirements,
  resultFor: (c: QuestCondition) => ConditionResult,
  checkedAt: string,
): QuestEvaluation {
  const fold = (groups: QuestGroup[]) =>
    groups.map((g) => {
      const results = g.conditions.map(resultFor)
      const passed = g.mode === 'ALL' ? results.every((r) => r.status === 'PASSED') : results.some((r) => r.status === 'PASSED')
      return { mode: g.mode, passed, results }
    })
  const eligibility = fold(requirements.eligibility)
  const actions = fold(requirements.actions)
  const qualified = [...eligibility, ...actions].length > 0 && [...eligibility, ...actions].every((g) => g.passed)
  return { qualified, eligibility, actions, checkedAt }
}

/** Raw → display string without floating point (display only). */
export function formatRaw(raw: bigint, decimals: number, maxFraction = 4): string {
  const scale = pow10(decimals)
  const whole = raw / scale
  const frac = (raw % scale).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US')
}

/** "500.5" → raw bigint at `decimals`, rounding down; throws on malformed input. Display/input helper only. */
export function parseAmountToRaw(value: string, decimals: number): bigint {
  const m = value.trim().match(/^(\d+)(?:\.(\d+))?$/)
  if (!m) throw new Error('enter a number like 500 or 12.5')
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(m[1]!) * pow10(decimals) + (frac ? BigInt(frac) : 0n)
}

function pow10(n: number): bigint {
  let r = 1n
  for (let i = 0; i < n; i++) r *= 10n
  return r
}

/* ───────────── Live campaign room (D-21; polling transport, realtime-ready DTOs) ───────────── */

export const LIVE_EVENT_TYPES = [
  'PARTICIPANT_JOINED',
  'REQUIREMENT_VERIFIED',
  'PARTICIPANT_QUALIFIED',
  'PAYOUT_CONFIRMED',
  'CAMPAIGN_PAUSED',
  'CAMPAIGN_ENDED',
] as const
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number]

/** Privacy-safe public identity: a truncated wallet only. Never email, Privy id, country or compliance data. */
export interface PublicParticipant {
  /** The username when the person set one (D-37), otherwise a shortened wallet. */
  label: string
  username?: string
  /** Profile picture path on the API origin (`/v1/avatars/...`), when set. */
  avatarUrl?: string | null
}

export interface LiveEvent {
  type: LiveEventType
  who: PublicParticipant | null
  at: string
}

export interface LeaderboardEntry {
  who: PublicParticipant
  score: number
}

export interface CampaignRoom {
  campaignId: string
  status: CampaignStatus
  joined: number
  qualified: number
  rewardsRemaining: number
  endsAt: string | null
  /** Tap Rush only; null for quests without a numeric score (no artificial leaderboards). */
  leaderboard: LeaderboardEntry[] | null
  events: LiveEvent[]
  serverTime: string
}

export function publicLabel(wallet: string | null | undefined): PublicParticipant {
  return { label: wallet && wallet.length > 8 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : 'Someone' }
}

/* ───────────── D-40: clubs, chat, squads, passport (offchain; nothing here touches Solana) ───────────── */

export const CLUB_CATEGORIES = ['ASSET', 'ECOSYSTEM', 'COMMUNITY', 'THEME'] as const
export type ClubCategory = (typeof CLUB_CATEGORIES)[number]
export const CLUB_CATEGORY_LABEL: Record<ClubCategory, string> = { ASSET: 'Stock', ECOSYSTEM: 'Ecosystem', COMMUNITY: 'Community', THEME: 'Theme' }

export type ClubVisibility = 'PUBLIC' | 'PRIVATE'
export type ClubRole = 'OWNER' | 'MOD' | 'MEMBER'

export const CLUB_LIMITS = {
  nameMax: 40,
  descriptionMax: 280,
  maxTags: 5,
  messageMax: 500,
  messagePage: 30,
  /** Per user. */
  messagesPerMinute: 20,
  clubsPerDay: 3,
  squadsPerDay: 5,
  checkinsPerHour: 10,
  squadSize: 4,
  /** Distinct member reports that hide a message. */
  reportsToHide: 3,
} as const

/** The only reactions (no free-form emoji, nothing to moderate). */
export const CLUB_REACTIONS = ['🔥', '🚀', '💎', '👏', '😂'] as const
export type ClubReaction = (typeof CLUB_REACTIONS)[number]

export interface ClubSummary {
  id: string
  slug: string
  name: string
  description: string
  category: ClubCategory
  tags: string[]
  visibility: ClubVisibility
  /** Counted from memberships; never estimated. */
  memberCount: number
  /** null = run by Blink. */
  owner: PublicParticipant | null
  joined: boolean
  role: ClubRole | null
  /** D-41: who can join (all groups must pass; ALL/ANY inside a group). Empty = anyone. */
  rules: QuestGroup[]
  createdAt: string
}

/** D-41: verifiers a club can require to join: identity and holdings only (no per-drop actions). */
export const CLUB_RULE_VERIFIERS = ['SEEKER_SGT', 'SKR_BALANCE', 'SKR_STAKED', 'SKR_TOTAL', 'ORE_BALANCE', 'ORE_STAKED'] as const satisfies readonly VerifierType[]

export interface ClubDetail extends ClubSummary {
  /** Members of a private club (and its owner/mods) see the invite code. */
  inviteCode: string | null
  campaigns: CampaignSummary[]
}

export interface ChatMessage {
  /** Increasing; also the pagination cursor. */
  id: string
  author: PublicParticipant
  mine: boolean
  /** Plain text; never rendered as HTML. Empty when deleted. */
  body: string
  replyTo: { id: string; author: PublicParticipant; body: string } | null
  reactions: { emoji: ClubReaction; count: number; mine: boolean }[]
  deleted: boolean
  createdAt: string
}

/** One way to earn club points, shown with the leaderboard so every score is explainable. */
export const CLUB_POINTS = { REWARD: 10, QUALIFIED: 5, CHECKIN: 5 } as const

export interface ClubLeaderboardEntry {
  rank: number
  who: PublicParticipant
  points: number
  rewards: number
  qualified: number
  checkins: number
}

export interface SquadMemberView {
  who: PublicParticipant
  captain: boolean
  /** Best accepted Tap Rush score in this drop (server-recorded), 0 if none yet. */
  taps: number
}

export interface SquadSummary {
  id: string
  campaignId: string
  name: string
  code: string
  maxSize: number
  members: SquadMemberView[]
  /** COMBINED_TAPS: the members' best accepted rounds, summed by the server. */
  combinedTaps: number
  /** The drop's goal times the squad size. */
  target: number
  complete: boolean
  mine: boolean
}

export interface PassportBadge {
  id: string
  title: string
  detail: string
  at: string
}

export interface Passport {
  badges: PassportBadge[]
  rewards: number
  checkins: number
  clubs: number
  squadWins: number
  /** "BLK-7F3K-92QD": stable per account, derived one-way from the account id (reveals nothing). */
  number: string
  /** Earliest stamp or club join (ISO); null for a brand-new passport. */
  memberSince: string | null
  level: PassportLevel
}

/** D-42: levels by stamp count only (explainable; never by holdings). */
export const PASSPORT_LEVELS = [
  { level: 'NEWCOMER', label: 'Newcomer', min: 0 },
  { level: 'EXPLORER', label: 'Explorer', min: 1 },
  { level: 'REGULAR', label: 'Regular', min: 3 },
  { level: 'PRO', label: 'Pro', min: 6 },
  { level: 'LEGEND', label: 'Legend', min: 10 },
] as const
export type PassportLevel = (typeof PASSPORT_LEVELS)[number]['level']

export function passportLevel(stamps: number): (typeof PASSPORT_LEVELS)[number] {
  return [...PASSPORT_LEVELS].reverse().find((l) => stamps >= l.min) ?? PASSPORT_LEVELS[0]
}

/** What a Blink QR code (or link) points at. */
export type ScanTarget =
  | { kind: 'CAMPAIGN'; campaignId: string; ref?: string }
  | { kind: 'EVENT'; token: string }
  | { kind: 'CLUB'; slug: string; invite?: string }

/**
 * Shared domain model (owner: Claude). Contract changes must be recorded in docs/HANDOFF.md before Codex depends
 * on them (MASTER_PROMPT §4). Claim / Tap Rush / payout rules are owner-approved ASSUMPTIONS (DECISIONS D-13)
 * until the missing MASTER_PROMPT sections arrive.
 */

/** MASTER_PROMPT §0 — V1 campaign mechanics. Future (not V1): ORE Action, Market Challenge. */
export const CAMPAIGN_TYPES = ['GIFT', 'TAP_RUSH', 'EARLY_CLAIM', 'REFERRAL', 'SEEKER'] as const
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
  createdAt: string
}

/** Mechanics recipients can claim (D-13, D-14, D-17). */
export const CLAIMABLE_TYPES = ['GIFT', 'EARLY_CLAIM', 'TAP_RUSH', 'REFERRAL', 'SEEKER'] as const satisfies readonly CampaignType[]

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
  maxGoal: 200,
  minSeconds: 5,
  maxSeconds: 30,
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

export const TAP_RUSH_DEFAULTS: TapRushRules = { goal: 50, seconds: 10 }

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

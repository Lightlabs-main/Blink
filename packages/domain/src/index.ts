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
  createdAt: string
}

/**
 * Mechanics recipients can claim today (D-13). REFERRAL and SEEKER need rules that are not specified yet.
 */
export const CLAIMABLE_TYPES = ['GIFT', 'EARLY_CLAIM', 'TAP_RUSH'] as const satisfies readonly CampaignType[]

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
} as const

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

export interface ClaimSummary {
  id: string
  campaignId: string
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
} as const

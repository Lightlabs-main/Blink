/**
 * API contract schemas (owner: Claude). Shared by apps/api and apps/mobile.
 * Record every change in docs/HANDOFF.md before Codex depends on it.
 */
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  isClaimableType,
  QUEST_LIMITS,
  type QuestRequirements,
  REFERRAL_CODE_RE,
  TAP_RUSH_LIMITS,
  VERIFIER_TYPES,
  VERIFIERS,
} from '@blink/domain'
import { z } from 'zod'

/** Base58 Solana address shape. Format check only — onchain existence/ownership is verified server-side. */
export const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid Solana address')

/** Raw base-unit amount as a decimal string (u64 range). */
const RAW_AMOUNT_RE = /^(0|[1-9]\d{0,19})$/
const U64_MAX = 18_446_744_073_709_551_615n

// Single refine so BigInt() never runs on unvalidated input (Zod 4 keeps evaluating checks after a failure).
export const rawAmount = z
  .string()
  .refine((v) => RAW_AMOUNT_RE.test(v) && BigInt(v) <= U64_MAX, 'raw amount must be an integer string within u64')

/**
 * POST /v1/campaigns — create a DRAFT campaign.
 * Deliberately has NO creatorWallet, campaignTokenAccount or delegate fields: the creator comes from the
 * verified Privy session (SIWS-linked wallet) and all addresses are derived server-side (MASTER_PROMPT §11, §25).
 */
const positiveRawAmount = (message: string) => rawAmount.refine((v) => RAW_AMOUNT_RE.test(v) && BigInt(v) > 0n, message)

export const tapRushRules = z
  .object({
    goal: z.number().int().min(TAP_RUSH_LIMITS.minGoal).max(TAP_RUSH_LIMITS.maxGoal),
    seconds: z.number().int().min(TAP_RUSH_LIMITS.minSeconds).max(TAP_RUSH_LIMITS.maxSeconds),
  })
  .strict()

/** D-21: one requirement. Only ENABLED registry verifiers; amount verifiers need a positive raw minimum. */
const questCondition = z
  .object({ verifier: z.enum(VERIFIER_TYPES), minRaw: rawAmount.optional() })
  .strict()
  .superRefine((c, ctx) => {
    const def = VERIFIERS[c.verifier]
    if (def.availability !== 'ENABLED') ctx.addIssue({ code: 'custom', message: `${def.label} is not available yet` })
    if (def.amount && !(c.minRaw && RAW_AMOUNT_RE.test(c.minRaw) && BigInt(c.minRaw) > 0n)) {
      ctx.addIssue({ code: 'custom', path: ['minRaw'], message: `${def.label} needs a minimum amount` })
    }
    if (!def.amount && c.minRaw !== undefined) ctx.addIssue({ code: 'custom', path: ['minRaw'], message: `${def.label} takes no amount` })
  })

const questGroup = z
  .object({ mode: z.enum(['ALL', 'ANY']), conditions: z.array(questCondition).min(1).max(QUEST_LIMITS.maxConditionsPerGroup) })
  .strict()

/** D-21: groups of ALL/ANY conditions; every group must pass. Eligibility and action verifiers stay in their place. */
export const questRequirements = z
  .object({
    eligibility: z.array(questGroup).max(QUEST_LIMITS.maxGroups),
    actions: z.array(questGroup).max(QUEST_LIMITS.maxGroups),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.eligibility.length + r.actions.length === 0) ctx.addIssue({ code: 'custom', message: 'add at least one requirement' })
    for (const [side, kind] of [['eligibility', 'ELIGIBILITY'], ['actions', 'ACTION']] as const) {
      for (const g of r[side]) {
        for (const c of g.conditions) {
          if (VERIFIERS[c.verifier].kind !== kind) ctx.addIssue({ code: 'custom', path: [side], message: `${VERIFIERS[c.verifier].label} does not belong in ${side}` })
        }
      }
    }
  })

export function questHasTapRush(r: QuestRequirements): boolean {
  return r.actions.some((g) => g.conditions.some((c) => c.verifier === 'TAP_RUSH'))
}

/**
 * Claimable mechanics (DECISIONS D-13) require `rewardPerClaimRaw`: the fixed amount each recipient gets.
 * `tapRush` is only accepted for TAP_RUSH; the server applies defaults when it is omitted.
 */
export const createCampaignRequest = z
  .object({
    type: z.enum(CAMPAIGN_TYPES),
    mint: solanaAddress,
    allowanceRaw: positiveRawAmount('allowance must be positive'),
    rewardPerClaimRaw: positiveRawAmount('amount per person must be positive').optional(),
    tapRush: tapRushRules.optional(),
    /** D-21: required for VERIFIED_QUEST, refused otherwise. Frozen at creation. */
    requirements: questRequirements.optional(),
    /** D-21: optional campaign window. */
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (isClaimableType(v.type) && v.rewardPerClaimRaw === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rewardPerClaimRaw'], message: 'amount per person is required' })
    }
    const digits = (s: string | undefined) => s !== undefined && RAW_AMOUNT_RE.test(s)
    if (digits(v.rewardPerClaimRaw) && digits(v.allowanceRaw) && BigInt(v.rewardPerClaimRaw!) > BigInt(v.allowanceRaw)) {
      ctx.addIssue({ code: 'custom', path: ['rewardPerClaimRaw'], message: 'amount per person cannot exceed the total' })
    }
    const questTap = v.type === 'VERIFIED_QUEST' && v.requirements !== undefined && questHasTapRush(v.requirements)
    if (v.tapRush && v.type !== 'TAP_RUSH' && !questTap) {
      ctx.addIssue({ code: 'custom', path: ['tapRush'], message: 'tapRush rules only apply to Tap Rush (or a quest with a Tap Rush action)' })
    }
    if (v.type === 'VERIFIED_QUEST' && !v.requirements) ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'a Verified Quest needs requirements' })
    if (v.type !== 'VERIFIED_QUEST' && v.requirements) ctx.addIssue({ code: 'custom', path: ['requirements'], message: 'requirements only apply to Verified Quests' })
    if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'the end must be after the start' })
    }
  })
export type CreateCampaignRequest = z.infer<typeof createCampaignRequest>

const MAX_TAPS = TAP_RUSH_LIMITS.maxSeconds * TAP_RUSH_LIMITS.maxTapsPerSecond

/**
 * POST /v1/campaigns/:id/tap-rush/finish — the tap count plus each tap's time in ms since the round started on the
 * device (D-14). The server judges timing patterns, not just the count.
 */
export const finishTapRushRequest = z
  .object({
    sessionId: z.uuid(),
    taps: z.number().int().min(0).max(MAX_TAPS),
    tapTimesMs: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(TAP_RUSH_LIMITS.maxSeconds * 1000 + 2000),
      )
      .max(MAX_TAPS),
  })
  .strict()

/** POST /v1/me/eligibility: self-declared country + attestations (D-20). The server adds the IP-country check. */
export const declareEligibilityRequest = z
  .object({
    country: z.string().regex(/^[A-Za-z]{2}$/, 'choose your country'),
    notUsPerson: z.boolean(),
    attestations: z.array(z.enum(['NOT_IN_OCCUPIED_REGION'])).max(5).default([]),
  })
  .strict()

export const referralCode = z.string().regex(REFERRAL_CODE_RE, 'invalid invite code')

/** POST /v1/campaigns/:id/claim — Tap Rush claims name their qualifying session; referral claims their invite code. */
export const claimRequest = z.object({ tapSessionId: z.uuid().optional(), ref: referralCode.optional() }).strict()

/** POST /v1/campaigns/:id/funding/submit — the wallet-signed transaction, base64 wire format. */
export const submitFundingRequest = z
  .object({
    signedTransaction: z
      .string()
      .min(100)
      .max(4096)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
  })
  .strict()

export const campaignSummary = z.object({
  id: z.uuid(),
  type: z.enum(CAMPAIGN_TYPES),
  status: z.enum(CAMPAIGN_STATUSES),
  cluster: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  creatorWallet: solanaAddress,
  mint: solanaAddress,
  xstockSymbol: z.string(),
  campaignSeed: z.string().length(32),
  campaignTokenAccount: solanaAddress,
  delegateAddress: solanaAddress.nullable(),
  allowanceRaw: rawAmount,
  rewardPerClaimRaw: rawAmount.nullable(),
  claimedRaw: rawAmount,
  tapRush: tapRushRules.nullable(),
  pauseReason: z.string().nullable(),
  requirements: questRequirements.nullable(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})

export const rentEstimateResponse = z.object({
  mint: solanaAddress,
  accountSpace: z.string(),
  rentExemptLamports: z.string(),
  source: z.string(),
})

export const apiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})

const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'invalid wallet address')

/** D-23: POST /v1/skr/prepare — amounts are raw SKR units (6 decimals) as a decimal string. */
export const skrPrepareRequest = z
  .object({
    wallet: base58Address,
    action: z.enum(['stake', 'unstake', 'withdraw', 'cancel_unstake']),
    amountRaw: z.string().regex(/^[1-9]\d{0,19}$/, 'invalid amount').optional(),
    all: z.boolean().optional(),
  })
  .strict()

/** D-24: POST /v1/me/push-token. */
export const pushTokenRequest = z
  .object({
    token: z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$/, 'invalid push token'),
    platform: z.enum(['android', 'ios']),
  })
  .strict()

export const pushTokenDeleteRequest = z.object({ token: z.string().min(1).max(256) }).strict()

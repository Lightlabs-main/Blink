/**
 * API contract schemas (owner: Claude). Shared by apps/api and apps/mobile.
 * Record every change in docs/HANDOFF.md before Codex depends on it.
 */
import { CAMPAIGN_STATUSES, CAMPAIGN_TYPES, isClaimableType, TAP_RUSH_LIMITS } from '@blink/domain'
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
    if (v.tapRush && v.type !== 'TAP_RUSH') {
      ctx.addIssue({ code: 'custom', path: ['tapRush'], message: 'tapRush rules only apply to TAP_RUSH campaigns' })
    }
  })
export type CreateCampaignRequest = z.infer<typeof createCampaignRequest>

/** POST /v1/campaigns/:id/tap-rush/finish — the client's tap count for a server-started session. */
export const finishTapRushRequest = z
  .object({
    sessionId: z.uuid(),
    taps: z
      .number()
      .int()
      .min(0)
      .max(TAP_RUSH_LIMITS.maxSeconds * TAP_RUSH_LIMITS.maxTapsPerSecond),
  })
  .strict()

/** POST /v1/campaigns/:id/claim — Tap Rush claims name their qualifying session. */
export const claimRequest = z.object({ tapSessionId: z.uuid().optional() }).strict()

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

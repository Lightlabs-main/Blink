/**
 * API contract schemas (owner: Claude). Shared by apps/api and apps/mobile.
 * Record every change in docs/HANDOFF.md before Codex depends on it.
 */
import { CAMPAIGN_STATUSES, CAMPAIGN_TYPES } from '@blink/domain'
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
export const createCampaignRequest = z
  .object({
    type: z.enum(CAMPAIGN_TYPES),
    mint: solanaAddress,
    allowanceRaw: rawAmount.refine((v) => RAW_AMOUNT_RE.test(v) && BigInt(v) > 0n, 'allowance must be positive'),
  })
  .strict()
export type CreateCampaignRequest = z.infer<typeof createCampaignRequest>

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

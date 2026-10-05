/**
 * API contract schemas (owner: Claude). Shared by apps/api and apps/mobile.
 * Record every change in docs/HANDOFF.md before Codex depends on it.
 */
import {
  CAMPAIGN_STATUSES,
  CAMPAIGN_TYPES,
  CLUB_CATEGORIES,
  CLUB_LIMITS,
  CLUB_REACTIONS,
  isClaimableType,
  QUEST_LIMITS,
  type QuestRequirements,
  REFERRAL_CODE_RE,
  TAP_RUSH_LIMITS,
  VERIFIER_TYPES,
  VERIFIERS,
} from '@blink/domain'
import type { QuestCondition } from '@blink/domain'
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
  .refine((r) => r.goal <= r.seconds * TAP_RUSH_LIMITS.maxGoalPerSecond, {
    message: `that goal is too fast for a person — allow at least 1 second per ${TAP_RUSH_LIMITS.maxGoalPerSecond} taps`,
    path: ['goal'],
  })

/** D-21: one requirement. Only ENABLED registry verifiers; amount verifiers need a positive raw minimum. */
const questCondition = z
  .object({
    verifier: z.enum(VERIFIER_TYPES),
    minRaw: rawAmount.optional(),
    // D-39: X_QUEST only; one line, no links (the person's code and the drop link are added by Blink).
    mustInclude: z.string().trim().min(2).max(60).regex(/^[^\n\r]*$/, 'one line only').optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const def = VERIFIERS[c.verifier]
    if (def.availability !== 'ENABLED') ctx.addIssue({ code: 'custom', message: `${def.label} is not available yet` })
    if (def.amount && !(c.minRaw && RAW_AMOUNT_RE.test(c.minRaw) && BigInt(c.minRaw) > 0n)) {
      ctx.addIssue({ code: 'custom', path: ['minRaw'], message: `${def.label} needs a minimum amount` })
    }
    if (!def.amount && c.minRaw !== undefined) ctx.addIssue({ code: 'custom', path: ['minRaw'], message: `${def.label} takes no amount` })
    if (c.mustInclude !== undefined && c.verifier !== 'X_QUEST') ctx.addIssue({ code: 'custom', path: ['mustInclude'], message: 'only X posts take required text' })
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

/** D-33: does any requirement use `verifier`? */
export function questUses(r: QuestRequirements, verifier: QuestCondition['verifier']): boolean {
  return [...r.eligibility, ...r.actions].some((g) => g.conditions.some((c) => c.verifier === verifier))
}

/** D-33: the server stamps every ORE_ACTIVITY condition with the round current at creation. */
export function stampOreRound(r: QuestRequirements, round: bigint): QuestRequirements {
  const stamp = (gs: QuestRequirements['actions']) =>
    gs.map((g) => ({ ...g, conditions: g.conditions.map((c) => (c.verifier === 'ORE_ACTIVITY' ? { ...c, afterRound: round.toString() } : c)) }))
  return { eligibility: stamp(r.eligibility), actions: stamp(r.actions) }
}

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
    /** D-40: post the drop in a club the creator belongs to. */
    clubId: z.uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.requirements && questUses(v.requirements, 'CLUB_MEMBER') && !v.clubId) {
      ctx.addIssue({ code: 'custom', path: ['clubId'], message: 'pick the club whose members can join' })
    }
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

/** D-37: PUT /v1/me/profile — null clears the username. Lower-cased before the server checks it. */
export const profileUpdateRequest = z.object({ username: z.string().trim().toLowerCase().max(40).nullable() }).strict()

/** D-37: PUT /v1/me/avatar — a small JPEG/PNG as base64 (the app resizes to 256 px first). */
export const avatarUploadRequest = z.object({ image: z.string().min(100).max(220_000) }).strict()

/** D-39: POST /v1/campaigns/:id/x-task — the link to the person's post. */
export const xTaskSubmitRequest = z.object({ url: z.string().trim().min(10).max(300) }).strict()

/** D-32: POST /v1/me/send/prepare — `asset` is 'SOL' or a supported mint; raw amount as a decimal string. */
export const sendPrepareRequest = z
  .object({
    asset: z.union([z.literal('SOL'), base58Address]),
    to: base58Address,
    amountRaw: z.string().regex(/^[1-9]\d{0,19}$/, 'invalid amount'),
  })
  .strict()

export const sendSubmitRequest = z.object({ signedTransaction: z.string().min(100).max(4000) }).strict()

/* ───────────── D-40: clubs, chat, squads, event check-in ───────────── */

/** One line of plain text: no control characters at all. */
const ONE_LINE_RE = /^[^\p{Cc}]*$/u
/** Plain text that may contain line breaks (no other control characters). */
const PLAIN_TEXT_RE = /^(?:[^\p{Cc}]|\n)*$/u
const plainLine = (min: number, max: number) => z.string().trim().min(min).max(max).regex(ONE_LINE_RE, 'one line of plain text')

export const CLUB_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

export const createClubRequest = z
  .object({
    name: plainLine(3, CLUB_LIMITS.nameMax),
    slug: z.string().regex(CLUB_SLUG_RE, 'use 3–32 lowercase letters, numbers or -').optional(),
    description: z.string().trim().min(10).max(CLUB_LIMITS.descriptionMax).regex(PLAIN_TEXT_RE, 'plain text only'),
    category: z.enum(CLUB_CATEGORIES),
    tags: z.array(z.string().regex(/^[a-z0-9-]{2,20}$/, 'tags are 2–20 lowercase letters, numbers or -')).max(CLUB_LIMITS.maxTags).default([]),
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
  })
  .strict()
export type CreateClubRequest = z.infer<typeof createClubRequest>

export const joinClubRequest = z.object({ invite: z.string().regex(/^[A-Z0-9]{8}$/).optional() }).strict()

export const chatMessageRequest = z
  .object({
    body: z.string().trim().min(1).max(CLUB_LIMITS.messageMax).regex(PLAIN_TEXT_RE, 'plain text only'),
    replyTo: z.string().regex(/^\d{1,19}$/).optional(),
  })
  .strict()

export const reactionRequest = z.object({ emoji: z.enum(CLUB_REACTIONS) }).strict()

export const createSquadRequest = z.object({ name: plainLine(2, 24) }).strict()
export const joinSquadRequest = z.object({ code: z.string().regex(/^[A-Z0-9]{6}$/, 'squad codes are 6 letters or numbers') }).strict()

export const checkinRequest = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'not a Blink event code') }).strict()

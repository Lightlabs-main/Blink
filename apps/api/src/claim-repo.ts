import { randomUUID } from 'node:crypto'

import type { ClaimKind, ClaimStatus, ClaimSummary } from '@blink/domain'

import type { InMemoryCampaignRepository, StoredCampaign } from './campaign-repo.ts'
import type { EligibilityStore, StoredEligibility } from './eligibility.ts'

export interface StoredClaim {
  id: string
  campaignId: string
  kind: ClaimKind
  privyUserId: string
  recipientWallet: string
  amountRaw: bigint
  status: ClaimStatus
  txSignature: string | null
  lastValidBlockHeight: bigint | null
  failureReason: string | null
  tapSessionId: string | null
  referralCode: string | null
  bonusForClaimId: string | null
  /** D-17: the Seeker Genesis Token mint (device) behind a Seeker claim. */
  sgtMint: string | null
  createdAt: Date
  /** Last status change; a reservation's age is measured from here. */
  updatedAt: Date
}

export interface StoredTapSession {
  id: string
  campaignId: string
  privyUserId: string
  goal: number
  seconds: number
  startedAt: Date
  finishedAt: Date | null
  taps: number | null
  qualified: boolean
  rejectReason: string | null
}

export interface StoredReferral {
  code: string
  campaignId: string
  privyUserId: string
}

export type ReserveResult =
  /**
   * `fresh: false` = the user already had an active or paid claim, returned unchanged (idempotent retry).
   * `bonus` = the referrer's REFERRAL_BONUS reserved in the same step, or null when the referrer already earned it.
   */
  | { ok: true; claim: StoredClaim; bonus: StoredClaim | null; fresh: boolean }
  | { ok: false; reason: 'NOT_LIVE' | 'EXHAUSTED' | 'WALLET_ALREADY_CLAIMED' | 'SESSION_ALREADY_USED' | 'DEVICE_ALREADY_CLAIMED' }

export interface NewReservation {
  campaignId: string
  privyUserId: string
  recipientWallet: string
  amountRaw: bigint
  tapSessionId: string | null
  /** D-17: Seeker drops — one claim per SGT mint (device) per campaign. */
  sgtMint?: string | null
  /** D-14: a friend's claim through an invite also reserves the referrer's bonus (same amount), if still unearned. */
  referral?: { code: string; referrerPrivyUserId: string; referrerWallet: string } | null
}

/**
 * Claims, Tap Rush sessions and referral codes (DECISIONS D-13, D-14). The campaign's claimedRaw and the claim rows
 * change together: every amount held by a RESERVED/SENDING/PAID claim is counted in claimedRaw, and
 * claimedRaw <= allowanceRaw.
 */
export interface ClaimRepository {
  findForUser(campaignId: string, privyUserId: string, kind?: ClaimKind): Promise<StoredClaim | null>
  findById(id: string): Promise<StoredClaim | null>
  listForUser(privyUserId: string, limit: number): Promise<StoredClaim[]>
  /** SENDING claims, and RESERVED ones untouched since `staleBefore`: work for the reconcile sweep. */
  listUnsettled(staleBefore: Date, limit: number): Promise<StoredClaim[]>
  /**
   * Atomic: returns the user's existing RESERVED/SENDING/PAID claim unchanged; otherwise holds the amount against a
   * LIVE campaign's remaining pool and creates the claim (or reuses the user's FAILED claim). With `referral`, it
   * also holds and creates the referrer's bonus when the referrer has not earned one yet — both fit or neither.
   */
  reserve(input: NewReservation): Promise<ReserveResult>
  /** FAILED → RESERVED for the same claim (e.g. a referrer retrying a failed bonus), holding its amount again. */
  reReserve(id: string): Promise<{ ok: true; claim: StoredClaim } | { ok: false; reason: 'NOT_LIVE' | 'EXHAUSTED' | 'NOT_FAILED' }>
  /**
   * RESERVED → SENDING, recording the signature before the transaction is sent. Returns false if the claim is no
   * longer RESERVED (e.g. released as stale meanwhile) — the caller must then NOT send.
   */
  markSending(id: string, txSignature: string, lastValidBlockHeight: bigint): Promise<boolean>
  /** SENDING → PAID. */
  markPaid(id: string): Promise<StoredClaim | null>
  /** RESERVED/SENDING → FAILED and releases the amount. Only call once the transaction can never land. */
  markFailed(id: string, reason: string): Promise<void>

  startTapSession(input: { campaignId: string; privyUserId: string; goal: number; seconds: number }): Promise<StoredTapSession>
  countTapSessions(campaignId: string, privyUserId: string): Promise<number>
  findTapSession(id: string): Promise<StoredTapSession | null>
  /** Records the result once; returns null if the session was already finished. */
  finishTapSession(
    id: string,
    result: { taps: number; qualified: boolean; finishedAt: Date; rejectReason: string | null },
  ): Promise<StoredTapSession | null>

  /** Returns the user's code for this campaign, creating it with `newCode` if absent; null if `newCode` is taken. */
  getOrCreateReferral(campaignId: string, privyUserId: string, newCode: string): Promise<StoredReferral | null>
  findReferral(code: string): Promise<StoredReferral | null>
  findReferralForUser(campaignId: string, privyUserId: string): Promise<StoredReferral | null>
}

/** Blink-operated wallets that are not per-campaign (the §16 fee payer). */
export interface ServiceWalletStore {
  get(role: string): Promise<{ address: string; walletRef: string } | null>
  /** Stores the wallet unless the role already has one; returns whichever is stored. */
  putIfAbsent(role: string, wallet: { address: string; walletRef: string }): Promise<{ address: string; walletRef: string }>
}

export function toClaimSummary(claim: StoredClaim, campaign: StoredCampaign): ClaimSummary {
  return {
    id: claim.id,
    campaignId: claim.campaignId,
    kind: claim.kind,
    cluster: campaign.cluster,
    mint: campaign.mint,
    xstockSymbol: campaign.xstockSymbol,
    amountRaw: claim.amountRaw.toString(),
    recipientWallet: claim.recipientWallet,
    status: claim.status,
    txSignature: claim.txSignature,
    failureReason: claim.failureReason,
    createdAt: claim.createdAt.toISOString(),
  }
}

/** Test/dev repository. Each method has no await between its checks and writes, so it is atomic. */
export class InMemoryClaimRepository implements ClaimRepository, ServiceWalletStore, EligibilityStore {
  private readonly eligibility = new Map<string, StoredEligibility>()
  private readonly claims = new Map<string, StoredClaim>()
  private readonly sessions = new Map<string, StoredTapSession>()
  private readonly referrals = new Map<string, StoredReferral>()
  private readonly serviceWallets = new Map<string, { address: string; walletRef: string }>()

  constructor(private readonly campaigns: InMemoryCampaignRepository) {}

  async findForUser(campaignId: string, privyUserId: string, kind: ClaimKind = 'CLAIM') {
    return this.find(campaignId, privyUserId, kind) ?? null
  }

  async findById(id: string) {
    return this.claims.get(id) ?? null
  }

  async listForUser(privyUserId: string, limit: number) {
    return [...this.claims.values()]
      .filter((c) => c.privyUserId === privyUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }

  async listUnsettled(staleBefore: Date, limit: number) {
    return [...this.claims.values()]
      .filter((c) => c.status === 'SENDING' || (c.status === 'RESERVED' && c.updatedAt < staleBefore))
      .slice(0, limit)
  }

  async reserve(input: NewReservation): Promise<ReserveResult> {
    const existing = this.find(input.campaignId, input.privyUserId, 'CLAIM')
    if (existing && existing.status !== 'FAILED') return { ok: true, claim: existing, bonus: null, fresh: false }
    const all = [...this.claims.values()]
    if (all.some((c) => c.campaignId === input.campaignId && c.kind === 'CLAIM' && c.recipientWallet === input.recipientWallet && c.id !== existing?.id)) {
      return { ok: false, reason: 'WALLET_ALREADY_CLAIMED' }
    }
    if (input.tapSessionId && all.some((c) => c.tapSessionId === input.tapSessionId && c.id !== existing?.id)) {
      return { ok: false, reason: 'SESSION_ALREADY_USED' }
    }
    if (input.sgtMint && all.some((c) => c.campaignId === input.campaignId && c.sgtMint === input.sgtMint && c.id !== existing?.id)) {
      return { ok: false, reason: 'DEVICE_ALREADY_CLAIMED' }
    }
    const campaign = this.campaigns.row(input.campaignId)
    if (!campaign || campaign.status !== 'LIVE') return { ok: false, reason: 'NOT_LIVE' }

    // The referrer earns once (D-14): only an absent or FAILED bonus row can be (re)filled.
    const ref = input.referral
    const priorBonus = ref ? this.find(input.campaignId, ref.referrerPrivyUserId, 'REFERRAL_BONUS') : undefined
    const walletHasBonus =
      ref && all.some((c) => c.campaignId === input.campaignId && c.kind === 'REFERRAL_BONUS' && c.recipientWallet === ref.referrerWallet && c.id !== priorBonus?.id)
    const withBonus = Boolean(ref && (!priorBonus || priorBonus.status === 'FAILED') && !walletHasBonus)
    const hold = input.amountRaw * (withBonus ? 2n : 1n)
    if (campaign.claimedRaw + hold > campaign.allowanceRaw) return { ok: false, reason: 'EXHAUSTED' }

    campaign.claimedRaw += hold
    const now = new Date()
    const claim = this.put({
      ...blank(existing, now),
      campaignId: input.campaignId,
      kind: 'CLAIM',
      privyUserId: input.privyUserId,
      recipientWallet: input.recipientWallet,
      amountRaw: input.amountRaw,
      tapSessionId: input.tapSessionId,
      referralCode: ref?.code ?? null,
      bonusForClaimId: null,
      sgtMint: input.sgtMint ?? null,
    })
    const bonus =
      withBonus && ref
        ? this.put({
            ...blank(priorBonus, now),
            campaignId: input.campaignId,
            kind: 'REFERRAL_BONUS',
            privyUserId: ref.referrerPrivyUserId,
            recipientWallet: ref.referrerWallet,
            amountRaw: input.amountRaw,
            tapSessionId: null,
            referralCode: ref.code,
            bonusForClaimId: claim.id,
            sgtMint: null,
          })
        : null
    return { ok: true, claim, bonus, fresh: true }
  }

  async reReserve(id: string) {
    const c = this.claims.get(id)
    if (!c || c.status !== 'FAILED') return { ok: false as const, reason: 'NOT_FAILED' as const }
    const campaign = this.campaigns.row(c.campaignId)
    if (!campaign || campaign.status !== 'LIVE') return { ok: false as const, reason: 'NOT_LIVE' as const }
    if (campaign.claimedRaw + c.amountRaw > campaign.allowanceRaw) return { ok: false as const, reason: 'EXHAUSTED' as const }
    campaign.claimedRaw += c.amountRaw
    Object.assign(c, { status: 'RESERVED', failureReason: null, updatedAt: new Date() })
    return { ok: true as const, claim: c }
  }

  async markSending(id: string, txSignature: string, lastValidBlockHeight: bigint) {
    const c = this.claims.get(id)
    if (c?.status !== 'RESERVED') return false
    Object.assign(c, { status: 'SENDING', txSignature, lastValidBlockHeight, updatedAt: new Date() })
    return true
  }

  async markPaid(id: string) {
    const c = this.claims.get(id)
    if (c?.status !== 'SENDING') return null
    Object.assign(c, { status: 'PAID', updatedAt: new Date() })
    return c
  }

  async markFailed(id: string, reason: string) {
    const c = this.claims.get(id)
    if (!c || (c.status !== 'RESERVED' && c.status !== 'SENDING')) return
    const campaign = this.campaigns.row(c.campaignId)
    if (campaign) campaign.claimedRaw -= c.amountRaw
    Object.assign(c, { status: 'FAILED', failureReason: reason, txSignature: null, lastValidBlockHeight: null, updatedAt: new Date() })
  }

  async startTapSession(input: { campaignId: string; privyUserId: string; goal: number; seconds: number }) {
    const s: StoredTapSession = { id: randomUUID(), ...input, startedAt: new Date(), finishedAt: null, taps: null, qualified: false, rejectReason: null }
    this.sessions.set(s.id, s)
    return s
  }

  async countTapSessions(campaignId: string, privyUserId: string) {
    return [...this.sessions.values()].filter((s) => s.campaignId === campaignId && s.privyUserId === privyUserId).length
  }

  async findTapSession(id: string) {
    return this.sessions.get(id) ?? null
  }

  async finishTapSession(id: string, result: { taps: number; qualified: boolean; finishedAt: Date; rejectReason: string | null }) {
    const s = this.sessions.get(id)
    if (!s || s.finishedAt) return null
    Object.assign(s, result)
    return s
  }

  async getOrCreateReferral(campaignId: string, privyUserId: string, newCode: string) {
    const existing = [...this.referrals.values()].find((r) => r.campaignId === campaignId && r.privyUserId === privyUserId)
    if (existing) return existing
    if (this.referrals.has(newCode)) return null
    const r = { code: newCode, campaignId, privyUserId }
    this.referrals.set(newCode, r)
    return r
  }

  async findReferral(code: string) {
    return this.referrals.get(code) ?? null
  }

  async findReferralForUser(campaignId: string, privyUserId: string) {
    return [...this.referrals.values()].find((r) => r.campaignId === campaignId && r.privyUserId === privyUserId) ?? null
  }

  async getEligibility(privyUserId: string) {
    return this.eligibility.get(privyUserId) ?? null
  }

  async putEligibility(record: Omit<StoredEligibility, 'decidedAt'>) {
    const stored = { ...record, decidedAt: new Date() }
    this.eligibility.set(record.privyUserId, stored)
    return stored
  }

  async get(role: string) {
    return this.serviceWallets.get(role) ?? null
  }

  async putIfAbsent(role: string, wallet: { address: string; walletRef: string }) {
    if (!this.serviceWallets.has(role)) this.serviceWallets.set(role, wallet)
    return this.serviceWallets.get(role)!
  }

  private find(campaignId: string, privyUserId: string, kind: ClaimKind) {
    return [...this.claims.values()].find((c) => c.campaignId === campaignId && c.privyUserId === privyUserId && c.kind === kind)
  }

  private put(c: StoredClaim) {
    this.claims.set(c.id, c)
    return c
  }
}

/** A fresh RESERVED row, reusing a FAILED row's id and creation time when there is one. */
function blank(reuse: StoredClaim | undefined, now: Date) {
  return {
    id: reuse?.id ?? randomUUID(),
    status: 'RESERVED' as const,
    txSignature: null,
    lastValidBlockHeight: null,
    failureReason: null,
    createdAt: reuse?.createdAt ?? now,
    updatedAt: now,
  }
}

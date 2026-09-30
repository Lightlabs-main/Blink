import { randomUUID } from 'node:crypto'

import type { ClaimStatus, ClaimSummary } from '@blink/domain'

import type { InMemoryCampaignRepository, StoredCampaign } from './campaign-repo.ts'

export interface StoredClaim {
  id: string
  campaignId: string
  privyUserId: string
  recipientWallet: string
  amountRaw: bigint
  status: ClaimStatus
  txSignature: string | null
  lastValidBlockHeight: bigint | null
  failureReason: string | null
  tapSessionId: string | null
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
}

export type ReserveResult =
  /** `fresh: false` = the user already had an active or paid claim, returned unchanged (idempotent retry). */
  | { ok: true; claim: StoredClaim; fresh: boolean }
  | { ok: false; reason: 'NOT_LIVE' | 'EXHAUSTED' | 'WALLET_ALREADY_CLAIMED' | 'SESSION_ALREADY_USED' }

export interface NewReservation {
  campaignId: string
  privyUserId: string
  recipientWallet: string
  amountRaw: bigint
  tapSessionId: string | null
}

/**
 * Claims and Tap Rush sessions (DECISIONS D-13). The campaign's claimedRaw and the claim rows change together:
 * every amount held by a RESERVED/SENDING/PAID claim is counted in claimedRaw, and claimedRaw <= allowanceRaw.
 */
export interface ClaimRepository {
  findForUser(campaignId: string, privyUserId: string): Promise<StoredClaim | null>
  listForUser(privyUserId: string, limit: number): Promise<StoredClaim[]>
  /**
   * Atomic: returns the user's existing RESERVED/SENDING/PAID claim unchanged; otherwise holds amountRaw against a
   * LIVE campaign's remaining pool and creates the claim (or reuses the user's FAILED claim).
   */
  reserve(input: NewReservation): Promise<ReserveResult>
  /** RESERVED → SENDING, recording the signature before the transaction is sent. */
  markSending(id: string, txSignature: string, lastValidBlockHeight: bigint): Promise<void>
  /** SENDING → PAID. */
  markPaid(id: string): Promise<StoredClaim | null>
  /** RESERVED/SENDING → FAILED and releases the amount. Only call once the transaction can never land. */
  markFailed(id: string, reason: string): Promise<void>

  startTapSession(input: { campaignId: string; privyUserId: string; goal: number; seconds: number }): Promise<StoredTapSession>
  countTapSessions(campaignId: string, privyUserId: string): Promise<number>
  findTapSession(id: string): Promise<StoredTapSession | null>
  /** Records the result once; returns null if the session was already finished. */
  finishTapSession(id: string, result: { taps: number; qualified: boolean; finishedAt: Date }): Promise<StoredTapSession | null>
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
export class InMemoryClaimRepository implements ClaimRepository, ServiceWalletStore {
  private readonly claims = new Map<string, StoredClaim>()
  private readonly sessions = new Map<string, StoredTapSession>()
  private readonly serviceWallets = new Map<string, { address: string; walletRef: string }>()

  constructor(private readonly campaigns: InMemoryCampaignRepository) {}

  async findForUser(campaignId: string, privyUserId: string) {
    return [...this.claims.values()].find((c) => c.campaignId === campaignId && c.privyUserId === privyUserId) ?? null
  }

  async listForUser(privyUserId: string, limit: number) {
    return [...this.claims.values()]
      .filter((c) => c.privyUserId === privyUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }

  async reserve(input: NewReservation): Promise<ReserveResult> {
    const all = [...this.claims.values()]
    const existing = all.find((c) => c.campaignId === input.campaignId && c.privyUserId === input.privyUserId)
    if (existing && existing.status !== 'FAILED') return { ok: true, claim: existing, fresh: false }
    if (all.some((c) => c.campaignId === input.campaignId && c.recipientWallet === input.recipientWallet && c.id !== existing?.id)) {
      return { ok: false, reason: 'WALLET_ALREADY_CLAIMED' }
    }
    if (input.tapSessionId && all.some((c) => c.tapSessionId === input.tapSessionId && c.id !== existing?.id)) {
      return { ok: false, reason: 'SESSION_ALREADY_USED' }
    }
    const campaign = this.campaigns.row(input.campaignId)
    if (!campaign || campaign.status !== 'LIVE') return { ok: false, reason: 'NOT_LIVE' }
    if (campaign.claimedRaw + input.amountRaw > campaign.allowanceRaw) return { ok: false, reason: 'EXHAUSTED' }

    campaign.claimedRaw += input.amountRaw
    const claim: StoredClaim = {
      id: existing?.id ?? randomUUID(),
      campaignId: input.campaignId,
      privyUserId: input.privyUserId,
      recipientWallet: input.recipientWallet,
      amountRaw: input.amountRaw,
      status: 'RESERVED',
      txSignature: null,
      lastValidBlockHeight: null,
      failureReason: null,
      tapSessionId: input.tapSessionId,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    }
    this.claims.set(claim.id, claim)
    return { ok: true, claim, fresh: true }
  }

  async markSending(id: string, txSignature: string, lastValidBlockHeight: bigint) {
    const c = this.claims.get(id)
    if (c?.status === 'RESERVED') Object.assign(c, { status: 'SENDING', txSignature, lastValidBlockHeight, updatedAt: new Date() })
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
    const s: StoredTapSession = { id: randomUUID(), ...input, startedAt: new Date(), finishedAt: null, taps: null, qualified: false }
    this.sessions.set(s.id, s)
    return s
  }

  async countTapSessions(campaignId: string, privyUserId: string) {
    return [...this.sessions.values()].filter((s) => s.campaignId === campaignId && s.privyUserId === privyUserId).length
  }

  async findTapSession(id: string) {
    return this.sessions.get(id) ?? null
  }

  async finishTapSession(id: string, result: { taps: number; qualified: boolean; finishedAt: Date }) {
    const s = this.sessions.get(id)
    if (!s || s.finishedAt) return null
    Object.assign(s, result)
    return s
  }

  async get(role: string) {
    return this.serviceWallets.get(role) ?? null
  }

  async putIfAbsent(role: string, wallet: { address: string; walletRef: string }) {
    if (!this.serviceWallets.has(role)) this.serviceWallets.set(role, wallet)
    return this.serviceWallets.get(role)!
  }
}

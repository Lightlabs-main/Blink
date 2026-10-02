import { randomUUID } from 'node:crypto'

import type { ClaimKind, QuestEvaluation } from '@blink/domain'

import type { ClaimRepository, NewReservation, ReserveResult, RoomData, ServiceWalletStore, StoredClaim, StoredReferral, StoredTapSession } from './claim-repo.ts'
import type { EligibilityStore, StoredEligibility } from './eligibility.ts'
import { type Claim, Prisma, type TapRushSession, type XStockEligibility } from './generated/prisma/client.ts'
import type { createPrismaClient } from './prisma-campaign-repo.ts'

type Db = ReturnType<typeof createPrismaClient>
type Tx = Prisma.TransactionClient

function toClaim(row: Claim): StoredClaim {
  return {
    id: row.id,
    campaignId: row.campaignId,
    kind: row.kind,
    privyUserId: row.privyUserId,
    recipientWallet: row.recipientWallet,
    amountRaw: BigInt(row.amountRaw.toFixed(0)),
    status: row.status,
    txSignature: row.txSignature,
    lastValidBlockHeight: row.lastValidBlockHeight,
    failureReason: row.failureReason,
    tapSessionId: row.tapSessionId,
    referralCode: row.referralCode,
    bonusForClaimId: row.bonusForClaimId,
    sgtMint: row.sgtMint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toSession(row: TapRushSession): StoredTapSession {
  return { ...row }
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

const RESERVED_FIELDS = { status: 'RESERVED' as const, txSignature: null, lastValidBlockHeight: null, failureReason: null }

/** Adds `amount` to claimedRaw only while the campaign is LIVE and the pool still fits it. Returns rows changed. */
function hold(tx: Tx, campaignId: string, amount: bigint) {
  return tx.$executeRaw`
    UPDATE "Campaign" SET "claimedRaw" = "claimedRaw" + ${amount.toString()}::numeric, "updatedAt" = now()
    WHERE "id" = ${campaignId}::uuid AND "status" = 'LIVE' AND "claimedRaw" + ${amount.toString()}::numeric <= "allowanceRaw"`
}

function release(tx: Tx, campaignId: string, amount: bigint) {
  return tx.$executeRaw`
    UPDATE "Campaign" SET "claimedRaw" = "claimedRaw" - ${amount.toString()}::numeric, "updatedAt" = now()
    WHERE "id" = ${campaignId}::uuid`
}

async function whyNotHeld(tx: Tx, campaignId: string) {
  const c = await tx.campaign.findUnique({ where: { id: campaignId }, select: { status: true } })
  return c?.status === 'LIVE' ? ('EXHAUSTED' as const) : ('NOT_LIVE' as const)
}

/**
 * Postgres claim store. The pool is held with a conditional UPDATE (claimedRaw + amount <= allowanceRaw) in the
 * same transaction that writes the claim rows, and the table's CHECK constraint backs it up; concurrent claims queue
 * on the campaign row lock and re-evaluate the condition.
 */
function toEligibility(row: XStockEligibility): StoredEligibility {
  return { ...row, reason: row.reason as StoredEligibility['reason'] }
}

export class PrismaClaimRepository implements ClaimRepository, ServiceWalletStore, EligibilityStore {
  constructor(private readonly prisma: Db) {}

  async findForUser(campaignId: string, privyUserId: string, kind: ClaimKind = 'CLAIM') {
    const row = await this.prisma.claim.findUnique({ where: { campaignId_privyUserId_kind: { campaignId, privyUserId, kind } } })
    return row ? toClaim(row) : null
  }

  async findById(id: string) {
    const row = await this.prisma.claim.findUnique({ where: { id } })
    return row ? toClaim(row) : null
  }

  async listForUser(privyUserId: string, limit: number) {
    const rows = await this.prisma.claim.findMany({ where: { privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toClaim)
  }

  async listUnsettled(staleBefore: Date, limit: number) {
    const rows = await this.prisma.claim.findMany({
      where: { OR: [{ status: 'SENDING' }, { status: 'RESERVED', updatedAt: { lt: staleBefore } }] },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    })
    return rows.map(toClaim)
  }

  async reserve(input: NewReservation): Promise<ReserveResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.claim.findUnique({
          where: { campaignId_privyUserId_kind: { campaignId: input.campaignId, privyUserId: input.privyUserId, kind: 'CLAIM' } },
        })
        if (existing && existing.status !== 'FAILED') return { ok: true, claim: toClaim(existing), bonus: null, fresh: false } as const

        // D-14: the referrer earns once. Only an absent or FAILED bonus can be (re)filled.
        const ref = input.referral ?? null
        let priorBonus: Claim | null = null
        let withBonus = false
        if (ref) {
          priorBonus = await tx.claim.findUnique({
            where: { campaignId_privyUserId_kind: { campaignId: input.campaignId, privyUserId: ref.referrerPrivyUserId, kind: 'REFERRAL_BONUS' } },
          })
          const walletHasBonus = await tx.claim.findFirst({
            where: {
              campaignId: input.campaignId,
              kind: 'REFERRAL_BONUS',
              recipientWallet: ref.referrerWallet,
              ...(priorBonus ? { NOT: { id: priorBonus.id } } : {}),
            },
          })
          withBonus = (!priorBonus || priorBonus.status === 'FAILED') && !walletHasBonus
        }

        if ((await hold(tx, input.campaignId, input.amountRaw * (withBonus ? 2n : 1n))) === 0) {
          return { ok: false, reason: await whyNotHeld(tx, input.campaignId) } as const
        }

        const data = {
          ...RESERVED_FIELDS,
          recipientWallet: input.recipientWallet,
          amountRaw: input.amountRaw.toString(),
          tapSessionId: input.tapSessionId,
          referralCode: ref?.code ?? null,
          sgtMint: input.sgtMint ?? null,
        }
        const row = existing
          ? await tx.claim.update({ where: { id: existing.id }, data })
          : await tx.claim.create({ data: { id: randomUUID(), campaignId: input.campaignId, privyUserId: input.privyUserId, kind: 'CLAIM', ...data } })

        let bonus: StoredClaim | null = null
        if (withBonus && ref) {
          const bonusData = {
            ...RESERVED_FIELDS,
            recipientWallet: ref.referrerWallet,
            amountRaw: input.amountRaw.toString(),
            referralCode: ref.code,
            bonusForClaimId: row.id,
          }
          // A concurrent friend of the same referrer may win the bonus; then only this friend's reward is kept.
          const { count } = priorBonus
            ? await tx.claim.updateMany({ where: { id: priorBonus.id, status: 'FAILED' }, data: bonusData })
            : await tx.claim.createMany({
                data: [{ id: randomUUID(), campaignId: input.campaignId, privyUserId: ref.referrerPrivyUserId, kind: 'REFERRAL_BONUS', ...bonusData }],
                skipDuplicates: true,
              })
          const stored = count
            ? await tx.claim.findUnique({
                where: { campaignId_privyUserId_kind: { campaignId: input.campaignId, privyUserId: ref.referrerPrivyUserId, kind: 'REFERRAL_BONUS' } },
              })
            : null
          if (stored?.bonusForClaimId === row.id) bonus = toClaim(stored)
          else await release(tx, input.campaignId, input.amountRaw)
        }
        return { ok: true, claim: toClaim(row), bonus, fresh: true } as const
      })
    } catch (err) {
      // A unique constraint rolled the whole transaction back (including the pool hold). Explain which one.
      if (!isUniqueViolation(err)) throw err
      const mine = await this.findForUser(input.campaignId, input.privyUserId)
      if (mine && mine.status !== 'FAILED') return { ok: true, claim: mine, bonus: null, fresh: false }
      const walletTaken = await this.prisma.claim.findFirst({
        where: { campaignId: input.campaignId, kind: 'CLAIM', recipientWallet: input.recipientWallet, NOT: { privyUserId: input.privyUserId } },
      })
      if (walletTaken) return { ok: false, reason: 'WALLET_ALREADY_CLAIMED' }
      if (input.sgtMint && (await this.prisma.claim.findFirst({ where: { campaignId: input.campaignId, sgtMint: input.sgtMint } }))) {
        return { ok: false, reason: 'DEVICE_ALREADY_CLAIMED' }
      }
      if (input.tapSessionId) return { ok: false, reason: 'SESSION_ALREADY_USED' }
      throw err
    }
  }

  async reReserve(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.claim.findUnique({ where: { id } })
      if (!c || c.status !== 'FAILED') return { ok: false, reason: 'NOT_FAILED' } as const
      if ((await hold(tx, c.campaignId, BigInt(c.amountRaw.toFixed(0)))) === 0) return { ok: false, reason: await whyNotHeld(tx, c.campaignId) } as const
      const row = await tx.claim.update({ where: { id }, data: RESERVED_FIELDS })
      return { ok: true, claim: toClaim(row) } as const
    })
  }

  async markSending(id: string, txSignature: string, lastValidBlockHeight: bigint) {
    const { count } = await this.prisma.claim.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'SENDING', txSignature, lastValidBlockHeight } })
    return count === 1
  }

  async markPaid(id: string) {
    const { count } = await this.prisma.claim.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'PAID' } })
    if (count === 0) return null
    return toClaim(await this.prisma.claim.findUniqueOrThrow({ where: { id } }))
  }

  async markFailed(id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id } })
      if (!claim) return
      const { count } = await tx.claim.updateMany({
        where: { id, status: { in: ['RESERVED', 'SENDING'] } },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500), txSignature: null, lastValidBlockHeight: null },
      })
      if (count === 0) return
      await release(tx, claim.campaignId, BigInt(claim.amountRaw.toFixed(0)))
    })
  }

  async startTapSession(input: { campaignId: string; privyUserId: string; goal: number; seconds: number; publicWallet?: string | null }) {
    return toSession(await this.prisma.tapRushSession.create({ data: { id: randomUUID(), ...input, publicWallet: input.publicWallet ?? null } }))
  }

  async findUnusedQualifiedSession(campaignId: string, privyUserId: string) {
    const used = await this.prisma.claim.findMany({ where: { campaignId, tapSessionId: { not: null } }, select: { tapSessionId: true } })
    const row = await this.prisma.tapRushSession.findFirst({
      where: { campaignId, privyUserId, qualified: true, id: { notIn: used.map((u) => u.tapSessionId!) } },
      orderBy: { startedAt: 'desc' },
    })
    return row ? toSession(row) : null
  }

  async putQuestVerification(input: { campaignId: string; privyUserId: string; evaluation: QuestEvaluation; publicWallet: string | null }) {
    const data = { qualified: input.evaluation.qualified, summary: input.evaluation as object, publicWallet: input.publicWallet }
    await this.prisma.questVerification.upsert({
      where: { campaignId_privyUserId: { campaignId: input.campaignId, privyUserId: input.privyUserId } },
      create: { campaignId: input.campaignId, privyUserId: input.privyUserId, ...data },
      update: data,
    })
  }

  async roomData(campaignId: string, limits: { leaderboard: number; events: number }): Promise<RoomData> {
    const [sessions, checks, claims] = await Promise.all([
      this.prisma.tapRushSession.findMany({ where: { campaignId }, orderBy: { startedAt: 'desc' }, take: 2000 }),
      this.prisma.questVerification.findMany({ where: { campaignId }, orderBy: { checkedAt: 'desc' }, take: 2000 }),
      this.prisma.claim.findMany({ where: { campaignId, kind: 'CLAIM' }, orderBy: { updatedAt: 'desc' }, take: 2000 }),
    ])
    const joined = new Set([...sessions.map((s) => s.privyUserId), ...checks.map((q) => q.privyUserId), ...claims.map((c) => c.privyUserId)])
    const qualified = new Set([
      ...sessions.filter((s) => s.qualified).map((s) => s.privyUserId),
      ...checks.filter((q) => q.qualified).map((q) => q.privyUserId),
      ...claims.filter((c) => c.status !== 'FAILED').map((c) => c.privyUserId),
    ])
    const best = new Map<string, { wallet: string | null; score: number }>()
    for (const s of sessions) {
      if (!s.finishedAt || s.rejectReason || s.taps === null) continue
      const prev = best.get(s.privyUserId)
      if (!prev || s.taps > prev.score) best.set(s.privyUserId, { wallet: s.publicWallet, score: s.taps })
    }
    const events: RoomData['events'] = [
      ...sessions.map((s) => ({ type: 'PARTICIPANT_JOINED' as const, wallet: s.publicWallet, at: s.startedAt })),
      ...sessions.filter((s) => s.qualified && s.finishedAt).map((s) => ({ type: 'PARTICIPANT_QUALIFIED' as const, wallet: s.publicWallet, at: s.finishedAt! })),
      ...checks.filter((q) => q.qualified).map((q) => ({ type: 'REQUIREMENT_VERIFIED' as const, wallet: q.publicWallet, at: q.checkedAt })),
      ...claims.filter((c) => c.status === 'PAID').map((c) => ({ type: 'PAYOUT_CONFIRMED' as const, wallet: c.recipientWallet, at: c.updatedAt })),
    ]
    return {
      joined: joined.size,
      qualified: qualified.size,
      leaderboard: [...best.values()].sort((a, b) => b.score - a.score).slice(0, limits.leaderboard),
      events: events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limits.events),
    }
  }

  async countTapSessions(campaignId: string, privyUserId: string) {
    return this.prisma.tapRushSession.count({ where: { campaignId, privyUserId } })
  }

  async findTapSession(id: string) {
    const row = await this.prisma.tapRushSession.findUnique({ where: { id } })
    return row ? toSession(row) : null
  }

  async finishTapSession(id: string, result: { taps: number; qualified: boolean; finishedAt: Date; rejectReason: string | null }) {
    const { count } = await this.prisma.tapRushSession.updateMany({ where: { id, finishedAt: null }, data: result })
    if (count === 0) return null
    return toSession(await this.prisma.tapRushSession.findUniqueOrThrow({ where: { id } }))
  }

  async getOrCreateReferral(campaignId: string, privyUserId: string, newCode: string) {
    await this.prisma.referral.createMany({ data: [{ code: newCode, campaignId, privyUserId }], skipDuplicates: true })
    return this.prisma.referral.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
  }

  async findReferral(code: string): Promise<StoredReferral | null> {
    return this.prisma.referral.findUnique({ where: { code } })
  }

  async findReferralForUser(campaignId: string, privyUserId: string): Promise<StoredReferral | null> {
    return this.prisma.referral.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
  }

  async getEligibility(privyUserId: string) {
    const row = await this.prisma.xStockEligibility.findUnique({ where: { privyUserId } })
    return row ? toEligibility(row) : null
  }

  async putEligibility(record: Omit<StoredEligibility, 'decidedAt'>) {
    const row = await this.prisma.xStockEligibility.upsert({ where: { privyUserId: record.privyUserId }, create: record, update: record })
    return toEligibility(row)
  }

  async get(role: string) {
    const row = await this.prisma.serviceWallet.findUnique({ where: { role } })
    return row ? { address: row.address, walletRef: row.walletRef } : null
  }

  async putIfAbsent(role: string, wallet: { address: string; walletRef: string }) {
    await this.prisma.serviceWallet.createMany({ data: [{ role, ...wallet }], skipDuplicates: true })
    const row = await this.prisma.serviceWallet.findUniqueOrThrow({ where: { role } })
    return { address: row.address, walletRef: row.walletRef }
  }
}

import { randomUUID } from 'node:crypto'

import type { ClaimRepository, NewReservation, ReserveResult, ServiceWalletStore, StoredClaim, StoredTapSession } from './claim-repo.ts'
import { type Claim, Prisma, type TapRushSession } from './generated/prisma/client.ts'
import type { createPrismaClient } from './prisma-campaign-repo.ts'

type Db = ReturnType<typeof createPrismaClient>

function toClaim(row: Claim): StoredClaim {
  return {
    id: row.id,
    campaignId: row.campaignId,
    privyUserId: row.privyUserId,
    recipientWallet: row.recipientWallet,
    amountRaw: BigInt(row.amountRaw.toFixed(0)),
    status: row.status,
    txSignature: row.txSignature,
    lastValidBlockHeight: row.lastValidBlockHeight,
    failureReason: row.failureReason,
    tapSessionId: row.tapSessionId,
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

/**
 * Postgres claim store. The pool is held with a conditional UPDATE (claimedRaw + amount <= allowanceRaw) in the
 * same transaction that writes the claim, and the table's CHECK constraint backs it up; concurrent claims queue on
 * the campaign row lock and re-evaluate the condition.
 */
export class PrismaClaimRepository implements ClaimRepository, ServiceWalletStore {
  constructor(private readonly prisma: Db) {}

  async findForUser(campaignId: string, privyUserId: string) {
    const row = await this.prisma.claim.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
    return row ? toClaim(row) : null
  }

  async listForUser(privyUserId: string, limit: number) {
    const rows = await this.prisma.claim.findMany({ where: { privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toClaim)
  }

  async reserve(input: NewReservation): Promise<ReserveResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.claim.findUnique({
          where: { campaignId_privyUserId: { campaignId: input.campaignId, privyUserId: input.privyUserId } },
        })
        if (existing && existing.status !== 'FAILED') return { ok: true, claim: toClaim(existing), fresh: false } as const

        const amount = input.amountRaw.toString()
        const held = await tx.$executeRaw`
          UPDATE "Campaign" SET "claimedRaw" = "claimedRaw" + ${amount}::numeric, "updatedAt" = now()
          WHERE "id" = ${input.campaignId}::uuid AND "status" = 'LIVE' AND "claimedRaw" + ${amount}::numeric <= "allowanceRaw"`
        if (held === 0) {
          const c = await tx.campaign.findUnique({ where: { id: input.campaignId }, select: { status: true } })
          return { ok: false, reason: c?.status === 'LIVE' ? 'EXHAUSTED' : 'NOT_LIVE' } as const
        }

        const data = {
          recipientWallet: input.recipientWallet,
          amountRaw: amount,
          status: 'RESERVED' as const,
          txSignature: null,
          lastValidBlockHeight: null,
          failureReason: null,
          tapSessionId: input.tapSessionId,
        }
        const row = existing
          ? await tx.claim.update({ where: { id: existing.id }, data })
          : await tx.claim.create({ data: { id: randomUUID(), campaignId: input.campaignId, privyUserId: input.privyUserId, ...data } })
        return { ok: true, claim: toClaim(row), fresh: true } as const
      })
    } catch (err) {
      // A unique constraint rolled the whole transaction back (including the pool hold). Explain which one.
      if (!isUniqueViolation(err)) throw err
      const mine = await this.findForUser(input.campaignId, input.privyUserId)
      if (mine && mine.status !== 'FAILED') return { ok: true, claim: mine, fresh: false }
      const walletTaken = await this.prisma.claim.findFirst({
        where: { campaignId: input.campaignId, recipientWallet: input.recipientWallet, NOT: { privyUserId: input.privyUserId } },
      })
      if (walletTaken) return { ok: false, reason: 'WALLET_ALREADY_CLAIMED' }
      if (input.tapSessionId) return { ok: false, reason: 'SESSION_ALREADY_USED' }
      throw err
    }
  }

  async markSending(id: string, txSignature: string, lastValidBlockHeight: bigint) {
    await this.prisma.claim.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'SENDING', txSignature, lastValidBlockHeight } })
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
      await tx.$executeRaw`
        UPDATE "Campaign" SET "claimedRaw" = "claimedRaw" - ${claim.amountRaw.toFixed(0)}::numeric, "updatedAt" = now()
        WHERE "id" = ${claim.campaignId}::uuid`
    })
  }

  async startTapSession(input: { campaignId: string; privyUserId: string; goal: number; seconds: number }) {
    return toSession(await this.prisma.tapRushSession.create({ data: { id: randomUUID(), ...input } }))
  }

  async countTapSessions(campaignId: string, privyUserId: string) {
    return this.prisma.tapRushSession.count({ where: { campaignId, privyUserId } })
  }

  async findTapSession(id: string) {
    const row = await this.prisma.tapRushSession.findUnique({ where: { id } })
    return row ? toSession(row) : null
  }

  async finishTapSession(id: string, result: { taps: number; qualified: boolean; finishedAt: Date }) {
    const { count } = await this.prisma.tapRushSession.updateMany({ where: { id, finishedAt: null }, data: result })
    if (count === 0) return null
    return toSession(await this.prisma.tapRushSession.findUniqueOrThrow({ where: { id } }))
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

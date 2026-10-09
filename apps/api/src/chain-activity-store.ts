import type { createPrismaClient } from './prisma-campaign-repo.ts'

/*
 * D-49 / D-50 / D-51: durable records of user-signed SKR tips, SKR boosts and verified ORE deploys.
 * Every confirmed record is keyed by its transaction signature (unique), so one onchain transfer or deploy can
 * never produce two tips, two boosts or two proofs — whatever the client retries.
 */

export type TxStatus = 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED'

export interface StoredTip {
  id: string
  senderPrivyUserId: string
  recipientPrivyUserId: string
  senderWallet: string
  recipientWallet: string
  clubId: string | null
  amountRaw: bigint
  cluster: string
  status: TxStatus
  signature: string | null
  failure: string | null
  createdAt: Date
  confirmedAt: Date | null
}

export interface StoredBoost {
  id: string
  campaignId: string
  payerPrivyUserId: string
  payerWallet: string
  destination: string
  amountRaw: bigint
  hours: number
  cluster: string
  status: TxStatus
  signature: string | null
  failure: string | null
  startsAt: Date | null
  endsAt: Date | null
  createdAt: Date
  confirmedAt: Date | null
}

export interface StoredOreDeploy {
  signature: string
  privyUserId: string
  wallet: string
  roundId: bigint
  squares: number[]
  amountPerSquare: bigint
  totalLamports: bigint
  slot: bigint
  deployedAt: Date
  campaignId: string | null
  createdAt: Date
}

export class SignatureReusedError extends Error {
  override name = 'SignatureReusedError'
}

type NewTip = Omit<StoredTip, 'status' | 'signature' | 'failure' | 'createdAt' | 'confirmedAt'>
type NewBoost = Omit<StoredBoost, 'status' | 'signature' | 'failure' | 'startsAt' | 'endsAt' | 'createdAt' | 'confirmedAt'>

export interface ChainActivityStore {
  createTip(t: NewTip): Promise<StoredTip>
  getTip(id: string): Promise<StoredTip | null>
  /** Records the signature before sending; throws SignatureReusedError if any record already holds it. */
  markTipSubmitted(id: string, signature: string): Promise<void>
  markTipConfirmed(id: string, at: Date): Promise<StoredTip>
  markTipFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string): Promise<void>
  tipsFor(privyUserId: string, limit: number): Promise<StoredTip[]>

  createBoost(b: NewBoost): Promise<StoredBoost>
  getBoost(id: string): Promise<StoredBoost | null>
  markBoostSubmitted(id: string, signature: string): Promise<void>
  /**
   * Activates a submitted boost exactly once: startsAt = max(now, the drop's latest active boost end),
   * endsAt = startsAt + hours. Re-activating a CONFIRMED boost returns it unchanged.
   */
  activateBoost(id: string, now: Date): Promise<StoredBoost>
  markBoostFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string): Promise<void>
  /** Drops with a boost window that contains `now` → their window end. */
  activeBoosts(campaignIds: string[], now: Date): Promise<Map<string, Date>>
  boostsBy(privyUserId: string, limit: number): Promise<StoredBoost[]>

  /** Saves a verified deploy once; `created: false` when the signature was already recorded (by anyone). */
  saveOreDeploy(d: Omit<StoredOreDeploy, 'createdAt'>): Promise<{ created: boolean; proof: StoredOreDeploy }>
  oreDeploysFor(privyUserId: string, limit: number): Promise<StoredOreDeploy[]>
}

const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000)
const later = (a: Date, b: Date | undefined) => (b && b > a ? b : a)

export class InMemoryChainActivityStore implements ChainActivityStore {
  private readonly tips = new Map<string, StoredTip>()
  private readonly boosts = new Map<string, StoredBoost>()
  private readonly deploys = new Map<string, StoredOreDeploy>()

  private signatureTaken(signature: string) {
    return [...this.tips.values(), ...this.boosts.values()].some((r) => r.signature === signature) || this.deploys.has(signature)
  }

  async createTip(t: NewTip) {
    const row: StoredTip = { ...t, status: 'PREPARED', signature: null, failure: null, createdAt: new Date(), confirmedAt: null }
    this.tips.set(row.id, row)
    return { ...row }
  }
  async getTip(id: string) {
    const r = this.tips.get(id)
    return r ? { ...r } : null
  }
  async markTipSubmitted(id: string, signature: string) {
    const r = this.tips.get(id)
    if (!r) throw new Error('tip not found')
    if (r.signature === signature) return
    if (this.signatureTaken(signature)) throw new SignatureReusedError('signature already recorded')
    Object.assign(r, { status: 'SUBMITTED', signature })
  }
  async markTipConfirmed(id: string, at: Date) {
    const r = this.tips.get(id)
    if (!r) throw new Error('tip not found')
    if (r.status !== 'CONFIRMED') Object.assign(r, { status: 'CONFIRMED', confirmedAt: at, failure: null })
    return { ...r }
  }
  async markTipFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string) {
    const r = this.tips.get(id)
    if (r && r.status !== 'CONFIRMED') Object.assign(r, { status, failure })
  }
  async tipsFor(privyUserId: string, limit: number) {
    return [...this.tips.values()]
      .filter((t) => t.senderPrivyUserId === privyUserId || t.recipientPrivyUserId === privyUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((t) => ({ ...t }))
  }

  async createBoost(b: NewBoost) {
    const row: StoredBoost = { ...b, status: 'PREPARED', signature: null, failure: null, startsAt: null, endsAt: null, createdAt: new Date(), confirmedAt: null }
    this.boosts.set(row.id, row)
    return { ...row }
  }
  async getBoost(id: string) {
    const r = this.boosts.get(id)
    return r ? { ...r } : null
  }
  async markBoostSubmitted(id: string, signature: string) {
    const r = this.boosts.get(id)
    if (!r) throw new Error('boost not found')
    if (r.signature === signature) return
    if (this.signatureTaken(signature)) throw new SignatureReusedError('signature already recorded')
    Object.assign(r, { status: 'SUBMITTED', signature })
  }
  async activateBoost(id: string, now: Date) {
    const r = this.boosts.get(id)
    if (!r) throw new Error('boost not found')
    if (r.status === 'CONFIRMED') return { ...r }
    const currentEnd = [...this.boosts.values()]
      .filter((b) => b.campaignId === r.campaignId && b.status === 'CONFIRMED' && b.endsAt && b.endsAt > now)
      .map((b) => b.endsAt!)
      .sort((a, b) => b.getTime() - a.getTime())[0]
    const startsAt = later(now, currentEnd)
    Object.assign(r, { status: 'CONFIRMED', startsAt, endsAt: addHours(startsAt, r.hours), confirmedAt: now, failure: null })
    return { ...r }
  }
  async markBoostFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string) {
    const r = this.boosts.get(id)
    if (r && r.status !== 'CONFIRMED') Object.assign(r, { status, failure })
  }
  async activeBoosts(campaignIds: string[], now: Date) {
    const out = new Map<string, Date>()
    for (const b of this.boosts.values()) {
      if (!campaignIds.includes(b.campaignId) || b.status !== 'CONFIRMED' || !b.startsAt || !b.endsAt) continue
      if (b.startsAt <= now && b.endsAt > now) out.set(b.campaignId, later(b.endsAt, out.get(b.campaignId)))
      // A queued (future) window extends an active one.
      else if (b.startsAt > now && out.has(b.campaignId)) out.set(b.campaignId, later(b.endsAt, out.get(b.campaignId)))
    }
    return out
  }
  async boostsBy(privyUserId: string, limit: number) {
    return [...this.boosts.values()]
      .filter((b) => b.payerPrivyUserId === privyUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((b) => ({ ...b }))
  }

  async saveOreDeploy(d: Omit<StoredOreDeploy, 'createdAt'>) {
    const existing = this.deploys.get(d.signature)
    if (existing) return { created: false, proof: { ...existing } }
    const row = { ...d, createdAt: new Date() }
    this.deploys.set(d.signature, row)
    return { created: true, proof: { ...row } }
  }
  async oreDeploysFor(privyUserId: string, limit: number) {
    return [...this.deploys.values()]
      .filter((d) => d.privyUserId === privyUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((d) => ({ ...d }))
  }
}

type Prisma = ReturnType<typeof createPrismaClient>
type Dec = { toFixed(n: number): string }
const big = (d: Dec) => BigInt(d.toFixed(0))
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'

function toTip(r: Omit<StoredTip, 'amountRaw' | 'status'> & { amountRaw: Dec; status: string }): StoredTip {
  return { ...r, amountRaw: big(r.amountRaw), status: r.status as TxStatus }
}
function toBoost(r: Omit<StoredBoost, 'amountRaw' | 'status'> & { amountRaw: Dec; status: string }): StoredBoost {
  return { ...r, amountRaw: big(r.amountRaw), status: r.status as TxStatus }
}
function toDeploy(r: Omit<StoredOreDeploy, 'roundId' | 'amountPerSquare' | 'totalLamports' | 'slot'> & { roundId: Dec; amountPerSquare: Dec; totalLamports: Dec; slot: Dec }): StoredOreDeploy {
  return { ...r, roundId: big(r.roundId), amountPerSquare: big(r.amountPerSquare), totalLamports: big(r.totalLamports), slot: big(r.slot) }
}

export class PrismaChainActivityStore implements ChainActivityStore {
  constructor(private readonly prisma: Prisma) {}

  /** A signature may back one tip, one boost or one deploy proof — checked across all three tables. */
  private async signatureTaken(signature: string, except: { tip?: string; boost?: string }) {
    const [tip, boost, proof] = await Promise.all([
      this.prisma.skrTip.findUnique({ where: { signature } }),
      this.prisma.skrBoost.findUnique({ where: { signature } }),
      this.prisma.oreDeployProof.findUnique({ where: { signature } }),
    ])
    return Boolean((tip && tip.id !== except.tip) || (boost && boost.id !== except.boost) || proof)
  }

  async createTip(t: NewTip) {
    return toTip(await this.prisma.skrTip.create({ data: { ...t, amountRaw: t.amountRaw.toString(), status: 'PREPARED' } }))
  }
  async getTip(id: string) {
    const r = await this.prisma.skrTip.findUnique({ where: { id } })
    return r ? toTip(r) : null
  }
  async markTipSubmitted(id: string, signature: string) {
    if (await this.signatureTaken(signature, { tip: id })) throw new SignatureReusedError('signature already recorded')
    try {
      await this.prisma.skrTip.update({ where: { id }, data: { status: 'SUBMITTED', signature } })
    } catch (err) {
      if (isUniqueViolation(err)) throw new SignatureReusedError('signature already recorded')
      throw err
    }
  }
  async markTipConfirmed(id: string, at: Date) {
    await this.prisma.skrTip.updateMany({ where: { id, status: { not: 'CONFIRMED' } }, data: { status: 'CONFIRMED', confirmedAt: at, failure: null } })
    return toTip(await this.prisma.skrTip.findUniqueOrThrow({ where: { id } }))
  }
  async markTipFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string) {
    await this.prisma.skrTip.updateMany({ where: { id, status: { not: 'CONFIRMED' } }, data: { status, failure } })
  }
  async tipsFor(privyUserId: string, limit: number) {
    const rows = await this.prisma.skrTip.findMany({
      where: { OR: [{ senderPrivyUserId: privyUserId }, { recipientPrivyUserId: privyUserId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(toTip)
  }

  async createBoost(b: NewBoost) {
    return toBoost(await this.prisma.skrBoost.create({ data: { ...b, amountRaw: b.amountRaw.toString(), status: 'PREPARED' } }))
  }
  async getBoost(id: string) {
    const r = await this.prisma.skrBoost.findUnique({ where: { id } })
    return r ? toBoost(r) : null
  }
  async markBoostSubmitted(id: string, signature: string) {
    if (await this.signatureTaken(signature, { boost: id })) throw new SignatureReusedError('signature already recorded')
    try {
      await this.prisma.skrBoost.update({ where: { id }, data: { status: 'SUBMITTED', signature } })
    } catch (err) {
      if (isUniqueViolation(err)) throw new SignatureReusedError('signature already recorded')
      throw err
    }
  }
  async activateBoost(id: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.skrBoost.findUniqueOrThrow({ where: { id } })
      // One activation at a time per drop, so two boosts can't both start from the same "current end".
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`boost:${row.campaignId}`}))`
      const fresh = await tx.skrBoost.findUniqueOrThrow({ where: { id } })
      if (fresh.status === 'CONFIRMED') return toBoost(fresh)
      const current = await tx.skrBoost.findFirst({ where: { campaignId: row.campaignId, status: 'CONFIRMED', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' } })
      const startsAt = later(now, current?.endsAt ?? undefined)
      return toBoost(await tx.skrBoost.update({ where: { id }, data: { status: 'CONFIRMED', startsAt, endsAt: addHours(startsAt, fresh.hours), confirmedAt: now, failure: null } }))
    })
  }
  async markBoostFailed(id: string, status: 'FAILED' | 'EXPIRED', failure: string) {
    await this.prisma.skrBoost.updateMany({ where: { id, status: { not: 'CONFIRMED' } }, data: { status, failure } })
  }
  async activeBoosts(campaignIds: string[], now: Date) {
    const out = new Map<string, Date>()
    if (!campaignIds.length) return out
    const rows = await this.prisma.skrBoost.findMany({ where: { campaignId: { in: campaignIds }, status: 'CONFIRMED', endsAt: { gt: now } } })
    const active = new Set(rows.filter((r) => r.startsAt && r.startsAt <= now).map((r) => r.campaignId))
    for (const r of rows) if (active.has(r.campaignId) && r.endsAt) out.set(r.campaignId, later(r.endsAt, out.get(r.campaignId)))
    return out
  }
  async boostsBy(privyUserId: string, limit: number) {
    const rows = await this.prisma.skrBoost.findMany({ where: { payerPrivyUserId: privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toBoost)
  }

  async saveOreDeploy(d: Omit<StoredOreDeploy, 'createdAt'>) {
    const data = { ...d, roundId: d.roundId.toString(), amountPerSquare: d.amountPerSquare.toString(), totalLamports: d.totalLamports.toString(), slot: d.slot.toString() }
    try {
      return { created: true, proof: toDeploy(await this.prisma.oreDeployProof.create({ data })) }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      return { created: false, proof: toDeploy(await this.prisma.oreDeployProof.findUniqueOrThrow({ where: { signature: d.signature } })) }
    }
  }
  async oreDeploysFor(privyUserId: string, limit: number) {
    const rows = await this.prisma.oreDeployProof.findMany({ where: { privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toDeploy)
  }
}

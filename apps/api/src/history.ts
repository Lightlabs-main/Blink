import { randomUUID } from 'node:crypto'

import type { createPrismaClient } from './prisma-campaign-repo.ts'

/** D-38: a send from the user's Blink stock wallet. */
export interface StoredTransfer {
  id: string
  privyUserId: string
  cluster: string
  asset: string
  symbol: string
  decimals: number
  amountRaw: bigint
  toAddress: string
  signature: string
  status: 'CONFIRMED' | 'PENDING' | 'FAILED'
  createdAt: Date
}

export interface TransferStore {
  record(t: Omit<StoredTransfer, 'id' | 'createdAt'>): Promise<StoredTransfer>
  listForUser(privyUserId: string, limit: number): Promise<StoredTransfer[]>
}

export class InMemoryTransferStore implements TransferStore {
  private readonly rows: StoredTransfer[] = []
  async record(t: Omit<StoredTransfer, 'id' | 'createdAt'>) {
    const row = { ...t, id: randomUUID(), createdAt: new Date() }
    this.rows.push(row)
    return row
  }
  async listForUser(privyUserId: string, limit: number) {
    return this.rows.filter((r) => r.privyUserId === privyUserId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit)
  }
}

export class PrismaTransferStore implements TransferStore {
  constructor(private readonly prisma: ReturnType<typeof createPrismaClient>) {}
  async record(t: Omit<StoredTransfer, 'id' | 'createdAt'>) {
    const row = await this.prisma.transfer.create({ data: { ...t, id: randomUUID(), amountRaw: t.amountRaw.toString() } })
    return toTransfer(row)
  }
  async listForUser(privyUserId: string, limit: number) {
    const rows = await this.prisma.transfer.findMany({ where: { privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toTransfer)
  }
}

function toTransfer(r: { id: string; privyUserId: string; cluster: string; asset: string; symbol: string; decimals: number; amountRaw: { toFixed(n: number): string }; toAddress: string; signature: string; status: string; createdAt: Date }): StoredTransfer {
  return { ...r, amountRaw: BigInt(r.amountRaw.toFixed(0)), status: r.status as StoredTransfer['status'] }
}

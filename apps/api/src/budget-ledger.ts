import { assertMainnetSpendAllowed, type BlinkEnv, checkBudget } from '@blink/config'
import type { SolanaCluster } from '@blink/domain'

import type { createPrismaClient } from './prisma-campaign-repo.ts'

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError'
}

/**
 * MASTER_PROMPT §7: every Blink-funded lamport is RESERVED before a transaction is sent and settled afterwards.
 * On mainnet the reservation is refused when spent + reserved + next > budget. Other clusters are recorded only.
 */
export interface BudgetLedger {
  reserve(entry: { idempotencyKey: string; kind: string; lamports: bigint; campaignId: string }): Promise<void>
  settle(idempotencyKey: string, state: 'SPENT' | 'RELEASED', txSignature?: string): Promise<void>
}

export class InMemoryBudgetLedger implements BudgetLedger {
  readonly entries = new Map<string, { lamports: bigint; state: string; txSignature?: string }>()

  constructor(private readonly env: BlinkEnv) {}

  async reserve(entry: { idempotencyKey: string; kind: string; lamports: bigint; campaignId: string }) {
    if (this.entries.has(entry.idempotencyKey)) return
    guardMainnet(this.env, this.total(), entry.lamports)
    this.entries.set(entry.idempotencyKey, { lamports: entry.lamports, state: 'RESERVED' })
  }

  async settle(idempotencyKey: string, state: 'SPENT' | 'RELEASED', txSignature?: string) {
    const e = this.entries.get(idempotencyKey)
    if (e?.state === 'RESERVED') Object.assign(e, { state, txSignature })
  }

  private total() {
    let spent = 0n
    let reserved = 0n
    for (const e of this.entries.values()) {
      if (e.state === 'SPENT') spent += e.lamports
      if (e.state === 'RESERVED') reserved += e.lamports
    }
    return { spent, reserved }
  }
}

const DB_CLUSTER = { localnet: 'localnet', devnet: 'devnet', 'mainnet-beta': 'mainnet_beta' } as const

export class PrismaBudgetLedger implements BudgetLedger {
  constructor(
    private readonly prisma: ReturnType<typeof createPrismaClient>,
    private readonly env: BlinkEnv,
  ) {}

  async reserve(entry: { idempotencyKey: string; kind: string; lamports: bigint; campaignId: string }) {
    const cluster = DB_CLUSTER[this.env.SOLANA_CLUSTER as SolanaCluster]
    await this.prisma.$transaction(async (tx) => {
      if (await tx.budgetLedgerEntry.findUnique({ where: { idempotencyKey: entry.idempotencyKey } })) return
      if (this.env.SOLANA_CLUSTER === 'mainnet-beta') {
        // Serialize mainnet reservations so two payouts cannot both pass the same budget check.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('blink-budget-mainnet'))`
        const sums = await tx.budgetLedgerEntry.groupBy({ by: ['state'], where: { cluster }, _sum: { lamports: true } })
        const sum = (s: string) => sums.find((r) => r.state === s)?._sum.lamports ?? 0n
        guardMainnet(this.env, { spent: sum('SPENT'), reserved: sum('RESERVED') }, entry.lamports)
      }
      await tx.budgetLedgerEntry.create({
        data: {
          cluster,
          kind: entry.kind,
          state: 'RESERVED',
          lamports: entry.lamports,
          campaignId: entry.campaignId,
          idempotencyKey: entry.idempotencyKey,
        },
      })
    })
  }

  async settle(idempotencyKey: string, state: 'SPENT' | 'RELEASED', txSignature?: string) {
    await this.prisma.budgetLedgerEntry.updateMany({
      where: { idempotencyKey, state: 'RESERVED' },
      data: { state, txSignature: state === 'SPENT' ? (txSignature ?? null) : null },
    })
  }
}

function guardMainnet(env: BlinkEnv, totals: { spent: bigint; reserved: bigint }, next: bigint) {
  if (env.SOLANA_CLUSTER !== 'mainnet-beta') return
  assertMainnetSpendAllowed(env)
  const decision = checkBudget({
    spentLamports: totals.spent,
    reservedLamports: totals.reserved,
    estimatedNextOperationLamports: next,
    configuredBudgetLamports: env.MAINNET_BUDGET_LAMPORTS,
  })
  if (!decision.allowed) throw new BudgetExceededError(decision.reason)
}

import { randomUUID } from 'node:crypto'

import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import { afterAll, describe, expect, it } from 'vitest'

import { createPrismaClient, PrismaCampaignRepository } from './prisma-campaign-repo.ts'
import { PrismaClaimRepository } from './prisma-claim-repo.ts'

/*
 * Pre-mainnet gate: solvency and idempotency under real concurrency (Postgres row locks / conditional updates).
 * Runs only when SOCIAL_TEST_DATABASE_URL points at a THROWAWAY, fully migrated database.
 */
const url = process.env.SOCIAL_TEST_DATABASE_URL

describe.skipIf(!url)('claim reservations under concurrency (Postgres)', () => {
  const prisma = url ? createPrismaClient(url) : (null as never)
  afterAll(async () => {
    await prisma?.$disconnect()
  })

  async function liveCampaign(allowanceRaw: bigint, rewardRaw: bigint) {
    const campaigns = new PrismaCampaignRepository(prisma)
    const id = randomUUID()
    await campaigns.create({
      id, type: 'EARLY_CLAIM', cluster: 'devnet', creatorPrivyUserId: 'creator', creatorWallet: '11111111111111111111111111111112',
      mint: SUPPORTED_XSTOCKS[0]!.mint, xstockSymbol: 'NVDAx', campaignSeed: id.slice(0, 8), campaignTokenAccount: `acct-${id}`,
      allowanceRaw, rewardPerClaimRaw: rewardRaw, tapRush: null,
    })
    await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
    return { campaigns, id }
  }

  it('20 simultaneous claims on a 5-reward drop: exactly 5 reserved, never over the allowance', async () => {
    const claims = new PrismaClaimRepository(prisma)
    const { campaigns, id } = await liveCampaign(500n, 100n)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claims.reserve({ campaignId: id, privyUserId: `user-${i}`, recipientWallet: `wallet-${i}`, amountRaw: 100n, tapSessionId: null }).catch((e: Error) => ({ ok: false as const, reason: e.message })),
      ),
    )
    const reasons = results.filter((r) => !r.ok).map((r) => (r.ok ? '' : r.reason.slice(0, 120)))
    if (results.filter((r) => r.ok).length !== 5) console.log('reasons', [...new Set(reasons)])
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'EXHAUSTED')).toBe(true)
    const c = await campaigns.findById(id)
    expect(c!.claimedRaw).toBe(500n)
    expect(c!.claimedRaw <= c!.allowanceRaw).toBe(true)
  })

  it('a double tap (10 parallel claims by one person) creates one claim only', async () => {
    const claims = new PrismaClaimRepository(prisma)
    const { campaigns, id } = await liveCampaign(1000n, 100n)
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claims.reserve({ campaignId: id, privyUserId: 'same-user', recipientWallet: 'same-wallet', amountRaw: 100n, tapSessionId: null }).catch((e: Error) => ({ ok: false as const, reason: e.message })),
      ),
    )
    const ids = new Set(results.filter((r) => r.ok).map((r) => (r.ok ? r.claim.id : '')))
    expect(ids.size).toBe(1)
    expect(results.filter((r) => r.ok && r.fresh)).toHaveLength(1)
    expect((await campaigns.findById(id))!.claimedRaw).toBe(100n)
    expect(await prisma.claim.count({ where: { campaignId: id } })).toBe(1)
  })
})

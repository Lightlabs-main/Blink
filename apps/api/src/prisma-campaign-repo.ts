import type { CampaignStatus, QuestRequirements, SolanaCluster } from '@blink/domain'
import { PrismaPg } from '@prisma/adapter-pg'

import { assertTransition, type CampaignRepository, type NewCampaign, type StoredCampaign } from './campaign-repo.ts'
import { type Campaign, PrismaClient, SolanaCluster as DbCluster } from './generated/prisma/client.ts'

const toDbCluster: Record<SolanaCluster, DbCluster> = {
  localnet: DbCluster.localnet,
  devnet: DbCluster.devnet,
  'mainnet-beta': DbCluster.mainnet_beta,
}
const fromDbCluster: Record<DbCluster, SolanaCluster> = {
  localnet: 'localnet',
  devnet: 'devnet',
  mainnet_beta: 'mainnet-beta',
}

export function toStored(row: Campaign): StoredCampaign {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    cluster: fromDbCluster[row.cluster],
    creatorPrivyUserId: row.creatorPrivyUserId,
    creatorWallet: row.creatorWallet,
    mint: row.mint,
    xstockSymbol: row.xstockSymbol,
    campaignSeed: row.campaignSeed,
    campaignTokenAccount: row.campaignTokenAccount,
    delegateAddress: row.delegateAddress,
    delegateWalletRef: row.delegateWalletRef,
    // Decimal(20,0) → exact integer string → bigint; never via Number.
    allowanceRaw: BigInt(row.allowanceRaw.toFixed(0)),
    rewardPerClaimRaw: row.rewardPerClaimRaw === null ? null : BigInt(row.rewardPerClaimRaw.toFixed(0)),
    claimedRaw: BigInt(row.claimedRaw.toFixed(0)),
    tapRush: row.tapGoal !== null && row.tapSeconds !== null ? { goal: row.tapGoal, seconds: row.tapSeconds } : null,
    pauseReason: row.pauseReason,
    requirements: (row.requirementsJson as QuestRequirements | null) ?? null,
    requirementsHash: row.requirementsHash,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    clubId: row.clubId,
    membersOnly: row.membersOnly,
    createdAt: row.createdAt,
  }
}

export function createPrismaClient(databaseUrl: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) })
}

export class PrismaCampaignRepository implements CampaignRepository {
  constructor(private readonly prisma: ReturnType<typeof createPrismaClient>) {}

  async create(c: NewCampaign): Promise<StoredCampaign> {
    const row = await this.prisma.campaign.create({
      data: {
        id: c.id,
        type: c.type,
        cluster: toDbCluster[c.cluster],
        creatorPrivyUserId: c.creatorPrivyUserId,
        creatorWallet: c.creatorWallet,
        mint: c.mint,
        xstockSymbol: c.xstockSymbol,
        campaignSeed: c.campaignSeed,
        campaignTokenAccount: c.campaignTokenAccount,
        allowanceRaw: c.allowanceRaw.toString(),
        rewardPerClaimRaw: c.rewardPerClaimRaw?.toString() ?? null,
        tapGoal: c.tapRush?.goal ?? null,
        tapSeconds: c.tapRush?.seconds ?? null,
        requirementsJson: c.requirements ? (c.requirements as object) : undefined,
        requirementsHash: c.requirementsHash ?? null,
        startsAt: c.startsAt ?? null,
        endsAt: c.endsAt ?? null,
        clubId: c.clubId ?? null,
        membersOnly: Boolean(c.membersOnly && c.clubId),
      },
    })
    return toStored(row)
  }

  async findById(id: string): Promise<StoredCampaign | null> {
    const row = await this.prisma.campaign.findUnique({ where: { id } })
    return row ? toStored(row) : null
  }

  async listByStatus(status: CampaignStatus, limit: number): Promise<StoredCampaign[]> {
    const rows = await this.prisma.campaign.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: limit })
    return rows.map(toStored)
  }

  async listByCreator(creatorPrivyUserId: string, limit: number): Promise<StoredCampaign[]> {
    const rows = await this.prisma.campaign.findMany({
      where: { creatorPrivyUserId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(toStored)
  }

  async setDelegate(id: string, delegate: { address: string; walletRef: string }): Promise<StoredCampaign> {
    // Only fill an empty delegate: a campaign never silently switches delegates (§14).
    await this.prisma.campaign.updateMany({
      where: { id, delegateAddress: null },
      data: { delegateAddress: delegate.address, delegateWalletRef: delegate.walletRef },
    })
    const row = await this.prisma.campaign.findUniqueOrThrow({ where: { id } })
    return toStored(row)
  }

  async transitionStatus(id: string, from: CampaignStatus, to: CampaignStatus, pauseReason?: string): Promise<StoredCampaign | null> {
    assertTransition(from, to)
    const { count } = await this.prisma.campaign.updateMany({
      where: { id, status: from },
      data: { status: to, pauseReason: to === 'PAUSED' ? (pauseReason ?? null) : null },
    })
    if (count === 0) return null
    return toStored(await this.prisma.campaign.findUniqueOrThrow({ where: { id } }))
  }
}

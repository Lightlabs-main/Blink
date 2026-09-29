import type { SolanaCluster } from '@blink/domain'
import { PrismaPg } from '@prisma/adapter-pg'

import type { CampaignRepository, NewCampaign, StoredCampaign } from './campaign-repo.ts'
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

function toStored(row: Campaign): StoredCampaign {
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
    // Decimal(20,0) → exact integer string → bigint; never via Number.
    allowanceRaw: BigInt(row.allowanceRaw.toFixed(0)),
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
      },
    })
    return toStored(row)
  }

  async findById(id: string): Promise<StoredCampaign | null> {
    const row = await this.prisma.campaign.findUnique({ where: { id } })
    return row ? toStored(row) : null
  }
}

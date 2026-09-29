import type { CampaignStatus, CampaignSummary, CampaignType, SolanaCluster } from '@blink/domain'

export interface NewCampaign {
  id: string
  type: CampaignType
  cluster: SolanaCluster
  creatorPrivyUserId: string
  creatorWallet: string
  mint: string
  xstockSymbol: string
  campaignSeed: string
  campaignTokenAccount: string
  allowanceRaw: bigint
}

export interface StoredCampaign extends NewCampaign {
  status: CampaignStatus
  delegateAddress: string | null
  createdAt: Date
}

export interface CampaignRepository {
  create(campaign: NewCampaign): Promise<StoredCampaign>
  findById(id: string): Promise<StoredCampaign | null>
}

export function toSummary(c: StoredCampaign): CampaignSummary {
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    cluster: c.cluster,
    creatorWallet: c.creatorWallet,
    mint: c.mint,
    xstockSymbol: c.xstockSymbol,
    campaignSeed: c.campaignSeed,
    campaignTokenAccount: c.campaignTokenAccount,
    delegateAddress: c.delegateAddress,
    allowanceRaw: c.allowanceRaw.toString(),
    createdAt: c.createdAt.toISOString(),
  }
}

/** Test/dev repository. Not for production data. */
export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly rows = new Map<string, StoredCampaign>()

  async create(campaign: NewCampaign): Promise<StoredCampaign> {
    for (const row of this.rows.values()) {
      if (row.cluster === campaign.cluster && row.campaignTokenAccount === campaign.campaignTokenAccount) {
        throw new Error('campaign token account already registered')
      }
    }
    const stored: StoredCampaign = { ...campaign, status: 'DRAFT', delegateAddress: null, createdAt: new Date() }
    this.rows.set(campaign.id, stored)
    return stored
  }

  async findById(id: string): Promise<StoredCampaign | null> {
    return this.rows.get(id) ?? null
  }
}

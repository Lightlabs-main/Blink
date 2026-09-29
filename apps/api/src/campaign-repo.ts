import { type CampaignStatus, type CampaignSummary, type CampaignType, canTransition, type SolanaCluster } from '@blink/domain'

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
  /** Provider reference for the delegate wallet (e.g. Privy wallet id). Never exposed to clients. */
  delegateWalletRef: string | null
  createdAt: Date
}

export class InvalidTransitionError extends Error {
  override name = 'InvalidTransitionError'
}

export function assertTransition(from: CampaignStatus, to: CampaignStatus) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(`cannot move campaign from ${from} to ${to}`)
}

export interface CampaignRepository {
  create(campaign: NewCampaign): Promise<StoredCampaign>
  findById(id: string): Promise<StoredCampaign | null>
  /** Newest first. */
  listByStatus(status: CampaignStatus, limit: number): Promise<StoredCampaign[]>
  /** Newest first. */
  listByCreator(creatorPrivyUserId: string, limit: number): Promise<StoredCampaign[]>
  /** Sets the delegate once; returns the stored campaign (existing delegate wins on races). */
  setDelegate(id: string, delegate: { address: string; walletRef: string }): Promise<StoredCampaign>
  /** Compare-and-set status along an allowed transition; returns null if the status was not `from`. */
  transitionStatus(id: string, from: CampaignStatus, to: CampaignStatus): Promise<StoredCampaign | null>
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
    const stored: StoredCampaign = {
      ...campaign,
      status: 'DRAFT',
      delegateAddress: null,
      delegateWalletRef: null,
      createdAt: new Date(),
    }
    this.rows.set(campaign.id, stored)
    return stored
  }

  async findById(id: string): Promise<StoredCampaign | null> {
    return this.rows.get(id) ?? null
  }

  async listByStatus(status: CampaignStatus, limit: number): Promise<StoredCampaign[]> {
    return this.newestFirst().filter((c) => c.status === status).slice(0, limit)
  }

  async listByCreator(creatorPrivyUserId: string, limit: number): Promise<StoredCampaign[]> {
    return this.newestFirst()
      .filter((c) => c.creatorPrivyUserId === creatorPrivyUserId)
      .slice(0, limit)
  }

  async setDelegate(id: string, delegate: { address: string; walletRef: string }): Promise<StoredCampaign> {
    const row = this.rows.get(id)
    if (!row) throw new Error('campaign not found')
    if (!row.delegateAddress) {
      row.delegateAddress = delegate.address
      row.delegateWalletRef = delegate.walletRef
    }
    return row
  }

  async transitionStatus(id: string, from: CampaignStatus, to: CampaignStatus): Promise<StoredCampaign | null> {
    assertTransition(from, to)
    const row = this.rows.get(id)
    if (!row || row.status !== from) return null
    row.status = to
    return row
  }

  private newestFirst(): StoredCampaign[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }
}

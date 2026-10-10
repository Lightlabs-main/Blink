import { type CampaignStatus, type CampaignSummary, type CampaignType, canTransition, type QuestRequirements, type SolanaCluster, type TapRushRules } from '@blink/domain'

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
  /** D-13: fixed amount per recipient; null = not claimable. */
  rewardPerClaimRaw: bigint | null
  tapRush: TapRushRules | null
  /** D-21: Verified Quest requirements + SHA-256 of their canonical JSON; frozen at creation. */
  requirements?: QuestRequirements | null
  requirementsHash?: string | null
  /** D-21: optional campaign window. */
  startsAt?: Date | null
  endsAt?: Date | null
  /** D-40: the club this drop is posted in. */
  clubId?: string | null
  /** D-41: only members of clubId can take part. */
  membersOnly?: boolean
  /** Gift drop to named people: only these Privy users can claim (never exposed to clients). Empty = open. */
  recipientIds?: string[]
}

export interface StoredCampaign extends NewCampaign {
  status: CampaignStatus
  delegateAddress: string | null
  /** Provider reference for the delegate wallet (e.g. Privy wallet id). Never exposed to clients. */
  delegateWalletRef: string | null
  /** Reserved + paid; the claim repository keeps it <= allowanceRaw. */
  claimedRaw: bigint
  pauseReason: string | null
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
  /** Newest first. `only` narrows to one network and to drops that have not ended at `endsAfter`. */
  listByStatus(status: CampaignStatus, limit: number, only?: { cluster?: SolanaCluster; endsAfter?: Date }): Promise<StoredCampaign[]>
  /** Newest first. */
  listByCreator(creatorPrivyUserId: string, limit: number): Promise<StoredCampaign[]>
  /** LIVE gift drops on `cluster` that name this person as a recipient, newest first. */
  listForRecipient(privyUserId: string, cluster: SolanaCluster, limit: number): Promise<StoredCampaign[]>
  /** Sets the delegate once; returns the stored campaign (existing delegate wins on races). */
  setDelegate(id: string, delegate: { address: string; walletRef: string }): Promise<StoredCampaign>
  /** Compare-and-set status along an allowed transition; returns null if the status was not `from`. */
  transitionStatus(id: string, from: CampaignStatus, to: CampaignStatus, pauseReason?: string): Promise<StoredCampaign | null>
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
    rewardPerClaimRaw: c.rewardPerClaimRaw?.toString() ?? null,
    claimedRaw: c.claimedRaw.toString(),
    tapRush: c.tapRush,
    pauseReason: c.pauseReason,
    requirements: c.requirements ?? null,
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    clubId: c.clubId ?? null,
    membersOnly: Boolean(c.membersOnly && c.clubId),
    createdAt: c.createdAt.toISOString(),
    recipientCount: c.recipientIds?.length ?? 0,
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
      claimedRaw: 0n,
      pauseReason: null,
      createdAt: new Date(),
    }
    this.rows.set(campaign.id, stored)
    return stored
  }

  async findById(id: string): Promise<StoredCampaign | null> {
    return this.rows.get(id) ?? null
  }

  async listByStatus(status: CampaignStatus, limit: number, only?: { cluster?: SolanaCluster; endsAfter?: Date }): Promise<StoredCampaign[]> {
    return this.newestFirst()
      .filter((c) => c.status === status)
      .filter((c) => !only?.cluster || c.cluster === only.cluster)
      .filter((c) => !only?.endsAfter || !c.endsAt || c.endsAt.getTime() > only.endsAfter.getTime())
      .slice(0, limit)
  }

  async listForRecipient(privyUserId: string, cluster: SolanaCluster, limit: number): Promise<StoredCampaign[]> {
    return this.newestFirst()
      .filter((c) => c.status === 'LIVE' && c.cluster === cluster && (c.recipientIds ?? []).includes(privyUserId))
      .slice(0, limit)
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

  async transitionStatus(id: string, from: CampaignStatus, to: CampaignStatus, pauseReason?: string): Promise<StoredCampaign | null> {
    assertTransition(from, to)
    const row = this.rows.get(id)
    if (!row || row.status !== from) return null
    row.status = to
    row.pauseReason = to === 'PAUSED' ? (pauseReason ?? null) : null
    return row
  }

  /** For InMemoryClaimRepository: the live row, mutated in place like a database row. */
  row(id: string): StoredCampaign | undefined {
    return this.rows.get(id)
  }

  private newestFirst(): StoredCampaign[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }
}

import type { BlinkEnv } from '@blink/config'
import { isClaimableType, TAP_RUSH_LIMITS, type TapRushSessionSummary } from '@blink/domain'

import type { AuthContext, AuthVerifier } from './auth.ts'
import type { CampaignRepository, StoredCampaign } from './campaign-repo.ts'
import type { ClaimRepository, StoredClaim } from './claim-repo.ts'
import { ClaimError, type PayoutService } from './payout-service.ts'

/** A RESERVED claim older than this was abandoned before signing (e.g. a restart) and is released. */
const STALE_RESERVATION_MS = 120_000
/** The client's countdown may finish slightly early relative to the server clock. */
const TAP_RUSH_EARLY_GRACE_MS = 500
/** Results submitted much later than the round are not accepted. */
const TAP_RUSH_LATE_LIMIT_MS = 120_000

/**
 * Recipient claims and Tap Rush rounds (DECISIONS D-13, owner-approved ASSUMPTIONS):
 *  - fixed amount per person; first come until the pool is used up; one reward per account and per wallet;
 *  - the creator cannot claim their own drop; rewards go to the user's Privy embedded wallet only;
 *  - Tap Rush: a server-timed round; `goal` taps within `seconds` qualifies for one claim.
 */
export class ClaimService {
  constructor(
    private readonly deps: {
      env: BlinkEnv
      auth: AuthVerifier
      campaigns: CampaignRepository
      claims: ClaimRepository
      payouts?: PayoutService
    },
  ) {}

  async startTapRush(auth: AuthContext, campaignId: string): Promise<TapRushSessionSummary> {
    const campaign = await this.claimableCampaign(auth, campaignId)
    if (campaign.type !== 'TAP_RUSH' || !campaign.tapRush) throw new ClaimError('NOT_TAP_RUSH', 'this drop is not a Tap Rush')
    const existing = await this.current(await this.deps.claims.findForUser(campaign.id, auth.privyUserId))
    if (existing && existing.status !== 'FAILED') throw new ClaimError('ALREADY_CLAIMED', 'you already earned stock from this drop')
    this.requireLiveWithRoom(campaign)
    const used = await this.deps.claims.countTapSessions(campaign.id, auth.privyUserId)
    if (used >= TAP_RUSH_LIMITS.maxAttempts) throw new ClaimError('NO_ATTEMPTS_LEFT', 'you have used all your tries for this drop', 429)
    const s = await this.deps.claims.startTapSession({ campaignId: campaign.id, privyUserId: auth.privyUserId, ...campaign.tapRush })
    return {
      id: s.id,
      campaignId: s.campaignId,
      goal: s.goal,
      seconds: s.seconds,
      startedAt: s.startedAt.toISOString(),
      attemptsLeft: TAP_RUSH_LIMITS.maxAttempts - used - 1,
    }
  }

  async finishTapRush(auth: AuthContext, campaignId: string, input: { sessionId: string; taps: number }) {
    const session = await this.deps.claims.findTapSession(input.sessionId)
    if (!session || session.campaignId !== campaignId || session.privyUserId !== auth.privyUserId) {
      throw new ClaimError('SESSION_NOT_FOUND', 'this round was not found', 404)
    }
    if (session.finishedAt) throw new ClaimError('SESSION_FINISHED', 'this round already ended')

    const now = new Date()
    const elapsed = now.getTime() - session.startedAt.getTime()
    const roundMs = session.seconds * 1000
    const inTime = elapsed >= roundMs - TAP_RUSH_EARLY_GRACE_MS && elapsed <= roundMs + TAP_RUSH_LATE_LIMIT_MS
    const plausible = input.taps <= session.seconds * TAP_RUSH_LIMITS.maxTapsPerSecond
    const qualified = inTime && plausible && input.taps >= session.goal
    const finished = await this.deps.claims.finishTapSession(session.id, { taps: input.taps, qualified, finishedAt: now })
    if (!finished) throw new ClaimError('SESSION_FINISHED', 'this round already ended')
    if (!inTime) throw new ClaimError('ROUND_TIMING_INVALID', 'that round did not last the full time — please play again', 422)
    if (!plausible) throw new ClaimError('ROUND_REJECTED', 'that result was not accepted', 422)
    const used = await this.deps.claims.countTapSessions(campaignId, auth.privyUserId)
    return { qualified, taps: input.taps, goal: session.goal, attemptsLeft: Math.max(0, TAP_RUSH_LIMITS.maxAttempts - used) }
  }

  async claim(auth: AuthContext, campaignId: string, input: { tapSessionId?: string }): Promise<StoredClaim> {
    const campaign = await this.claimableCampaign(auth, campaignId)

    // Idempotent: an existing claim is reported (and advanced), never paid twice.
    const existing = await this.current(await this.deps.claims.findForUser(campaign.id, auth.privyUserId))
    if (existing && existing.status !== 'FAILED') return existing

    this.requireLiveWithRoom(campaign)
    const [recipient] = await this.deps.auth.getEmbeddedSolanaWallets(auth.privyUserId)
    if (!recipient) throw new ClaimError('NO_STOCK_WALLET', 'your Blink wallet is still being created — try again in a moment')
    if (recipient === campaign.creatorWallet) throw new ClaimError('OWN_CAMPAIGN', 'you cannot claim your own drop', 403)

    let tapSessionId: string | null = null
    if (campaign.type === 'TAP_RUSH') {
      const session = input.tapSessionId ? await this.deps.claims.findTapSession(input.tapSessionId) : null
      if (!session || session.campaignId !== campaign.id || session.privyUserId !== auth.privyUserId || !session.qualified) {
        throw new ClaimError('NOT_QUALIFIED', 'reach the tap goal in Tap Rush to earn this stock', 403)
      }
      tapSessionId = session.id
    }

    if (!this.deps.payouts) throw new ClaimError('PAYOUTS_UNAVAILABLE', 'payouts are not enabled on this server', 503)
    const reserved = await this.deps.claims.reserve({
      campaignId: campaign.id,
      privyUserId: auth.privyUserId,
      recipientWallet: recipient,
      amountRaw: campaign.rewardPerClaimRaw!,
      tapSessionId,
    })
    if (!reserved.ok) {
      const message = {
        NOT_LIVE: 'this drop is not live',
        EXHAUSTED: 'all the stock in this drop has been claimed',
        WALLET_ALREADY_CLAIMED: 'this wallet already received stock from this drop',
        SESSION_ALREADY_USED: 'that round was already used for a claim',
      }[reserved.reason]
      throw new ClaimError(reserved.reason, message)
    }
    if (!reserved.fresh) return this.current(reserved.claim) as Promise<StoredClaim>
    return this.deps.payouts.pay(campaign, reserved.claim)
  }

  /** The caller's claim for a campaign, brought up to date from the chain. */
  async myClaim(auth: AuthContext, campaignId: string): Promise<StoredClaim | null> {
    return this.current(await this.deps.claims.findForUser(campaignId, auth.privyUserId))
  }

  private async current(claim: StoredClaim | null): Promise<StoredClaim | null> {
    if (!claim) return null
    if (claim.status === 'SENDING' && this.deps.payouts) return this.deps.payouts.reconcile(claim)
    if (claim.status === 'RESERVED' && Date.now() - claim.updatedAt.getTime() > STALE_RESERVATION_MS) {
      await this.deps.claims.markFailed(claim.id, 'STALE_RESERVATION')
      return { ...claim, status: 'FAILED', failureReason: 'STALE_RESERVATION' }
    }
    return claim
  }

  private async claimableCampaign(auth: AuthContext, campaignId: string): Promise<StoredCampaign> {
    const campaign = /^[0-9a-f-]{36}$/.test(campaignId) ? await this.deps.campaigns.findById(campaignId) : null
    if (!campaign) throw new ClaimError('NOT_FOUND', 'campaign not found', 404)
    if (campaign.cluster !== this.deps.env.SOLANA_CLUSTER) throw new ClaimError('WRONG_NETWORK', `this drop belongs to ${campaign.cluster}`)
    if (!isClaimableType(campaign.type) || campaign.rewardPerClaimRaw === null) {
      throw new ClaimError('NOT_CLAIMABLE', 'this drop does not support claiming yet')
    }
    if (campaign.creatorPrivyUserId === auth.privyUserId) throw new ClaimError('OWN_CAMPAIGN', 'you cannot claim your own drop', 403)
    return campaign
  }

  private requireLiveWithRoom(campaign: StoredCampaign) {
    if (campaign.status !== 'LIVE') throw new ClaimError('NOT_LIVE', campaign.status === 'ENDED' ? 'this drop has ended' : 'this drop is not live')
    if (campaign.allowanceRaw - campaign.claimedRaw < campaign.rewardPerClaimRaw!) {
      throw new ClaimError('EXHAUSTED', 'all the stock in this drop has been claimed')
    }
  }
}

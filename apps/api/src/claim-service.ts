import { randomInt } from 'node:crypto'

import type { BlinkEnv } from '@blink/config'
import { assessTapRound, isClaimableType, TAP_RUSH_LIMITS, type TapRushSessionSummary } from '@blink/domain'

import type { AuthContext, AuthVerifier } from './auth.ts'
import type { CampaignRepository, StoredCampaign } from './campaign-repo.ts'
import type { ClaimRepository, StoredClaim, StoredReferral } from './claim-repo.ts'
import { ClaimError, type PayoutService } from './payout-service.ts'

/** A RESERVED claim older than this was abandoned before signing (e.g. a restart) and is released. */
export const STALE_RESERVATION_MS = 120_000
/** The client's countdown may finish slightly early relative to the server clock. */
const TAP_RUSH_EARLY_GRACE_MS = 500
/** Results submitted much later than the round are not accepted. */
const TAP_RUSH_LATE_LIMIT_MS = 120_000

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function newReferralCode() {
  let code = ''
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

const TAP_REJECT_MESSAGE: Record<string, string> = {
  COUNT_MISMATCH: 'that result was not accepted',
  OUT_OF_ORDER: 'that result was not accepted',
  OUT_OF_ROUND: 'that result was not accepted',
  TOO_FAST: 'those taps were faster than a finger can tap',
  BURST: 'those taps were faster than a finger can tap',
  ROBOTIC: 'those taps looked automated',
}

/**
 * Recipient claims, Tap Rush rounds and referrals (DECISIONS D-13, D-14, owner-approved ASSUMPTIONS):
 *  - fixed amount per person; first come until the pool is used up; one reward per account and per wallet;
 *  - the creator cannot claim their own drop; rewards go to the user's Privy embedded wallet only;
 *  - Tap Rush: a server-timed round; `goal` taps within `seconds` with human tap timings qualifies for one claim;
 *  - Referral: a friend claims through an invite code and both get the reward; each referrer is paid once.
 */
export class ClaimService {
  constructor(
    private readonly deps: {
      env: BlinkEnv
      auth: AuthVerifier
      campaigns: CampaignRepository
      claims: ClaimRepository
      payouts?: PayoutService
      log?: { warn: (o: object, msg: string) => void }
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

  async finishTapRush(auth: AuthContext, campaignId: string, input: { sessionId: string; taps: number; tapTimesMs: number[] }) {
    const session = await this.deps.claims.findTapSession(input.sessionId)
    if (!session || session.campaignId !== campaignId || session.privyUserId !== auth.privyUserId) {
      throw new ClaimError('SESSION_NOT_FOUND', 'this round was not found', 404)
    }
    if (session.finishedAt) throw new ClaimError('SESSION_FINISHED', 'this round already ended')

    const now = new Date()
    const elapsed = now.getTime() - session.startedAt.getTime()
    const roundMs = session.seconds * 1000
    const inTime = elapsed >= roundMs - TAP_RUSH_EARLY_GRACE_MS && elapsed <= roundMs + TAP_RUSH_LATE_LIMIT_MS
    const verdict = assessTapRound(input.tapTimesMs, input.taps, session.seconds)
    const rejectReason = !inTime ? 'TIMING' : verdict.ok ? null : verdict.reason
    const qualified = rejectReason === null && input.taps >= session.goal
    const finished = await this.deps.claims.finishTapSession(session.id, { taps: input.taps, qualified, finishedAt: now, rejectReason })
    if (!finished) throw new ClaimError('SESSION_FINISHED', 'this round already ended')
    if (!inTime) throw new ClaimError('ROUND_TIMING_INVALID', 'that round did not last the full time — please play again', 422)
    if (rejectReason) throw new ClaimError('ROUND_REJECTED', TAP_REJECT_MESSAGE[rejectReason] ?? 'that result was not accepted', 422)
    const used = await this.deps.claims.countTapSessions(campaignId, auth.privyUserId)
    return { qualified, taps: input.taps, goal: session.goal, attemptsLeft: Math.max(0, TAP_RUSH_LIMITS.maxAttempts - used) }
  }

  async claim(auth: AuthContext, campaignId: string, input: { tapSessionId?: string; ref?: string }): Promise<StoredClaim> {
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

    let referral: { code: string; referrerPrivyUserId: string; referrerWallet: string } | null = null
    if (campaign.type === 'REFERRAL') {
      const invite = input.ref ? await this.deps.claims.findReferral(input.ref) : null
      if (!invite || invite.campaignId !== campaign.id) throw new ClaimError('NEEDS_INVITE', 'open a friend’s invite link to claim this drop', 403)
      if (invite.privyUserId === auth.privyUserId) throw new ClaimError('SELF_REFERRAL', 'you cannot use your own invite link', 403)
      const [referrerWallet] = await this.deps.auth.getEmbeddedSolanaWallets(invite.privyUserId)
      if (referrerWallet === recipient) throw new ClaimError('SELF_REFERRAL', 'you cannot use your own invite link', 403)
      // A referrer without a Blink wallet yet simply earns nothing; the friend is still paid.
      if (referrerWallet) referral = { code: invite.code, referrerPrivyUserId: invite.privyUserId, referrerWallet }
    }

    const payouts = this.requirePayouts()
    const reserved = await this.deps.claims.reserve({
      campaignId: campaign.id,
      privyUserId: auth.privyUserId,
      recipientWallet: recipient,
      amountRaw: campaign.rewardPerClaimRaw!,
      tapSessionId,
      referral,
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

    const paid = await payouts.pay(campaign, reserved.claim).catch(async (err: unknown) => {
      // The friend's payout failed before sending: the bonus was reserved with it, so release it too.
      if (reserved.bonus) await this.deps.claims.markFailed(reserved.bonus.id, 'FRIEND_PAYOUT_FAILED')
      throw err
    })
    if (reserved.bonus) {
      if (paid.status === 'PAID') {
        // The referrer's bonus is its own transfer. Its failure never fails the friend's claim; the referrer can retry.
        await payouts.pay(campaign, reserved.bonus).catch((err: unknown) => this.deps.log?.warn({ err, claimId: reserved.bonus!.id }, 'referral bonus payout failed'))
      } else if (paid.status === 'FAILED') {
        await this.deps.claims.markFailed(reserved.bonus.id, 'FRIEND_PAYOUT_FAILED')
      }
      // Friend still SENDING: the bonus stays reserved; the sweep releases it and the referrer can retry once the friend is paid.
    }
    return paid
  }

  /** The caller's claim for a campaign, brought up to date from the chain. */
  async myClaim(auth: AuthContext, campaignId: string): Promise<StoredClaim | null> {
    return this.current(await this.deps.claims.findForUser(campaignId, auth.privyUserId))
  }

  /** The caller's invite code for a REFERRAL drop (created on first request) and the bonus it earned. */
  async referral(auth: AuthContext, campaignId: string, create: boolean): Promise<{ referral: StoredReferral | null; bonus: StoredClaim | null }> {
    const campaign = await this.claimableCampaign(auth, campaignId)
    if (campaign.type !== 'REFERRAL') throw new ClaimError('NOT_REFERRAL', 'this drop is not a referral drop')
    let referral = await this.deps.claims.findReferralForUser(campaign.id, auth.privyUserId)
    if (!referral && create) {
      if (campaign.status !== 'LIVE') throw new ClaimError('NOT_LIVE', 'this drop is not live')
      for (let i = 0; i < 5 && !referral; i++) referral = await this.deps.claims.getOrCreateReferral(campaign.id, auth.privyUserId, newReferralCode())
      if (!referral) throw new ClaimError('TRY_AGAIN', 'could not create your invite link — please try again', 503)
    }
    const bonus = await this.current(await this.deps.claims.findForUser(campaign.id, auth.privyUserId, 'REFERRAL_BONUS'))
    return { referral, bonus }
  }

  /** Re-sends the caller's FAILED referral bonus (e.g. the network dropped it). */
  async retryBonus(auth: AuthContext, campaignId: string): Promise<StoredClaim> {
    const campaign = await this.claimableCampaign(auth, campaignId)
    const bonus = await this.current(await this.deps.claims.findForUser(campaign.id, auth.privyUserId, 'REFERRAL_BONUS'))
    if (!bonus) throw new ClaimError('NO_BONUS', 'you have not earned a referral bonus yet', 404)
    if (bonus.status !== 'FAILED') return bonus
    const friend = bonus.bonusForClaimId ? await this.current(await this.deps.claims.findById(bonus.bonusForClaimId)) : null
    if (friend?.status !== 'PAID') throw new ClaimError('FRIEND_NOT_PAID', 'your friend’s reward has not arrived yet, so your bonus cannot be sent')
    const payouts = this.requirePayouts()
    const again = await this.deps.claims.reReserve(bonus.id)
    if (!again.ok) {
      throw new ClaimError(again.reason === 'EXHAUSTED' ? 'EXHAUSTED' : 'NOT_LIVE', again.reason === 'EXHAUSTED' ? 'this drop has no stock left for your bonus' : 'this drop is not live')
    }
    return payouts.pay(campaign, again.claim)
  }

  /**
   * Creator only: put a PAUSED drop back to LIVE after re-checking the onchain delegation and the mint (§9).
   * A drop with less than one reward left ends instead.
   */
  async resume(auth: AuthContext, campaignId: string): Promise<StoredCampaign> {
    const campaign = /^[0-9a-f-]{36}$/.test(campaignId) ? await this.deps.campaigns.findById(campaignId) : null
    if (!campaign || campaign.creatorPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_FOUND', 'campaign not found', 404)
    if (campaign.status !== 'PAUSED') throw new ClaimError('NOT_PAUSED', `this drop is ${campaign.status.toLowerCase()}`)
    if (campaign.rewardPerClaimRaw !== null && campaign.allowanceRaw - campaign.claimedRaw < campaign.rewardPerClaimRaw) {
      return (await this.deps.campaigns.transitionStatus(campaign.id, 'PAUSED', 'ENDED')) ?? campaign
    }
    const ready = await this.requirePayouts().checkReady(campaign)
    if (!ready.ok) {
      const hint =
        ready.reason === 'MINT_STATE_CHANGED'
          ? 'the stock’s issuer has paused transfers'
          : ready.reason === 'DELEGATION_REVOKED' || ready.reason === 'DELEGATE_CHANGED'
            ? 'Blink’s approval on your campaign account was removed or changed'
            : 'your campaign account no longer holds enough stock or approval for another reward'
      throw new ClaimError('STILL_NOT_READY', `can’t resume yet: ${hint}`, 409)
    }
    return (await this.deps.campaigns.transitionStatus(campaign.id, 'PAUSED', 'LIVE')) ?? campaign
  }

  /** Background sweep: confirms SENDING payouts and releases RESERVED claims abandoned before signing. */
  async sweep(): Promise<number> {
    if (!this.deps.payouts) return 0
    const unsettled = await this.deps.claims.listUnsettled(new Date(Date.now() - STALE_RESERVATION_MS), 50)
    for (const claim of unsettled) {
      try {
        await this.current(claim)
      } catch (err) {
        this.deps.log?.warn({ err, claimId: claim.id }, 'claim sweep failed for one claim')
      }
    }
    return unsettled.length
  }

  private requirePayouts(): PayoutService {
    if (!this.deps.payouts) throw new ClaimError('PAYOUTS_UNAVAILABLE', 'payouts are not enabled on this server', 503)
    return this.deps.payouts
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

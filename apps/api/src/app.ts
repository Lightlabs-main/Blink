import { randomUUID } from 'node:crypto'

import type { BlinkEnv } from '@blink/config'
import { TAP_RUSH_DEFAULTS } from '@blink/domain'
import { campaignSeedFromUuid, checkCampaignAccountBeforeCreation, deriveCampaignTokenAccount } from '@blink/solana'
import { claimRequest, createCampaignRequest, finishTapRushRequest, submitFundingRequest } from '@blink/validation'
import { address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { type AuthContext, AuthError, type AuthVerifier, bearerToken } from './auth.ts'
import { type CampaignRepository, type StoredCampaign, toSummary } from './campaign-repo.ts'
import { type ClaimRepository, type StoredClaim, toClaimSummary } from './claim-repo.ts'
import { ClaimService, type SeekerVerifier } from './claim-service.ts'
import type { Asset } from './assets.ts'
import { type FundingService, FundingRequestError } from './funding-service.ts'
import { ClaimError, type PayoutService } from './payout-service.ts'
import { LIMITS, RateLimiter } from './rate-limit.ts'
import type { XStockHoldings } from './xstock-holdings.ts'
import type { XStockMarket } from './xstock-market.ts'

export interface AppDeps {
  env: BlinkEnv
  auth: AuthVerifier
  campaigns: CampaignRepository
  rpc: Rpc<GetAccountInfoApi>
  /** Campaign assets for the configured cluster (mainnet xStocks, or the devnet test mint). */
  assets: Asset[]
  /** Creator funding flow (prepare → wallet signs → submit → verify). Optional in tests. */
  funding?: FundingService
  /** Claims and Tap Rush sessions (DECISIONS D-13). Claim routes return 503 without it. */
  claims?: ClaimRepository
  /** Reward payouts; claims return 503 PAYOUTS_UNAVAILABLE without it. */
  payouts?: PayoutService
  /** D-17: Seeker Genesis Token checks for SEEKER drops. */
  seeker?: SeekerVerifier
  /** Read-only mainnet market data for xStocks; optional (tests, offline). */
  market?: XStockMarket
  /** Read-only mainnet xStock balances for creator wallets; optional. */
  holdings?: XStockHoldings
  logger?: boolean
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } })
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : false,
    bodyLimit: 16 * 1024,
    // Caddy on the same host sets X-Forwarded-For; trust it from loopback only so req.ip is the real client.
    trustProxy: '127.0.0.1',
  })
  const limiter = new RateLimiter()

  /** D-16: throttle mutating recipient routes per client IP and per signed-in user. */
  function throttle(req: FastifyRequest, auth: AuthContext) {
    const ok =
      limiter.hit(`ip:${req.ip}`, LIMITS.perIp.max, LIMITS.perIp.windowMs) &&
      limiter.hit(`user:${auth.privyUserId}`, LIMITS.perUser.max, LIMITS.perUser.windowMs)
    if (!ok) throw new ClaimError('RATE_LIMITED', 'too many requests — please slow down', 429)
  }

  async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
    return deps.auth.verifyAccessToken(bearerToken(req.headers.authorization))
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return sendError(reply, 401, 'UNAUTHENTICATED', err.message)
    if (err instanceof FundingRequestError) return sendError(reply, err.httpStatus, err.code, err.message)
    if (err instanceof ClaimError) return sendError(reply, err.httpStatus, err.code, err.message)
    const status = typeof (err as { statusCode?: number }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500
    if (status < 500) return sendError(reply, status, 'BAD_REQUEST', err instanceof Error ? err.message : 'bad request')
    app.log.error(err)
    return sendError(reply, 500, 'INTERNAL', 'internal error')
  })

  app.get('/health', async () => ({ ok: true, cluster: deps.env.SOLANA_CLUSTER, demoMode: deps.env.DEMO_MODE }))

  /** Public operational status. The fee payer's address and balance are public onchain anyway. */
  app.get('/v1/status', async (req) => {
    let payouts: { enabled: boolean; feePayer?: string; balanceLamports?: string; low?: boolean } = { enabled: Boolean(deps.payouts) }
    try {
      const s = await deps.payouts?.feePayerStatus()
      if (s) payouts = { enabled: true, feePayer: s.address, balanceLamports: s.balanceLamports.toString(), low: s.low }
    } catch (err) {
      req.log.warn({ err }, 'fee payer status unavailable')
    }
    return { cluster: deps.env.SOLANA_CLUSTER, payouts }
  })

  app.get('/v1/xstocks', async (req) => {
    let market = new Map<string, { multiplier: number; paused: boolean; asOf: number }>()
    try {
      market = (await deps.market?.getAll()) ?? market
    } catch (err) {
      req.log.warn({ err }, 'xStock market data unavailable')
    }
    return {
      xstocks: deps.assets.map(({ symbol, name, mint, decimals, logo, isTest }) => {
        const m = market.get(mint)
        return { symbol, name, mint, decimals, logo, isTest, multiplier: m?.multiplier ?? null, paused: m?.paused ?? null, asOf: m?.asOf ?? null }
      }),
    }
  })

  /** Public: LIVE drops for the home feed. Empty until campaigns are funded and delegated. */
  app.get('/v1/campaigns', async () => ({
    campaigns: (await deps.campaigns.listByStatus('LIVE', 50)).map(toSummary),
  }))

  /** The authenticated user as the backend sees them (never trusts client-supplied identity). */
  app.get('/v1/me', async (req) => {
    const auth = await requireAuth(req)
    const verifiedCreatorWallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    return { privyUserId: auth.privyUserId, verifiedCreatorWallets }
  })

  /**
   * xStock balances (raw base units) of the caller's embedded stock wallet and Privy-verified creator wallets. Wallet addresses come from
   * Privy, never from the client. `available: false` when no read RPC is configured or the read fails.
   */
  app.get('/v1/me/holdings', async (req) => {
    const auth = await requireAuth(req)
    const [creator, embedded] = await Promise.all([
      deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId),
      deps.auth.getEmbeddedSolanaWallets(auth.privyUserId),
    ])
    const wallets = [
      ...embedded.map((wallet) => ({ wallet, kind: 'stock' as const })),
      ...creator.map((wallet) => ({ wallet, kind: 'creator' as const })),
    ]
    const result: { wallet: string; kind: 'stock' | 'creator'; balances: Record<string, string> | null }[] = []
    let available = Boolean(deps.holdings)
    for (const w of wallets) {
      try {
        result.push({ ...w, balances: (await deps.holdings?.forOwner(w.wallet)) ?? null })
      } catch (err) {
        available = false
        req.log.warn({ err }, 'holdings read failed')
        result.push({ ...w, balances: null })
      }
    }
    return { available, wallets: result }
  })

  app.get('/v1/me/campaigns', async (req) => {
    const auth = await requireAuth(req)
    return { campaigns: (await deps.campaigns.listByCreator(auth.privyUserId, 50)).map(toSummary) }
  })

  /**
   * Create a DRAFT campaign. The creator wallet must be one Privy verified via SIWS for this user.
   * Header X-Creator-Wallet only SELECTS among verified wallets; it never authenticates anything.
   */
  app.post('/v1/campaigns', async (req, reply) => {
    const auth = await requireAuth(req)
    const parsed = createCampaignRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    const body = parsed.data

    const xstock = deps.assets.find((x) => x.mint === body.mint)
    if (!xstock) return sendError(reply, 422, 'UNSUPPORTED_MINT', 'this stock is not available on the current network')

    const verifiedWallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const requested = req.headers['x-creator-wallet']
    const creatorWallet =
      typeof requested === 'string' ? verifiedWallets.find((w) => w === requested) : verifiedWallets.length === 1 ? verifiedWallets[0] : undefined
    if (!creatorWallet) {
      return sendError(
        reply,
        403,
        'CREATOR_WALLET_NOT_VERIFIED',
        verifiedWallets.length === 0
          ? 'sign in with your Solana wallet (SIWS) before creating a campaign'
          : 'select one of your verified wallets with X-Creator-Wallet',
      )
    }

    const id = randomUUID()
    const campaignSeed = campaignSeedFromUuid(id)
    const campaignTokenAccount = await deriveCampaignTokenAccount({ creator: address(creatorWallet), campaignSeed })

    // MASTER_PROMPT §11: a freshly derived address must not exist yet. If it does, stop — never pick another.
    const pre = await checkCampaignAccountBeforeCreation(deps.rpc, campaignTokenAccount)
    if (pre.status === 'exists') {
      app.log.error({ campaignTokenAccount, owner: pre.owner }, 'derived campaign account already exists')
      return sendError(reply, 409, 'DERIVED_ACCOUNT_EXISTS', 'derived campaign account already exists; investigation required')
    }

    const stored = await deps.campaigns.create({
      id,
      type: body.type,
      cluster: deps.env.SOLANA_CLUSTER,
      creatorPrivyUserId: auth.privyUserId,
      creatorWallet,
      mint: xstock.mint,
      xstockSymbol: xstock.symbol,
      campaignSeed,
      campaignTokenAccount,
      allowanceRaw: BigInt(body.allowanceRaw),
      rewardPerClaimRaw: body.rewardPerClaimRaw === undefined ? null : BigInt(body.rewardPerClaimRaw),
      tapRush: body.type === 'TAP_RUSH' ? (body.tapRush ?? TAP_RUSH_DEFAULTS) : null,
    })
    return reply.status(201).send({ campaign: toSummary(stored) })
  })

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id', async (req, reply) => {
    const campaign = /^[0-9a-f-]{36}$/.test(req.params.id) ? await deps.campaigns.findById(req.params.id) : null
    if (!campaign) return sendError(reply, 404, 'NOT_FOUND', 'campaign not found')
    return { campaign: toSummary(campaign) }
  })

  /** Loads a campaign the caller created; 404 otherwise (never reveal others' campaigns via these routes). */
  async function requireOwnCampaign(req: FastifyRequest<{ Params: { id: string } }>): Promise<StoredCampaign> {
    const auth = await requireAuth(req)
    const c = /^[0-9a-f-]{36}$/.test(req.params.id) ? await deps.campaigns.findById(req.params.id) : null
    if (!c || c.creatorPrivyUserId !== auth.privyUserId) throw new FundingRequestError('NOT_FOUND', 'campaign not found', 404)
    if (c.cluster !== deps.env.SOLANA_CLUSTER) {
      throw new FundingRequestError('WRONG_NETWORK', `this campaign belongs to ${c.cluster}`, 409)
    }
    return c
  }

  function requireFunding(): FundingService {
    if (!deps.funding) throw new FundingRequestError('FUNDING_UNAVAILABLE', 'funding is not enabled on this server', 503)
    return deps.funding
  }

  /** Step 1: build + simulate the single fund-and-approve transaction for the creator to sign. */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/funding/prepare', async (req) => {
    const funding = requireFunding()
    let c = await requireOwnCampaign(req)
    if (c.status !== 'DRAFT' && c.status !== 'AWAITING_FUNDING') {
      throw new FundingRequestError('WRONG_STATUS', `campaign is ${c.status}`, 409)
    }
    const prepared = await funding.prepare(c)
    if (c.status === 'DRAFT') c = (await deps.campaigns.transitionStatus(c.id, 'DRAFT', 'AWAITING_FUNDING')) ?? c
    return prepared
  })

  /** Step 2: relay the creator-signed transaction (must match what was prepared), then verify onchain. */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/funding/submit', async (req, reply) => {
    const funding = requireFunding()
    const c = await requireOwnCampaign(req)
    if (c.status !== 'AWAITING_FUNDING') throw new FundingRequestError('WRONG_STATUS', `campaign is ${c.status}`, 409)
    const parsed = submitFundingRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    const { signature } = await funding.submit(c, parsed.data.signedTransaction)
    const live = await goLiveIfVerified(funding, c)
    return { signature, campaign: toSummary(live.campaign), verified: live.verified }
  })

  /** Recovery: re-check onchain state (e.g. the app lost connection after signing). */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/funding/verify', async (req) => {
    const funding = requireFunding()
    const c = await requireOwnCampaign(req)
    if (c.status === 'LIVE') return { campaign: toSummary(c), verified: true }
    if (c.status !== 'AWAITING_FUNDING') throw new FundingRequestError('WRONG_STATUS', `campaign is ${c.status}`, 409)
    const live = await goLiveIfVerified(funding, c)
    return { campaign: toSummary(live.campaign), verified: live.verified }
  })

  async function goLiveIfVerified(funding: FundingService, c: StoredCampaign) {
    const { live, status } = await funding.verify(c)
    if (!live) {
      req_log_problems(status.problems)
      return { campaign: c, verified: false }
    }
    const funded = (await deps.campaigns.transitionStatus(c.id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')) ?? c
    const liveCampaign = (await deps.campaigns.transitionStatus(funded.id, 'AWAITING_DELEGATION', 'LIVE')) ?? funded
    return { campaign: liveCampaign, verified: true }
  }

  function req_log_problems(problems: string[]) {
    if (problems.length) app.log.warn({ problems }, 'funding not verified onchain yet')
  }

  // ---- Recipient claims and Tap Rush (DECISIONS D-13) ----

  function requireClaims(): ClaimService {
    if (!deps.claims) throw new ClaimError('CLAIMS_UNAVAILABLE', 'claiming is not enabled on this server', 503)
    return new ClaimService({ env: deps.env, auth: deps.auth, campaigns: deps.campaigns, claims: deps.claims, payouts: deps.payouts, log: app.log, limiter, seeker: deps.seeker })
  }

  async function claimResponse(claim: StoredClaim | null) {
    if (!claim) return { claim: null }
    const campaign = await deps.campaigns.findById(claim.campaignId)
    return { claim: campaign ? toClaimSummary(claim, campaign) : null }
  }

  /** Starts a server-timed Tap Rush round. The client starts its timer when this returns. */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/tap-rush/start', async (req) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    return { session: await requireClaims().startTapRush(auth, req.params.id) }
  })

  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/tap-rush/finish', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = finishTapRushRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    return requireClaims().finishTapRush(auth, req.params.id, parsed.data)
  })

  /** Claims the fixed reward and pays it to the caller's Blink wallet. Idempotent per user and campaign. */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/claim', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = claimRequest.safeParse(req.body ?? {})
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    return claimResponse(await requireClaims().claim(auth, req.params.id, parsed.data, req.ip))
  })

  /** The caller's claim for this campaign (null if none), refreshed from the chain while it is being sent. */
  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/claim', async (req) => {
    const auth = await requireAuth(req)
    return claimResponse(await requireClaims().myClaim(auth, req.params.id))
  })

  /** Referral drops: the caller's invite code (POST creates it) and the bonus it earned. */
  async function referralResponse(req: FastifyRequest<{ Params: { id: string } }>, create: boolean) {
    const auth = await requireAuth(req)
    if (create) throttle(req, auth)
    const { referral, bonus } = await requireClaims().referral(auth, req.params.id, create)
    if (!referral) return { referral: null }
    const campaign = await deps.campaigns.findById(referral.campaignId)
    return { referral: { campaignId: referral.campaignId, code: referral.code, bonus: bonus && campaign ? toClaimSummary(bonus, campaign) : null } }
  }
  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/referral', (req) => referralResponse(req, false))
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/referral', (req) => referralResponse(req, true))

  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/referral/bonus/retry', async (req) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    return claimResponse(await requireClaims().retryBonus(auth, req.params.id))
  })

  /** Creator only: re-check a PAUSED drop onchain and put it back LIVE (or ENDED when too little is left). */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/resume', async (req) => {
    const auth = await requireAuth(req)
    return { campaign: toSummary(await requireClaims().resume(auth, req.params.id)) }
  })

  app.get('/v1/me/claims', async (req) => {
    const auth = await requireAuth(req)
    const claims = deps.claims ? await deps.claims.listForUser(auth.privyUserId, 50) : []
    const out = []
    for (const claim of claims) {
      const campaign = await deps.campaigns.findById(claim.campaignId)
      if (campaign) out.push(toClaimSummary(claim, campaign))
    }
    return { claims: out }
  })

  return app
}

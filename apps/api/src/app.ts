import { randomUUID } from 'node:crypto'

import type { BlinkEnv } from '@blink/config'
import { campaignSeedFromUuid, checkCampaignAccountBeforeCreation, deriveCampaignTokenAccount } from '@blink/solana'
import { createCampaignRequest, submitFundingRequest } from '@blink/validation'
import { address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { type AuthContext, AuthError, type AuthVerifier, bearerToken } from './auth.ts'
import { type CampaignRepository, type StoredCampaign, toSummary } from './campaign-repo.ts'
import type { Asset } from './assets.ts'
import { type FundingService, FundingRequestError } from './funding-service.ts'
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
  })

  async function requireAuth(req: FastifyRequest): Promise<AuthContext> {
    return deps.auth.verifyAccessToken(bearerToken(req.headers.authorization))
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return sendError(reply, 401, 'UNAUTHENTICATED', err.message)
    if (err instanceof FundingRequestError) return sendError(reply, err.httpStatus, err.code, err.message)
    const status = typeof (err as { statusCode?: number }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500
    if (status < 500) return sendError(reply, status, 'BAD_REQUEST', err instanceof Error ? err.message : 'bad request')
    app.log.error(err)
    return sendError(reply, 500, 'INTERNAL', 'internal error')
  })

  app.get('/health', async () => ({ ok: true, cluster: deps.env.SOLANA_CLUSTER, demoMode: deps.env.DEMO_MODE }))

  app.get('/v1/xstocks', async (req) => {
    let market = new Map<string, { multiplier: number; paused: boolean; asOf: number }>()
    try {
      market = (await deps.market?.getAll()) ?? market
    } catch (err) {
      req.log.warn({ err }, 'xStock market data unavailable')
    }
    return {
      xstocks: deps.assets.map(({ symbol, name, mint, decimals, isTest }) => {
        const m = market.get(mint)
        return { symbol, name, mint, decimals, isTest, multiplier: m?.multiplier ?? null, paused: m?.paused ?? null, asOf: m?.asOf ?? null }
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
   * xStock balances (raw base units) of the caller's Privy-verified creator wallets. Wallet addresses come from
   * Privy, never from the client. `available: false` when no read RPC is configured or the read fails.
   */
  app.get('/v1/me/holdings', async (req) => {
    const auth = await requireAuth(req)
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const result: { wallet: string; balances: Record<string, string> | null }[] = []
    let available = Boolean(deps.holdings)
    for (const wallet of wallets) {
      try {
        result.push({ wallet, balances: (await deps.holdings?.forOwner(wallet)) ?? null })
      } catch (err) {
        available = false
        req.log.warn({ err }, 'holdings read failed')
        result.push({ wallet, balances: null })
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

  return app
}

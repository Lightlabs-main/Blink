import { createHash, randomUUID } from 'node:crypto'

import type { BlinkEnv } from '@blink/config'
import { type HistoryItem, TAP_RUSH_DEFAULTS } from '@blink/domain'
import { campaignSeedFromUuid, checkCampaignAccountBeforeCreation, deriveCampaignTokenAccount } from '@blink/solana'
import {
  claimRequest,
  createCampaignRequest,
  declareEligibilityRequest,
  finishTapRushRequest,
  pushTokenDeleteRequest,
  pushTokenRequest,
  questHasTapRush,
  xTaskSubmitRequest,
  avatarUploadRequest,
  profileUpdateRequest,
  questUses,
  stampOreRound,
  sendPrepareRequest,
  sendSubmitRequest,
  skrPrepareRequest,
  submitFundingRequest,
} from '@blink/validation'
import { SkrStakeError } from '@blink/solana'
import { address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'

import { type AuthContext, AuthError, type AuthVerifier, bearerToken } from './auth.ts'
import { type CampaignRepository, type StoredCampaign, toSummary } from './campaign-repo.ts'
import { type ClaimRepository, type StoredClaim, toClaimSummary } from './claim-repo.ts'
import { ClaimService, type SeekerVerifier } from './claim-service.ts'
import type { EligibilityService } from './eligibility.ts'
import type { QuestService } from './quest-service.ts'
import { NOOP_NOTIFIER, type Notifier, type PushTokenStore } from './push.ts'
import type { SkrStaking } from './skr-service.ts'
import type { SendService } from './send-service.ts'
import type { TransferStore } from './history.ts'
import { parsePostUrl, postTime, XAccountUsedError, type XPostReader, type XTaskStore } from './x-quest.ts'
import { AVATAR_MAX_BYTES, avatarPath, type ProfileStore, sniffImage, usernameProblem, UsernameTakenError } from './profile.ts'
import type { Asset } from './assets.ts'
import { type FundingService, FundingRequestError } from './funding-service.ts'
import { ClaimError, type PayoutService } from './payout-service.ts'
import { LIMITS, RateLimiter } from './rate-limit.ts'
import { registerSocialRoutes } from './social-routes.ts'
import type { SocialStore } from './social-store.ts'
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
  /** D-20: xStocks eligibility gate. Without it, every enforced xStock path fails closed. */
  eligibility?: EligibilityService
  /** D-21: Verified Quest evaluation (mainnet reads). */
  quests?: QuestService
  /** D-23: in-app SKR staking (mainnet reads + unsigned transactions for the user's own wallet). */
  skr?: SkrStaking
  /** D-39: X tasks (personal code + public post check). */
  xTasks?: XTaskStore
  xReader?: XPostReader
  /** D-38: sends, for history and receipts. */
  transfers?: TransferStore
  /** D-37: usernames and profile pictures. */
  profiles?: ProfileStore
  /** D-40: clubs, chat, squads, event check-ins. */
  social?: SocialStore
  /** D-32: Send from the Blink stock wallet (fees paid by Blink). */
  send?: SendService
  /** D-24: push notifications. */
  pushTokens?: PushTokenStore
  notifier?: Notifier
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
  const notifier = deps.notifier ?? NOOP_NOTIFIER

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
    if (err instanceof SkrStakeError) return sendError(reply, err.code === 'INVALID' ? 400 : 422, `SKR_${err.code}`, err.message)
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
    return {
      cluster: deps.env.SOLANA_CLUSTER,
      payouts: { ...payouts, killSwitch: !deps.env.PAYOUTS_ENABLED },
      compliance: { xstocks: deps.env.XSTOCK_COMPLIANCE },
    }
  })

  /** The caller's own xStocks eligibility decision (D-20). Never public. */
  app.get('/v1/me/eligibility', async (req) => {
    const auth = await requireAuth(req)
    if (!deps.eligibility) return { enforced: deps.env.XSTOCK_COMPLIANCE === 'enforce', eligibility: null }
    return { enforced: deps.eligibility.enforced, eligibility: await deps.eligibility.summary(auth.privyUserId) }
  })

  /** Self-declared country + attestations; the server decides, cross-checking the request's IP country. */
  app.post('/v1/me/eligibility', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = declareEligibilityRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    if (!deps.eligibility) throw new ClaimError('ELIGIBILITY_UNAVAILABLE', 'eligibility checks are not available right now', 503)
    return { enforced: deps.eligibility.enforced, eligibility: await deps.eligibility.declare(auth.privyUserId, parsed.data, req.ip) }
  })

  /** D-26: remove one of the caller's own linked Solana wallets. Campaigns it already funded are unaffected. */
  app.delete<{ Params: { address: string } }>('/v1/me/wallets/:address', async (req) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    if (!wallets.includes(req.params.address)) throw new ClaimError('WALLET_NOT_LINKED', 'this wallet is not linked to your account', 404)
    if (!deps.auth.unlinkExternalSolanaWallet) throw new ClaimError('UNLINK_UNAVAILABLE', 'removing wallets is not available right now', 503)
    return { verifiedCreatorWallets: await deps.auth.unlinkExternalSolanaWallet(auth.privyUserId, req.params.address) }
  })

  // ---- D-39: X tasks: personal code, then the public post is checked through X's oEmbed ----

  async function xTaskContext(req: FastifyRequest<{ Params: { id: string } }>) {
    const auth = await requireAuth(req)
    if (!deps.xTasks || !deps.xReader) throw new ClaimError('X_UNAVAILABLE', 'X tasks are not available right now', 503)
    const campaign = /^[0-9a-f-]{36}$/.test(req.params.id) ? await deps.campaigns.findById(req.params.id) : null
    const condition = campaign?.requirements && [...campaign.requirements.eligibility, ...campaign.requirements.actions].flatMap((g) => g.conditions).find((c) => c.verifier === 'X_QUEST')
    if (!campaign || !condition) throw new ClaimError('NOT_FOUND', 'this drop has no X task', 404)
    return { auth, campaign, condition, xTasks: deps.xTasks, xReader: deps.xReader }
  }
  const xTaskView = (t: Awaited<ReturnType<XTaskStore['get']>>, campaignId: string, mustInclude?: string) => ({
    code: t?.code ?? null,
    mustInclude: mustInclude ?? null,
    suggestedText: t ? `${mustInclude ? `${mustInclude} ` : ''}Joining this drop on Blink — tokenized stocks, made social. ${t.code} https://blinksol.site/c/${campaignId}` : null,
    verified: Boolean(t?.verifiedAt),
    postUrl: t?.postUrl ?? null,
    authorHandle: t?.authorHandle ?? null,
  })

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/x-task', async (req) => {
    const { auth, campaign, condition, xTasks } = await xTaskContext(req)
    const task = await xTasks.getOrCreate(campaign.id, auth.privyUserId)
    return { task: xTaskView(task, campaign.id, condition.mustInclude) }
  })

  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/x-task', async (req, reply) => {
    const { auth, campaign, condition, xTasks, xReader } = await xTaskContext(req)
    throttle(req, auth)
    if (!limiter.hit(`x:${auth.privyUserId}`, 10, 60 * 60 * 1000)) throw new ClaimError('RATE_LIMITED', 'too many tries — wait a little and try again', 429)
    const parsed = xTaskSubmitRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'paste the link to your post')
    const link = parsePostUrl(parsed.data.url)
    if (!link) return sendError(reply, 400, 'X_URL_INVALID', 'that isn’t a link to a post on X (it should look like x.com/name/status/…)')
    const task = await xTasks.getOrCreate(campaign.id, auth.privyUserId)
    if (postTime(link.postId).getTime() < campaign.createdAt.getTime() - 60_000) {
      return sendError(reply, 400, 'X_POST_TOO_OLD', 'that post is older than this drop — make a new post with your code')
    }
    const read = await xReader.read(link.url)
    if (!read.ok) {
      return read.reason === 'NOT_FOUND'
        ? sendError(reply, 404, 'X_POST_NOT_FOUND', 'Blink can’t see that post — check it’s public (not a protected account) and not deleted')
        : sendError(reply, 503, 'X_UNAVAILABLE', 'X isn’t answering right now — try again in a minute')
    }
    const text = read.post.text.toLowerCase()
    if (!text.includes(task.code.toLowerCase())) return sendError(reply, 400, 'X_CODE_MISSING', `your post doesn’t contain your code ${task.code}`)
    if (condition.mustInclude && !text.includes(condition.mustInclude.toLowerCase())) {
      return sendError(reply, 400, 'X_TEXT_MISSING', `your post must also include “${condition.mustInclude}”`)
    }
    try {
      const done = await xTasks.markVerified(campaign.id, auth.privyUserId, { postId: link.postId, postUrl: link.url, authorHandle: read.post.authorHandle })
      return { task: xTaskView(done, campaign.id, condition.mustInclude) }
    } catch (err) {
      if (err instanceof XAccountUsedError) return sendError(reply, 409, 'X_ACCOUNT_USED', 'that X account was already used by someone else in this drop')
      throw err
    }
  })

  registerSocialRoutes(app, deps, { requireAuth, throttle, limiter })

  // ---- D-38: history (every line opens a receipt) ----

  app.get('/v1/me/history', async (req) => {
    const auth = await requireAuth(req)
    const decimalsOf = (mint: string) => deps.assets.find((a) => a.mint === mint)?.decimals ?? 0
    const items: HistoryItem[] = []
    const claims = deps.claims ? await deps.claims.listForUser(auth.privyUserId, 100) : []
    const campaignCache = new Map<string, StoredCampaign | null>()
    const campaignOf = async (id: string) => {
      if (!campaignCache.has(id)) campaignCache.set(id, await deps.campaigns.findById(id))
      return campaignCache.get(id) ?? null
    }
    for (const c of claims) {
      const campaign = await campaignOf(c.campaignId)
      if (!campaign) continue
      items.push({
        id: `${c.kind === 'REFERRAL_BONUS' ? 'INVITE_BONUS' : 'REWARD'}:${c.id}`,
        kind: c.kind === 'REFERRAL_BONUS' ? 'INVITE_BONUS' : 'REWARD',
        cluster: campaign.cluster,
        symbol: campaign.xstockSymbol,
        mint: campaign.mint,
        decimals: decimalsOf(campaign.mint),
        amountRaw: c.amountRaw.toString(),
        status: c.status === 'PAID' ? 'CONFIRMED' : c.status === 'FAILED' ? 'FAILED' : 'PENDING',
        signature: c.txSignature,
        campaignId: campaign.id,
        campaignType: campaign.type,
        counterparty: null,
        at: c.createdAt.toISOString(),
      })
    }
    for (const t of deps.transfers ? await deps.transfers.listForUser(auth.privyUserId, 100) : []) {
      items.push({
        id: `SENT:${t.id}`,
        kind: 'SENT',
        cluster: t.cluster as HistoryItem['cluster'],
        symbol: t.symbol,
        mint: t.asset === 'SOL' ? null : t.asset,
        decimals: t.decimals,
        amountRaw: t.amountRaw.toString(),
        status: t.status,
        signature: t.signature,
        campaignId: null,
        campaignType: null,
        counterparty: t.toAddress,
        at: t.createdAt.toISOString(),
      })
    }
    for (const c of await deps.campaigns.listByCreator(auth.privyUserId, 50)) {
      if (c.status === 'DRAFT' || c.status === 'AWAITING_FUNDING') continue
      items.push({
        id: `FUNDED:${c.id}`,
        kind: 'FUNDED',
        cluster: c.cluster,
        symbol: c.xstockSymbol,
        mint: c.mint,
        decimals: decimalsOf(c.mint),
        amountRaw: c.allowanceRaw.toString(),
        status: 'CONFIRMED',
        signature: null,
        campaignId: c.id,
        campaignType: c.type,
        counterparty: c.campaignTokenAccount,
        at: c.createdAt.toISOString(),
      })
    }
    // D-40: offchain records (no amount, no transaction): event check-ins and clubs joined.
    if (deps.social) {
      for (const ch of await deps.social.checkinsOf(auth.privyUserId)) {
        const campaign = await campaignOf(ch.campaignId)
        if (!campaign) continue
        items.push({
          id: `CHECKIN:${ch.campaignId}`, kind: 'CHECKIN', cluster: campaign.cluster, symbol: campaign.xstockSymbol, mint: null, decimals: 0, amountRaw: '0',
          status: 'CONFIRMED', signature: null, campaignId: campaign.id, campaignType: campaign.type, counterparty: null, title: campaign.xstockSymbol, at: ch.at.toISOString(),
        })
      }
      const memberships = await deps.social.membershipsOf(auth.privyUserId)
      const clubs = new Map((await deps.social.clubsByIds(memberships.map((m) => m.clubId))).map((c) => [c.id, c]))
      for (const m of memberships) {
        const club = clubs.get(m.clubId)
        if (!club) continue
        items.push({
          id: `CLUB_JOINED:${club.id}`, kind: 'CLUB_JOINED', cluster: deps.env.SOLANA_CLUSTER, symbol: '', mint: null, decimals: 0, amountRaw: '0',
          status: 'CONFIRMED', signature: null, campaignId: null, campaignType: null, counterparty: null, title: club.name, clubSlug: club.slug, at: m.joinedAt.toISOString(),
        })
      }
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    return { items: items.slice(0, 200) }
  })

  // ---- D-37: public profile (username + picture) ----

  function requireProfiles() {
    if (!deps.profiles) throw new ClaimError('PROFILES_UNAVAILABLE', 'profiles are not available right now', 503)
    return deps.profiles
  }
  const profileView = (p: Awaited<ReturnType<ProfileStore['get']>>) => ({ username: p?.username ?? null, avatarUrl: avatarPath(p) })

  app.get('/v1/me/profile', async (req) => {
    const auth = await requireAuth(req)
    return { profile: profileView(await requireProfiles().get(auth.privyUserId)) }
  })

  app.put('/v1/me/profile', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = profileUpdateRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    const name = parsed.data.username || null
    const problem = name ? usernameProblem(name) : null
    if (problem) return sendError(reply, 400, 'INVALID_USERNAME', problem)
    try {
      return { profile: profileView(await requireProfiles().setUsername(auth.privyUserId, name)) }
    } catch (err) {
      if (err instanceof UsernameTakenError) return sendError(reply, 409, 'USERNAME_TAKEN', 'that username is taken')
      throw err
    }
  })

  app.put('/v1/me/avatar', { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = avatarUploadRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', 'send a small JPEG or PNG')
    const bytes = Uint8Array.from(Buffer.from(parsed.data.image, 'base64'))
    const type = sniffImage(bytes)
    if (!type) return sendError(reply, 400, 'INVALID_IMAGE', 'only JPEG or PNG pictures are supported')
    if (bytes.length > AVATAR_MAX_BYTES) return sendError(reply, 413, 'IMAGE_TOO_LARGE', 'that picture is too large')
    return { profile: profileView(await requireProfiles().setAvatar(auth.privyUserId, { bytes, type })) }
  })

  app.delete('/v1/me/avatar', async (req) => {
    const auth = await requireAuth(req)
    return { profile: profileView(await requireProfiles().setAvatar(auth.privyUserId, null)) }
  })

  /** Public profile pictures by opaque id; versioned URLs, so they can be cached for a long time. */
  app.get<{ Params: { publicId: string } }>('/v1/avatars/:publicId', async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{8,20}$/.test(req.params.publicId)) return sendError(reply, 404, 'NOT_FOUND', 'not found')
    const img = await requireProfiles().avatar(req.params.publicId)
    if (!img) return sendError(reply, 404, 'NOT_FOUND', 'not found')
    return reply
      .header('content-type', img.type)
      .header('cache-control', 'public, max-age=604800, immutable')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(img.bytes))
  })

  // ---- D-32: the Blink stock wallet: balances, Receive (address) and sponsored Send ----

  function requireSend() {
    if (!deps.send) throw new ClaimError('SEND_UNAVAILABLE', 'sending is not available right now', 503)
    return deps.send
  }

  app.get('/v1/me/wallet', async (req) => {
    const auth = await requireAuth(req)
    return { wallet: await requireSend().balances(auth.privyUserId) }
  })

  app.post('/v1/me/send/prepare', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    // Blink pays these fees: at most 20 sends per user per day.
    if (!limiter.hit(`send:${auth.privyUserId}`, 20, 24 * 60 * 60 * 1000)) {
      throw new ClaimError('RATE_LIMITED', 'you have reached today’s sending limit — try again tomorrow', 429)
    }
    const parsed = sendPrepareRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    return {
      prepared: await requireSend().prepare(auth.privyUserId, req.ip, { asset: parsed.data.asset, to: parsed.data.to, amountRaw: BigInt(parsed.data.amountRaw) }),
    }
  })

  app.post('/v1/me/send/submit', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = sendSubmitRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    return requireSend().submit(auth.privyUserId, parsed.data.signedTransaction)
  })

  // ---- D-24: push notifications ----

  app.post('/v1/me/push-token', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = pushTokenRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    if (!deps.pushTokens) throw new ClaimError('PUSH_UNAVAILABLE', 'notifications are not available right now', 503)
    await deps.pushTokens.save(parsed.data.token, auth.privyUserId, parsed.data.platform)
    return { ok: true }
  })

  /** Sign-out: stop notifications for this device (only the caller's own token is removed). */
  app.delete('/v1/me/push-token', async (req, reply) => {
    const auth = await requireAuth(req)
    const parsed = pushTokenDeleteRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    await deps.pushTokens?.remove(parsed.data.token, auth.privyUserId)
    return { ok: true }
  })

  // ---- D-23: in-app SKR staking (mainnet; the user's own wallet signs and sends) ----

  /** Only wallets Privy has verified for the caller (SIWS-linked), so Blink never builds for someone else's wallet. */
  async function requireOwnSkrWallet(req: FastifyRequest, wallet: string) {
    const auth = await requireAuth(req)
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    if (!wallets.includes(wallet)) throw new ClaimError('WALLET_NOT_LINKED', 'link this wallet to your Blink account first', 403)
    if (!deps.skr) throw new ClaimError('SKR_UNAVAILABLE', 'SKR staking is not available right now', 503)
    return { auth, skr: deps.skr }
  }

  app.get<{ Querystring: { wallet?: string } }>('/v1/skr/position', async (req, reply) => {
    const wallet = req.query.wallet ?? ''
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return sendError(reply, 400, 'INVALID_REQUEST', 'invalid wallet address')
    const { skr } = await requireOwnSkrWallet(req, wallet)
    try {
      return { position: await skr.position(wallet) }
    } catch (err) {
      if (err instanceof SkrStakeError) throw err
      req.log.warn({ err }, 'SKR position read failed')
      throw new ClaimError('SKR_READ_FAILED', 'could not read SKR on mainnet right now — try again', 503)
    }
  })

  app.post('/v1/skr/prepare', async (req, reply) => {
    const parsed = skrPrepareRequest.safeParse(req.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    const { auth, skr } = await requireOwnSkrWallet(req, parsed.data.wallet)
    throttle(req, auth)
    const { wallet, action, amountRaw, all } = parsed.data
    try {
      return { prepared: await skr.prepare(wallet, action, amountRaw ? BigInt(amountRaw) : undefined, all) }
    } catch (err) {
      if (err instanceof SkrStakeError) throw err
      req.log.warn({ err }, 'SKR prepare failed')
      throw new ClaimError('SKR_READ_FAILED', 'could not reach mainnet right now — try again', 503)
    }
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

    // D-40: a drop can be posted only in a club the creator belongs to.
    if (body.clubId) {
      const member = deps.social ? await deps.social.membership(body.clubId, auth.privyUserId) : null
      if (!member) return sendError(reply, 403, 'NOT_A_MEMBER', 'you can only post drops in clubs you belong to')
    }

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

    // D-33: ORE mining counts only after this campaign starts, so record the round being mined right now.
    let requirements = body.requirements ?? null
    if (requirements && questUses(requirements, 'ORE_ACTIVITY')) {
      try {
        if (!deps.quests) throw new Error('quests not configured')
        requirements = stampOreRound(requirements, await deps.quests.currentOreRound())
      } catch (err) {
        req.log.warn({ err }, 'ORE round read failed')
        return sendError(reply, 503, 'ORE_UNAVAILABLE', 'could not read ORE on mainnet right now — try again')
      }
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
      tapRush:
        body.type === 'TAP_RUSH' || (body.requirements && questHasTapRush(body.requirements)) ? (body.tapRush ?? TAP_RUSH_DEFAULTS) : null,
      // D-21: frozen requirements + a hash of their canonical JSON (immutable once LIVE; no edit endpoint exists).
      requirements,
      requirementsHash: requirements ? createHash('sha256').update(JSON.stringify(requirements)).digest('hex') : null,
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: body.endsAt ? new Date(body.endsAt) : null,
      clubId: body.clubId ?? null,
      membersOnly: Boolean(body.membersOnly),
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
    // D-20: creators distributing xStocks pass the same gate; owning the campaign account is no exemption.
    if (deps.env.XSTOCK_COMPLIANCE === 'enforce') {
      if (!deps.eligibility) throw new ClaimError('ELIGIBILITY_UNAVAILABLE', 'eligibility checks are not available right now', 503)
      await deps.eligibility.requireEligible(c.creatorPrivyUserId, req.ip)
    }
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
    const wentLive = await deps.campaigns.transitionStatus(funded.id, 'AWAITING_DELEGATION', 'LIVE')
    if (wentLive) {
      void notifier.notify(wentLive.creatorPrivyUserId, {
        title: 'Your drop is live',
        body: `Your ${wentLive.xstockSymbol} drop is open. Share the link or QR to start the room.`,
        url: `/campaign/${wentLive.id}`,
      })
    }
    return { campaign: wentLive ?? funded, verified: true }
  }

  function req_log_problems(problems: string[]) {
    if (problems.length) app.log.warn({ problems }, 'funding not verified onchain yet')
  }

  // ---- Recipient claims and Tap Rush (DECISIONS D-13) ----

  function requireClaims(): ClaimService {
    if (!deps.claims) throw new ClaimError('CLAIMS_UNAVAILABLE', 'claiming is not enabled on this server', 503)
    return new ClaimService({ env: deps.env, auth: deps.auth, campaigns: deps.campaigns, claims: deps.claims, payouts: deps.payouts, log: app.log, limiter, seeker: deps.seeker, eligibility: deps.eligibility, quests: deps.quests, profiles: deps.profiles, social: deps.social })
  }

  async function claimResponse(claim: StoredClaim | null) {
    if (!claim) return { claim: null }
    const campaign = await deps.campaigns.findById(claim.campaignId)
    return { claim: campaign ? toClaimSummary(claim, campaign) : null }
  }

  /** D-21: check the caller's Verified Quest requirements now (server-side, current onchain state). */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/verify', async (req) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    return { evaluation: await requireClaims().verify(auth, req.params.id) }
  })

  /** D-21: public live room (polled by the app). Real aggregates only; no emails, ids, countries or compliance data. */
  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/room', async (req) => {
    return { room: await requireClaims().room(req.params.id) }
  })

  /** Starts a server-timed Tap Rush round. The client starts its timer when this returns. */
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/tap-rush/start', async (req) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    return { session: await requireClaims().startTapRush(auth, req.params.id, req.ip) }
  })

  // D-36: rounds of up to 2 minutes carry up to 2,400 tap timings, more than the default 16 KB body limit.
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/tap-rush/finish', { bodyLimit: 64 * 1024 }, async (req, reply) => {
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
    return claimResponse(await requireClaims().retryBonus(auth, req.params.id, req.ip))
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

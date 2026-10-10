import { randomUUID } from 'node:crypto'

import type { BlinkEnv } from '@blink/config'
import { type HistoryItem, OG_TYPES } from '@blink/domain'
import {
  buildOreDeployTransaction,
  buildSkrTransferTransaction,
  normalizeJsonTransaction,
  ORE_SQUARES,
  OreDeployError,
  readOreLiveBoard,
  type RpcJsonTransaction,
  SKR_MINT,
  SkrTransferError,
  type TokenBalanceTx,
  verifyOreDeployTx,
  verifySkrTransfer,
} from '@blink/solana'
import { address, type createSolanaRpc } from '@solana/kit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { AuthContext, AuthVerifier } from './auth.ts'
import type { CampaignRepository } from './campaign-repo.ts'
import { type ChainActivityStore, SignatureReusedError, type StoredBoost, type StoredTip } from './chain-activity-store.ts'
import { ClaimError } from './payout-service.ts'
import type { Notifier } from './push.ts'
import type { RateLimiter } from './rate-limit.ts'
import { profileExtras, type ProfileStore } from './profile.ts'
import { resolveNames } from './gift-routes.ts'
import { resolveSkrIdentity, type SkrNameResolver } from './skr-identity.ts'
import { memberRef } from './social-routes.ts'
import type { SocialStore } from './social-store.ts'
import { WalletTxRelay } from './wallet-relay.ts'

/*
 * D-49 SKR tips · D-50 SKR boosts · D-51 ORE live grid · D-52 .skr identity.
 * Every money movement here is built by Blink, signed and paid by the user's OWN wallet (MWA), relayed only if
 * byte-identical to what Blink built, and recorded only after the server re-verified the confirmed transaction.
 * Blink never signs, never holds user funds and never grants itself an allowance.
 */

type MainnetRpc = ReturnType<typeof createSolanaRpc>

export interface SkrOreDeps {
  env: BlinkEnv
  auth: AuthVerifier
  requireAuth: (req: FastifyRequest) => Promise<AuthContext>
  limiter: RateLimiter
  campaigns: CampaignRepository
  store: ChainActivityStore
  /** Mainnet RPC used to build, simulate, relay and verify (SKR and ORE exist only there). */
  rpc: MainnetRpc
  relay: WalletTxRelay
  social?: SocialStore
  profiles?: ProfileStore
  skrNames?: SkrNameResolver
  notifier: Notifier
}

const DAY = 24 * 60 * 60_000
/** Sanity cap on a single tip: 10,000 SKR (raw, 6 decimals). Real limits come from the sender's balance. */
const MAX_TIP_RAW = 10_000_000_000n
const raw = z.string().regex(/^[1-9]\d{0,19}$/)
const walletField = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional()
const tipPrepare = z.object({ to: z.string().regex(/^[0-9a-f]{16}$/), amountRaw: raw, wallet: walletField })
const directTip = z.object({ to: z.string().min(1).max(70), amountRaw: raw, wallet: walletField })
const signed = z.object({ signedTransaction: z.string().min(100).max(4000) })
const boostPrepare = z.object({ wallet: walletField })
const orePrepare = z.object({
  squares: z.array(z.number().int().min(0).max(ORE_SQUARES - 1)).min(1).max(ORE_SQUARES),
  amountLamports: raw,
  wallet: walletField,
})
const oreVerify = z.object({ signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) })

const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`

export function featureConfig(env: BlinkEnv) {
  const mainnet = env.SOLANA_CLUSTER === 'mainnet-beta'
  const boostReady = mainnet && env.SKR_BOOST_ENABLED && env.SKR_BOOST_PRICE_RAW !== undefined && env.SKR_BOOST_HOURS !== undefined && Boolean(env.SKR_BOOST_DESTINATION)
  return {
    network: env.SOLANA_CLUSTER,
    tips: { enabled: mainnet && env.SKR_TIPS_ENABLED, maxRaw: MAX_TIP_RAW.toString() },
    boost: boostReady
      ? { enabled: true, priceRaw: env.SKR_BOOST_PRICE_RAW!.toString(), hours: env.SKR_BOOST_HOURS!, destination: env.SKR_BOOST_DESTINATION!, refundable: false }
      : { enabled: false },
    ore: {
      deployEnabled: mainnet && env.ORE_DEPLOY_ENABLED && env.ORE_MAX_LAMPORTS_PER_SQUARE !== undefined,
      maxLamportsPerSquare: env.ORE_MAX_LAMPORTS_PER_SQUARE?.toString() ?? null,
      maxSquares: env.ORE_MAX_SQUARES,
      clubSlug: env.ORE_CLUB_SLUG ?? null,
      // D-51 compliance gate: deploys never unlock xStock rewards unless the owner approved it.
      rewardsEnabled: env.ORE_REWARDS_ENABLED,
    },
  }
}

/** Maps builder errors to consumer-safe API errors (codes stable, no raw program logs). */
function toClaimError(err: unknown): never {
  if (err instanceof SkrTransferError) {
    const status = err.code === 'SIMULATION_FAILED' ? 422 : 400
    if (err.logs.length) console.error(JSON.stringify({ msg: 'skr transfer build failed', code: err.code, logs: err.logs.slice(-8) }))
    throw new ClaimError(`SKR_${err.code}`, err.message, status)
  }
  if (err instanceof OreDeployError) {
    if (err.logs.length) console.error(JSON.stringify({ msg: 'ore deploy build failed', code: err.code, logs: err.logs.slice(-8) }))
    throw new ClaimError(`ORE_${err.code}`, err.message, err.code === 'SIMULATION_FAILED' ? 422 : 409)
  }
  throw err
}

export function registerSkrOreRoutes(app: FastifyInstance, deps: SkrOreDeps) {
  const { env, store, relay } = deps
  const features = () => featureConfig(env)

  /** The signer wallet: a SIWS-verified external wallet of the caller (the requested one, or the most recent). */
  async function callerWallet(auth: AuthContext, requested?: string): Promise<string> {
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const wallet = requested ? wallets.find((w) => w === requested) : wallets[0]
    if (!wallet) throw new ClaimError('NO_VERIFIED_WALLET', 'connect and verify a Solana wallet first (Profile → Wallets)', 409)
    return wallet
  }

  async function personView(privyUserId: string) {
    const p = deps.profiles ? await deps.profiles.get(privyUserId) : null
    return { label: p?.skrName ?? (p?.username ? `@${p.username}` : 'Blink member'), username: p?.username ?? undefined, ...profileExtras(p) }
  }

  /** Public feature flags and owner-approved packages; the app shows nothing that isn't enabled here. */
  app.get('/v1/features', async () => features())

  // ── D-52: .skr identity ────────────────────────────────────────────────────────────
  app.post('/v1/me/skr-identity', async (req) => {
    const auth = await deps.requireAuth(req)
    if (!deps.profiles || !deps.skrNames) throw new ClaimError('SKR_IDENTITY_UNAVAILABLE', '.skr checks are not available right now', 503)
    if (!deps.limiter.hit(`skrid:${auth.privyUserId}`, 3, 10 * 60_000)) throw new ClaimError('RATE_LIMITED', 'you just checked — try again in a few minutes', 429)
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const result = await resolveSkrIdentity(deps.skrNames, wallets)
    // "Unable to verify" never clears or sets a name; only a completed check changes it.
    if (result.status === 'VERIFIED') await deps.profiles.setSkr(auth.privyUserId, { name: result.name, wallet: result.wallet })
    if (result.status === 'NONE') await deps.profiles.setSkr(auth.privyUserId, null)
    const p = await deps.profiles.get(auth.privyUserId)
    return { status: result.status, skrName: p?.skrName ?? null, skrWallet: p?.skrWallet ?? null, checkedAt: p?.skrCheckedAt?.toISOString() ?? null }
  })

  // ── D-49: SKR tips ─────────────────────────────────────────────────────────────────
  const tipView = async (t: StoredTip, viewer: string) => ({
    id: t.id,
    direction: t.senderPrivyUserId === viewer ? 'SENT' : 'RECEIVED',
    amountRaw: t.amountRaw.toString(),
    status: t.status,
    signature: t.signature,
    network: t.cluster,
    from: await personView(t.senderPrivyUserId),
    to: await personView(t.recipientPrivyUserId),
    recipientWallet: t.recipientWallet,
    createdAt: t.createdAt.toISOString(),
    confirmedAt: t.confirmedAt?.toISOString() ?? null,
  })

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/tips/prepare', async (req) => {
    const auth = await deps.requireAuth(req)
    if (!features().tips.enabled) throw new ClaimError('SKR_TIPS_DISABLED', 'SKR tips aren’t available right now', 503)
    if (!deps.social) throw new ClaimError('CLUBS_UNAVAILABLE', 'clubs are not available right now', 503)
    const body = tipPrepare.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'invalid tip', 400)
    const amountRaw = BigInt(body.data.amountRaw)
    if (amountRaw > MAX_TIP_RAW) throw new ClaimError('SKR_TIP_TOO_LARGE', 'that tip is larger than Blink allows (10,000 SKR)', 400)
    if (!deps.limiter.hit(`tip:${auth.privyUserId}`, 30, DAY)) throw new ClaimError('RATE_LIMITED', 'you have reached today’s tipping limit', 429)
    const club = await deps.social.findClub(req.params.slug)
    if (!club) throw new ClaimError('NOT_FOUND', 'club not found', 404)
    const me = await deps.social.membership(club.id, auth.privyUserId)
    if (!me) throw new ClaimError('NOT_A_MEMBER', 'join the club first', 403)
    if (me.mutedUntil && me.mutedUntil.getTime() > Date.now()) throw new ClaimError('MUTED', 'you are muted in this club', 403)
    const target = (await deps.social.members(club.id, 5000)).find((m) => memberRef(club.id, m.privyUserId) === body.data.to)
    if (!target) throw new ClaimError('NOT_FOUND', 'that person is not in this club', 404)
    if (target.privyUserId === auth.privyUserId) throw new ClaimError('SELF_TIP', 'you can’t tip yourself', 400)

    return prepareTip(auth, target.privyUserId, club.id, amountRaw, body.data.wallet)
  })

  /** "Gift a person" with SKR: the recipient is found by Blink username or verified .skr name (no club needed). */
  app.post('/v1/skr/gifts/prepare', async (req) => {
    const auth = await deps.requireAuth(req)
    if (!features().tips.enabled) throw new ClaimError('SKR_TIPS_DISABLED', 'SKR gifts aren’t available right now', 503)
    if (!deps.profiles) throw new ClaimError('PROFILES_UNAVAILABLE', 'people search is not available right now', 503)
    const body = directTip.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'invalid gift', 400)
    const amountRaw = BigInt(body.data.amountRaw)
    if (amountRaw > MAX_TIP_RAW) throw new ClaimError('SKR_TIP_TOO_LARGE', 'that is larger than Blink allows (10,000 SKR)', 400)
    if (!deps.limiter.hit(`tip:${auth.privyUserId}`, 30, DAY)) throw new ClaimError('RATE_LIMITED', 'you have reached today’s SKR sending limit', 429)
    const [target] = await resolveNames(deps.profiles, [body.data.to])
    if (!target?.found) throw new ClaimError('PERSON_NOT_FOUND', `${body.data.to} isn’t on Blink`, 404)
    if (target.privyUserId === auth.privyUserId) throw new ClaimError('SELF_TIP', 'you can’t gift yourself', 400)
    return prepareTip(auth, target.privyUserId, null, amountRaw, body.data.wallet)
  })

  /** Builds and records a sender-paid SKR transfer to `recipient` (club tip or direct gift). */
  async function prepareTip(auth: AuthContext, recipient: string, clubId: string | null, amountRaw: bigint, requestedWallet?: string) {
    const from = await callerWallet(auth, requestedWallet)
    // Recipient: their most recently verified (SIWS) wallet, else their Blink wallet — both bound to their login.
    const [external] = await deps.auth.getVerifiedExternalSolanaWallets(recipient)
    const [embedded] = await deps.auth.getEmbeddedSolanaWallets(recipient)
    const to = external ?? embedded
    if (!to) throw new ClaimError('NO_RECIPIENT_WALLET', 'this person has no wallet that can receive SKR yet', 409)
    if (to === from) throw new ClaimError('SELF_TIP', 'that’s your own wallet', 400)

    const plan = await buildSkrTransferTransaction(deps.rpc, { from: address(from), to: address(to), amountRaw }).catch(toClaimError)
    const tip = await store.createTip({
      id: randomUUID(), senderPrivyUserId: auth.privyUserId, recipientPrivyUserId: recipient, senderWallet: from, recipientWallet: to,
      clubId, amountRaw, cluster: env.SOLANA_CLUSTER,
    })
    relay.remember(`tip:${tip.id}`, plan.transaction, from)
    return {
      tipId: tip.id,
      transaction: plan.transaction,
      review: {
        amountRaw: amountRaw.toString(),
        token: { symbol: 'SKR', mint: SKR_MINT, decimals: 6 },
        recipient: await personView(recipient),
        recipientWallet: to,
        recipientWalletKind: external ? 'VERIFIED_WALLET' : 'BLINK_WALLET',
        senderWallet: from,
        createsRecipientAccount: plan.createsRecipientAccount,
        rentLamports: plan.rentLamports.toString(),
        networkFeeLamports: plan.feeLamports.toString(),
        network: 'Solana Mainnet',
      },
    }
  }

  /** Submit the signed tip; idempotent by signature. A client callback alone never marks a tip as sent. */
  app.post<{ Params: { id: string } }>('/v1/skr/tips/:id/submit', async (req) => {
    const auth = await deps.requireAuth(req)
    const body = signed.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid transaction', 400)
    const tip = await store.getTip(req.params.id)
    if (!tip || tip.senderPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_FOUND', 'tip not found', 404)
    if (tip.status === 'CONFIRMED') return { tip: await tipView(tip, auth.privyUserId) }
    if (tip.status !== 'PREPARED') throw new ClaimError('TIP_CLOSED', 'this tip can no longer be sent — start a new one', 409)
    const signature = WalletTxRelay.signatureOf(body.data.signedTransaction)
    if (!signature) throw new ClaimError('INVALID_TRANSACTION', 'could not read the signed transaction', 400)
    try {
      await store.markTipSubmitted(tip.id, signature)
    } catch (err) {
      if (err instanceof SignatureReusedError) throw new ClaimError('SIGNATURE_REUSED', 'this transaction was already used', 409)
      throw err
    }
    await relayOrRecord(`tip:${tip.id}`, body.data.signedTransaction, (status, why) => store.markTipFailed(tip.id, status, why))
    return { tip: await tipView(await confirmTip(tip.id), auth.privyUserId) }
  })

  /** Re-checks a SUBMITTED tip onchain (after a timeout or a server restart). */
  app.get<{ Params: { id: string } }>('/v1/skr/tips/:id', async (req) => {
    const auth = await deps.requireAuth(req)
    const tip = await store.getTip(req.params.id)
    if (!tip || (tip.senderPrivyUserId !== auth.privyUserId && tip.recipientPrivyUserId !== auth.privyUserId)) throw new ClaimError('NOT_FOUND', 'tip not found', 404)
    if (tip.status === 'SUBMITTED' && tip.signature) {
      const found = await deps.rpc.getSignatureStatuses([tip.signature as never], { searchTransactionHistory: true }).send()
      const s = found.value[0]
      if (s?.err) await store.markTipFailed(tip.id, 'FAILED', 'failed onchain')
      else if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return { tip: await tipView(await confirmTip(tip.id), auth.privyUserId) }
    }
    return { tip: await tipView((await store.getTip(tip.id))!, auth.privyUserId) }
  })

  async function confirmTip(id: string): Promise<StoredTip> {
    const tip = (await store.getTip(id))!
    const tx = (await relay.confirmedTransaction(tip.signature!)) as TokenBalanceTx
    const verdict = verifySkrTransfer(tx, { from: tip.senderWallet, to: tip.recipientWallet, amountRaw: tip.amountRaw })
    if (!verdict.ok) {
      await store.markTipFailed(tip.id, 'FAILED', verdict.reason)
      throw new ClaimError('TIP_NOT_VERIFIED', 'the transfer could not be verified onchain', 422)
    }
    const confirmed = await store.markTipConfirmed(tip.id, new Date())
    const sender = await personView(tip.senderPrivyUserId)
    void deps.notifier.notify(tip.recipientPrivyUserId, { title: 'You got an SKR tip', body: `${sender.label} tipped you ${formatSkr(tip.amountRaw)} SKR`, url: '/history' }).catch(() => {})
    return confirmed
  }

  /** Relays; maps terminal failures onto the record, leaves timeouts as SUBMITTED for a later re-check. */
  async function relayOrRecord(key: string, signedTx: string, fail: (status: 'FAILED' | 'EXPIRED', why: string) => Promise<void>) {
    try {
      await relay.relay(key, signedTx)
    } catch (err) {
      if (err instanceof ClaimError) {
        if (err.code === 'EXPIRED') await fail('EXPIRED', err.message)
        else if (err.code !== 'CONFIRMATION_TIMEOUT') await fail('FAILED', err.code)
      }
      throw err
    }
  }

  // ── D-50: SKR boosts (featured placement for a funded, live drop) ───────────────────
  const boostView = (b: StoredBoost) => ({
    id: b.id,
    campaignId: b.campaignId,
    amountRaw: b.amountRaw.toString(),
    hours: b.hours,
    destination: b.destination,
    status: b.status,
    signature: b.signature,
    startsAt: b.startsAt?.toISOString() ?? null,
    endsAt: b.endsAt?.toISOString() ?? null,
    network: b.cluster,
  })

  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/boost/prepare', async (req) => {
    const auth = await deps.requireAuth(req)
    const cfg = features().boost
    if (!cfg.enabled || env.SKR_BOOST_PRICE_RAW === undefined || env.SKR_BOOST_HOURS === undefined || !env.SKR_BOOST_DESTINATION) {
      throw new ClaimError('SKR_BOOST_DISABLED', 'SKR boosts aren’t available yet', 503)
    }
    const body = boostPrepare.safeParse(req.body ?? {})
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid request', 400)
    const campaign = /^[0-9a-f-]{36}$/.test(req.params.id) ? await deps.campaigns.findById(req.params.id) : null
    if (!campaign) throw new ClaimError('NOT_FOUND', 'drop not found', 404)
    // P0: the creator boosts their own funded drop (community contributions are P1).
    if (campaign.creatorPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_CREATOR', 'only the drop’s creator can boost it', 403)
    if (campaign.cluster !== env.SOLANA_CLUSTER) throw new ClaimError('WRONG_NETWORK', 'this drop is on another network', 409)
    if (campaign.status !== 'LIVE') throw new ClaimError('BOOST_NOT_LIVE', 'only funded, live drops can be boosted', 409)
    if (campaign.endsAt && campaign.endsAt.getTime() <= Date.now()) throw new ClaimError('BOOST_NOT_LIVE', 'this drop has ended', 409)
    if (!deps.limiter.hit(`boost:${auth.privyUserId}`, 10, DAY)) throw new ClaimError('RATE_LIMITED', 'too many boost attempts today', 429)
    const from = await callerWallet(auth, body.data.wallet)
    const plan = await buildSkrTransferTransaction(deps.rpc, { from: address(from), to: address(env.SKR_BOOST_DESTINATION), amountRaw: env.SKR_BOOST_PRICE_RAW }).catch(toClaimError)
    const boost = await store.createBoost({
      id: randomUUID(), campaignId: campaign.id, payerPrivyUserId: auth.privyUserId, payerWallet: from, destination: env.SKR_BOOST_DESTINATION,
      amountRaw: env.SKR_BOOST_PRICE_RAW, hours: env.SKR_BOOST_HOURS, cluster: env.SOLANA_CLUSTER,
    })
    relay.remember(`boost:${boost.id}`, plan.transaction, from)
    const current = (await store.activeBoosts([campaign.id], new Date())).get(campaign.id) ?? null
    return {
      boostId: boost.id,
      transaction: plan.transaction,
      review: {
        amountRaw: env.SKR_BOOST_PRICE_RAW.toString(),
        token: { symbol: 'SKR', mint: SKR_MINT, decimals: 6 },
        hours: env.SKR_BOOST_HOURS,
        destination: env.SKR_BOOST_DESTINATION,
        payerWallet: from,
        placement: 'Featured in its club and eligible for Featured on Home, labelled “Boosted with SKR”.',
        startsAt: current ? current.toISOString() : 'when the payment confirms',
        refundable: false,
        ifDropEnds: 'Featured placement stops when the drop pauses, ends or runs out. Completed SKR payments are not refunded.',
        createsRecipientAccount: plan.createsRecipientAccount,
        rentLamports: plan.rentLamports.toString(),
        networkFeeLamports: plan.feeLamports.toString(),
        network: 'Solana Mainnet',
      },
    }
  })

  app.post<{ Params: { id: string; boostId: string } }>('/v1/campaigns/:id/boost/:boostId/submit', async (req) => {
    const auth = await deps.requireAuth(req)
    const body = signed.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid transaction', 400)
    const boost = await store.getBoost(req.params.boostId)
    if (!boost || boost.campaignId !== req.params.id || boost.payerPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_FOUND', 'boost not found', 404)
    if (boost.status === 'CONFIRMED') return { boost: boostView(boost) }
    if (boost.status !== 'PREPARED') throw new ClaimError('BOOST_CLOSED', 'this boost can no longer be paid — start a new one', 409)
    const signature = WalletTxRelay.signatureOf(body.data.signedTransaction)
    if (!signature) throw new ClaimError('INVALID_TRANSACTION', 'could not read the signed transaction', 400)
    try {
      await store.markBoostSubmitted(boost.id, signature)
    } catch (err) {
      if (err instanceof SignatureReusedError) throw new ClaimError('SIGNATURE_REUSED', 'this transaction was already used', 409)
      throw err
    }
    await relayOrRecord(`boost:${boost.id}`, body.data.signedTransaction, (status, why) => store.markBoostFailed(boost.id, status, why))
    return { boost: boostView(await activateBoost(boost.id)) }
  })

  app.get<{ Params: { id: string; boostId: string } }>('/v1/campaigns/:id/boost/:boostId', async (req) => {
    const auth = await deps.requireAuth(req)
    const boost = await store.getBoost(req.params.boostId)
    if (!boost || boost.campaignId !== req.params.id || boost.payerPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_FOUND', 'boost not found', 404)
    if (boost.status === 'SUBMITTED' && boost.signature) {
      const s = (await deps.rpc.getSignatureStatuses([boost.signature as never], { searchTransactionHistory: true }).send()).value[0]
      if (s?.err) await store.markBoostFailed(boost.id, 'FAILED', 'failed onchain')
      else if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return { boost: boostView(await activateBoost(boost.id)) }
    }
    return { boost: boostView((await store.getBoost(boost.id))!) }
  })

  async function activateBoost(id: string): Promise<StoredBoost> {
    const boost = (await store.getBoost(id))!
    const tx = (await relay.confirmedTransaction(boost.signature!)) as TokenBalanceTx
    const verdict = verifySkrTransfer(tx, { from: boost.payerWallet, to: boost.destination, amountRaw: boost.amountRaw })
    if (!verdict.ok) {
      await store.markBoostFailed(boost.id, 'FAILED', verdict.reason)
      throw new ClaimError('BOOST_NOT_VERIFIED', 'the payment could not be verified onchain', 422)
    }
    // Server time sets the window; the client never chooses its own featured status.
    return store.activateBoost(boost.id, new Date())
  }

  // ── D-51: ORE live grid ────────────────────────────────────────────────────────────
  let boardCache: { at: number; data: Awaited<ReturnType<typeof readOreLiveBoard>> } | null = null
  async function liveBoard() {
    if (!boardCache || Date.now() - boardCache.at > 2000) boardCache = { at: Date.now(), data: await readOreLiveBoard(deps.rpc) }
    return boardCache.data
  }

  /** Public: the current ORE round as read from the Board and Round accounts (lamports, miners per square). */
  app.get('/v1/ore/board', async () => {
    let live
    try {
      live = await liveBoard()
    } catch (err) {
      console.error(JSON.stringify({ msg: 'ore board read failed', error: String((err as Error)?.message ?? err).slice(0, 200) }))
      throw new ClaimError('ORE_UNAVAILABLE', 'the ORE board can’t be read right now', 503)
    }
    const slotsLeft = live.phase === 'MINING' ? live.board.endSlot - live.slot : 0n
    return {
      roundId: live.board.roundId.toString(),
      phase: live.phase,
      slot: live.slot.toString(),
      endSlot: live.phase === 'WAITING' ? null : live.board.endSlot.toString(),
      slotsLeft: slotsLeft.toString(),
      // Slots are ~400 ms; an estimate for display only.
      secondsLeftEstimate: Math.round(Number(slotsLeft) * 0.4),
      squares: live.round.deployed.map((lamports, i) => ({ index: i, deployedLamports: lamports.toString(), miners: Number(live.round.count[i]) })),
      totalDeployedLamports: live.round.deployed.reduce((a, b) => a + b, 0n).toString(),
      totalMiners: Number(live.round.totalMiners),
      readAt: new Date().toISOString(),
      config: features().ore,
    }
  })

  /** The caller's ORE status: this round's squares for their wallet and their verified deploys in Blink. */
  app.get('/v1/ore/me', async (req) => {
    const auth = await deps.requireAuth(req)
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const wallet = wallets[0] ?? null
    let thisRound: number[] = []
    let roundId: string | null = null
    if (wallet) {
      try {
        const live = await readOreLiveBoard(deps.rpc, address(wallet))
        roundId = live.board.roundId.toString()
        if (live.miner && live.miner.roundId === live.board.roundId) thisRound = live.miner.deployed.flatMap((v, i) => (v > 0n ? [i] : []))
      } catch {
        // Board unreadable: the app shows the verified history only.
      }
    }
    const proofs = await store.oreDeploysFor(auth.privyUserId, 20)
    return {
      wallet,
      roundId,
      squaresThisRound: thisRound,
      verifiedDeploys: proofs.length,
      minerMark: proofs.length > 0,
      recent: proofs.slice(0, 5).map((p) => ({ signature: p.signature, roundId: p.roundId.toString(), squares: p.squares, totalLamports: p.totalLamports.toString(), at: p.deployedAt.toISOString() })),
    }
  })

  app.post('/v1/ore/deploy/prepare', async (req) => {
    const auth = await deps.requireAuth(req)
    const cfg = features().ore
    if (!cfg.deployEnabled || env.ORE_MAX_LAMPORTS_PER_SQUARE === undefined) throw new ClaimError('ORE_DEPLOY_DISABLED', 'ORE deploys aren’t available in Blink yet', 503)
    const body = orePrepare.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'invalid deploy', 400)
    const amount = BigInt(body.data.amountLamports)
    const squares = [...new Set(body.data.squares)]
    if (amount > env.ORE_MAX_LAMPORTS_PER_SQUARE) throw new ClaimError('ORE_AMOUNT_TOO_HIGH', 'that is above Blink’s limit per square', 400)
    if (squares.length > env.ORE_MAX_SQUARES) throw new ClaimError('ORE_TOO_MANY_SQUARES', `pick at most ${env.ORE_MAX_SQUARES} square${env.ORE_MAX_SQUARES === 1 ? '' : 's'}`, 400)
    if (!deps.limiter.hit(`ore:${auth.privyUserId}`, 30, DAY)) throw new ClaimError('RATE_LIMITED', 'too many deploy attempts today', 429)
    const wallet = await callerWallet(auth, body.data.wallet)
    const plan = await buildOreDeployTransaction(deps.rpc, { authority: address(wallet), amountLamports: amount, squares }).catch(toClaimError)
    relay.remember(`ore:${auth.privyUserId}`, plan.transaction, wallet)
    return {
      transaction: plan.transaction,
      review: {
        wallet,
        roundId: plan.roundId.toString(),
        squares: plan.squares,
        lamportsPerSquare: plan.amountLamports.toString(),
        cost: Object.fromEntries(Object.entries(plan.cost).map(([k, v]) => [k, v.toString()])),
        includesCheckpoint: plan.needsCheckpoint,
        roundEndsInSlots: (plan.endSlot - plan.slot).toString(),
        risk: 'This commits real SOL to an ORE round. You may lose it or get back only part of it. ORE rewards are not guaranteed. This is not a network fee.',
        network: 'Solana Mainnet',
      },
    }
  })

  /** Submit the signed deploy; the proof is recorded only from the confirmed transaction's own DeployEvent. */
  app.post('/v1/ore/deploy/submit', async (req) => {
    const auth = await deps.requireAuth(req)
    const body = signed.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid transaction', 400)
    const signature = await relay.relay(`ore:${auth.privyUserId}`, body.data.signedTransaction).catch((err) => {
      if (err instanceof ClaimError && err.code === 'TRANSACTION_FAILED') {
        throw new ClaimError('ORE_DEPLOY_FAILED', 'the deploy failed onchain (the round may have ended) — no SOL was deployed, only the network fee was charged', 422)
      }
      throw err
    })
    return { deploy: await recordDeploy(auth, signature) }
  })

  /** Verifies a deploy the user made with one of their verified wallets elsewhere (any past round). */
  app.post('/v1/ore/deploy/verify', async (req) => {
    const auth = await deps.requireAuth(req)
    const body = oreVerify.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid signature', 400)
    if (!deps.limiter.hit(`orev:${auth.privyUserId}`, 20, 60 * 60_000)) throw new ClaimError('RATE_LIMITED', 'too many checks — try again later', 429)
    return { deploy: await recordDeploy(auth, body.data.signature) }
  })

  async function recordDeploy(auth: AuthContext, signature: string) {
    const wallets = await deps.auth.getVerifiedExternalSolanaWallets(auth.privyUserId)
    const tx = normalizeJsonTransaction((await relay.confirmedTransaction(signature)) as RpcJsonTransaction)
    // Checked against each of the caller's own verified wallets; the event's authority must be one of them.
    const verdict = wallets.map((w) => verifyOreDeployTx(tx, address(w))).find((v) => v.ok) ?? verifyOreDeployTx(tx, address(wallets[0] ?? '11111111111111111111111111111111'))
    if (!verdict.ok) {
      const why: Record<string, string> = {
        FAILED: 'that transaction failed onchain',
        NO_DEPLOY: 'that transaction is not an ORE deploy',
        WRONG_AUTHORITY: 'that deploy was not made by one of your verified wallets',
        NOT_MANUAL: 'automated (autominer) deploys don’t count — deploy directly from your wallet',
        ZERO_EFFECT: 'that deploy didn’t add any square',
        MULTIPLE: 'that transaction contains more than one deploy',
      }
      throw new ClaimError(`ORE_${verdict.reason}`, why[verdict.reason] ?? 'not a valid ORE deploy', 422)
    }
    const { created, proof } = await store.saveOreDeploy({
      signature, privyUserId: auth.privyUserId, wallet: verdict.event.authority, roundId: verdict.event.roundId, squares: verdict.squares,
      amountPerSquare: verdict.event.amountPerSquare, totalLamports: verdict.totalLamports, slot: verdict.slot, deployedAt: new Date(Number(verdict.event.ts) * 1000), campaignId: null,
    })
    if (proof.privyUserId !== auth.privyUserId) throw new ClaimError('SIGNATURE_REUSED', 'this deploy is already linked to another Blink account', 409)
    // The ORE Miner mark means "made a verified ORE deploy" — never winnings or holdings.
    if (deps.profiles) {
      const before = (await deps.profiles.get(auth.privyUserId))?.og ?? []
      if (!before.includes('ORE')) await deps.profiles.setOg(auth.privyUserId, OG_TYPES.filter((t) => t === 'ORE' || before.includes(t)))
    }
    return {
      signature, created, roundId: proof.roundId.toString(), squares: proof.squares, lamportsPerSquare: proof.amountPerSquare.toString(),
      totalLamports: proof.totalLamports.toString(), slot: proof.slot.toString(), deployedAt: proof.deployedAt.toISOString(), network: 'Solana Mainnet', minerMark: true,
    }
  }
}

function formatSkr(rawAmount: bigint): string {
  const whole = rawAmount / 1_000_000n
  const frac = (rawAmount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/** Receipts for the activity feed: only records the server verified onchain (D-49..D-51). */
export async function chainHistoryItems(store: ChainActivityStore, privyUserId: string, profiles?: ProfileStore): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  const tips = await store.tipsFor(privyUserId, 100)
  const people = profiles ? await profiles.getMany([...new Set(tips.flatMap((t) => [t.senderPrivyUserId, t.recipientPrivyUserId]))]) : new Map()
  const name = (id: string) => {
    const p = people.get(id)
    return p?.skrName ?? (p?.username ? `@${p.username}` : 'a club member')
  }
  for (const t of tips) {
    const sent = t.senderPrivyUserId === privyUserId
    // Recipients see confirmed tips only; senders also see pending/failed attempts.
    if (!sent && t.status !== 'CONFIRMED') continue
    if (sent && t.status === 'PREPARED') continue
    items.push({
      id: `${sent ? 'SKR_TIP_SENT' : 'SKR_TIP_RECEIVED'}:${t.id}`, kind: sent ? 'SKR_TIP_SENT' : 'SKR_TIP_RECEIVED', cluster: t.cluster as HistoryItem['cluster'],
      symbol: 'SKR', mint: SKR_MINT, decimals: 6, amountRaw: t.amountRaw.toString(),
      status: t.status === 'CONFIRMED' ? 'CONFIRMED' : t.status === 'SUBMITTED' ? 'PENDING' : 'FAILED',
      signature: t.signature, campaignId: null, campaignType: null, counterparty: sent ? t.recipientWallet : t.senderWallet,
      title: sent ? name(t.recipientPrivyUserId) : name(t.senderPrivyUserId), at: (t.confirmedAt ?? t.createdAt).toISOString(),
    })
  }
  for (const b of await store.boostsBy(privyUserId, 50)) {
    if (b.status === 'PREPARED') continue
    items.push({
      id: `SKR_BOOST_PURCHASED:${b.id}`, kind: 'SKR_BOOST_PURCHASED', cluster: b.cluster as HistoryItem['cluster'], symbol: 'SKR', mint: SKR_MINT, decimals: 6,
      amountRaw: b.amountRaw.toString(), status: b.status === 'CONFIRMED' ? 'CONFIRMED' : b.status === 'SUBMITTED' ? 'PENDING' : 'FAILED',
      signature: b.signature, campaignId: b.campaignId, campaignType: null, counterparty: b.destination, title: `${b.hours} h featured`,
      details: { ...(b.startsAt ? { startsAt: b.startsAt.toISOString() } : {}), ...(b.endsAt ? { endsAt: b.endsAt.toISOString() } : {}) },
      at: (b.confirmedAt ?? b.createdAt).toISOString(),
    })
  }
  const deploys = await store.oreDeploysFor(privyUserId, 100)
  for (const d of deploys) {
    items.push({
      id: `ORE_DEPLOY_CONFIRMED:${d.signature}`, kind: 'ORE_DEPLOY_CONFIRMED', cluster: 'mainnet-beta', symbol: 'SOL', mint: null, decimals: 9,
      amountRaw: d.totalLamports.toString(), status: 'CONFIRMED', signature: d.signature, campaignId: d.campaignId, campaignType: null, counterparty: null,
      title: `Round ${d.roundId}`, details: { roundId: d.roundId.toString(), squares: d.squares, lamportsPerSquare: d.amountPerSquare.toString() }, at: d.deployedAt.toISOString(),
    })
  }
  const first = deploys.at(-1)
  if (first) {
    items.push({
      id: `ORE_MINER_VERIFIED:${first.signature}`, kind: 'ORE_MINER_VERIFIED', cluster: 'mainnet-beta', symbol: '', mint: null, decimals: 0, amountRaw: '0',
      status: 'CONFIRMED', signature: first.signature, campaignId: null, campaignType: null, counterparty: null, title: 'ORE Miner', at: first.createdAt.toISOString(),
    })
  }
  return items
}

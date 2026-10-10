import { randomUUID } from 'node:crypto'

import type { PublicParticipant } from '@blink/domain'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { Asset } from './assets.ts'
import type { AuthContext, AuthVerifier } from './auth.ts'
import type { EligibilityService } from './eligibility.ts'
import { ClaimError } from './payout-service.ts'
import type { Notifier } from './push.ts'
import type { RateLimiter } from './rate-limit.ts'
import { profileExtras, type ProfileStore, type StoredProfile, USERNAME_RE } from './profile.ts'
import type { SendService } from './send-service.ts'
import type { SocialStore } from './social-store.ts'

/*
 * Gifts to people by name: "Gift a person" (one recipient, stock from the Blink wallet; SKR goes through the tip
 * flow) and gift drops to a pasted list of names. People are found by their Blink username or their verified .skr
 * name only — never by wallet or email — and unknown names are reported back, never silently dropped.
 */

export const MAX_NAMES = 50
const SKR_NAME_RE = /^[a-z0-9-]{1,63}\.skr$/

export type NameResult =
  | { input: string; found: true; privyUserId: string; profile: StoredProfile }
  | { input: string; found: false; reason: 'NOT_FOUND' | 'INVALID' }

/** "@Maris", "maris", "maris.skr" → the lookup key, or null when it can't be a Blink name. */
export function normalizeName(input: string): { kind: 'username' | 'skr'; key: string } | null {
  const v = input.trim().replace(/^@/, '').toLowerCase()
  if (SKR_NAME_RE.test(v)) return { kind: 'skr', key: v }
  if (USERNAME_RE.test(v)) return { kind: 'username', key: v }
  return null
}

/** Splits pasted text ("@a, @b\n c.skr") into distinct names, in order. */
export function splitNames(text: string[]): string[] {
  const out: string[] = []
  for (const part of text.flatMap((t) => t.split(/[\s,;]+/))) {
    const v = part.trim()
    if (v && !out.some((o) => o.toLowerCase().replace(/^@/, '') === v.toLowerCase().replace(/^@/, ''))) out.push(v)
  }
  return out
}

/** Finds each name on Blink (username or verified .skr name). */
export async function resolveNames(profiles: ProfileStore, inputs: string[]): Promise<NameResult[]> {
  const parsed = inputs.map((input) => ({ input, n: normalizeName(input) }))
  const usernames = parsed.flatMap((p) => (p.n?.kind === 'username' ? [p.n.key] : []))
  const skrNames = parsed.flatMap((p) => (p.n?.kind === 'skr' ? [p.n.key] : []))
  const found = await profiles.findByNames(usernames, skrNames)
  return parsed.map(({ input, n }) => {
    if (!n) return { input, found: false as const, reason: 'INVALID' as const }
    const p = found.find((x) => (n.kind === 'username' ? x.username === n.key : x.skrName === n.key))
    return p ? { input, found: true as const, privyUserId: p.privyUserId, profile: p } : { input, found: false as const, reason: 'NOT_FOUND' as const }
  })
}

/** Public view of a found person: the name you can see on Blink, never their wallet or email. */
export function personOf(p: StoredProfile): PublicParticipant & { handle: string } {
  const handle = p.skrName ?? `@${p.username}`
  return { label: p.username ? `@${p.username}` : handle, ...(p.username ? { username: p.username } : {}), ...profileExtras(p), handle }
}

export interface GiftDeps {
  env: { SOLANA_CLUSTER: string; XSTOCK_COMPLIANCE: string }
  auth: AuthVerifier
  requireAuth: (req: FastifyRequest) => Promise<AuthContext>
  throttle: (req: FastifyRequest, auth: AuthContext) => void
  limiter: RateLimiter
  assets: Asset[]
  profiles?: ProfileStore
  social?: SocialStore
  send?: Pick<SendService, 'prepare' | 'submit'>
  eligibility?: Pick<EligibilityService, 'isEligibleStored'>
  notifier: Notifier
}

const DAY = 24 * 60 * 60_000
const resolveRequest = z.object({ names: z.array(z.string().min(1).max(2000)).min(1).max(MAX_NAMES) })
const giftPrepare = z.object({ to: z.string().min(1).max(70), asset: z.string().min(32).max(44), amountRaw: z.string().regex(/^[1-9]\d{0,19}$/) })
const giftSubmit = z.object({ signedTransaction: z.string().min(100).max(4000) })

export function registerGiftRoutes(app: FastifyInstance, deps: GiftDeps) {
  const pending = new Map<string, { recipient: string; mint: string; symbol: string; decimals: number; amountRaw: bigint; expiresAt: number }>()

  function requireProfiles() {
    if (!deps.profiles) throw new ClaimError('PROFILES_UNAVAILABLE', 'people search is not available right now', 503)
    return deps.profiles
  }

  /** Looks up pasted names; each comes back found (with their public picture and name) or flagged. */
  app.post('/v1/people/resolve', async (req) => {
    const auth = await deps.requireAuth(req)
    if (!deps.limiter.hit(`resolve:${auth.privyUserId}`, 60, 60 * 60_000)) throw new ClaimError('RATE_LIMITED', 'too many searches — try again later', 429)
    const body = resolveRequest.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', `paste up to ${MAX_NAMES} names`, 400)
    const names = splitNames(body.data.names)
    if (names.length > MAX_NAMES) throw new ClaimError('TOO_MANY_NAMES', `up to ${MAX_NAMES} people at a time`, 400)
    const results = await resolveNames(requireProfiles(), names)
    return {
      results: results.map((r) =>
        r.found
          ? { input: r.input, found: true, isYou: r.privyUserId === auth.privyUserId, person: personOf(r.profile) }
          : { input: r.input, found: false, reason: r.reason },
      ),
    }
  })

  /** Gift a person stock from your Blink wallet (Blink pays the network fee), found by username or .skr name. */
  app.post('/v1/gifts/prepare', async (req) => {
    const auth = await deps.requireAuth(req)
    deps.throttle(req, auth)
    if (!deps.send) throw new ClaimError('SEND_UNAVAILABLE', 'gifts are not available right now', 503)
    const body = giftPrepare.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', body.error.issues[0]?.message ?? 'invalid gift', 400)
    // Same daily cap as Send and club gifts (Blink pays these fees).
    if (!deps.limiter.hit(`send:${auth.privyUserId}`, 20, DAY)) throw new ClaimError('RATE_LIMITED', 'you have reached today’s sending limit — try again tomorrow', 429)
    const asset = deps.assets.find((a) => a.mint === body.data.asset)
    if (!asset) throw new ClaimError('UNSUPPORTED_ASSET', 'only Blink’s supported stocks can be gifted', 400)
    const [target] = await resolveNames(requireProfiles(), [body.data.to])
    if (!target?.found) throw new ClaimError('PERSON_NOT_FOUND', `${body.data.to} isn’t on Blink`, 404)
    if (target.privyUserId === auth.privyUserId) throw new ClaimError('SELF_GIFT', 'you can’t gift yourself', 400)
    // D-20: the recipient needs a current, eligible decision for real xStocks (the sender is checked inside Send).
    if (!asset.isTest && deps.env.XSTOCK_COMPLIANCE === 'enforce') {
      if (!deps.eligibility) throw new ClaimError('ELIGIBILITY_UNAVAILABLE', 'eligibility checks are not available right now', 503)
      if (!(await deps.eligibility.isEligibleStored(target.privyUserId))) {
        throw new ClaimError('RECIPIENT_NOT_ELIGIBLE', 'this person can’t receive xStocks yet (they need to confirm eligibility in Blink)', 403)
      }
    }
    const [to] = await deps.auth.getEmbeddedSolanaWallets(target.privyUserId)
    if (!to) throw new ClaimError('NO_STOCK_WALLET', 'their Blink wallet isn’t ready yet', 409)
    const prepared = await deps.send.prepare(auth.privyUserId, req.ip, { asset: asset.mint, to, amountRaw: BigInt(body.data.amountRaw) })
    pending.set(auth.privyUserId, { recipient: target.privyUserId, mint: asset.mint, symbol: asset.symbol, decimals: asset.decimals, amountRaw: BigInt(body.data.amountRaw), expiresAt: Date.now() + 5 * 60_000 })
    return { prepared: { transaction: prepared.transaction, createsRecipientAccount: prepared.createsRecipientAccount }, person: personOf(target.profile) }
  })

  app.post('/v1/gifts/submit', async (req) => {
    const auth = await deps.requireAuth(req)
    deps.throttle(req, auth)
    if (!deps.send || !deps.social) throw new ClaimError('SEND_UNAVAILABLE', 'gifts are not available right now', 503)
    const body = giftSubmit.safeParse(req.body)
    if (!body.success) throw new ClaimError('INVALID_REQUEST', 'invalid transaction', 400)
    const p = pending.get(auth.privyUserId)
    if (!p || p.expiresAt < Date.now()) throw new ClaimError('EXPIRED', 'this gift expired — please try again', 409)
    pending.delete(auth.privyUserId)
    // Send checks the signed transaction is exactly the one prepared for this user, then sends and confirms it.
    const { signature, confirmed } = await deps.send.submit(auth.privyUserId, body.data.signedTransaction)
    const [senderWallet] = await deps.auth.getEmbeddedSolanaWallets(auth.privyUserId).catch(() => [])
    const gift = await deps.social.createGift({
      id: randomUUID(), clubId: null, senderPrivyUserId: auth.privyUserId, recipientPrivyUserId: p.recipient, senderWallet: senderWallet ?? null,
      mint: p.mint, symbol: p.symbol, decimals: p.decimals, amountRaw: p.amountRaw, cluster: deps.env.SOLANA_CLUSTER, signature, status: confirmed ? 'CONFIRMED' : 'PENDING',
    })
    // Never "received" before the network confirms it.
    if (confirmed) {
      const me = deps.profiles ? await deps.profiles.get(auth.privyUserId) : null
      const from = me ? personOf(me).handle : 'Someone'
      void deps.notifier.notify(p.recipient, { title: 'You got a gift 🎁', body: `${from} sent you ${p.symbol} on Blink.`, url: '/history' })
    }
    return { gift: { id: gift.id, signature, status: gift.status } }
  })
}

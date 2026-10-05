import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  type CampaignType,
  type ChatMessage,
  CLUB_LIMITS,
  CLUB_POINTS,
  CLUB_REACTIONS,
  type ClubDetail,
  type ClubLeaderboardEntry,
  type ClubMemberView,
  type ClubReaction,
  type ClubSummary,
  type Passport,
  passportLevel,
  type PassportBadge,
  type PublicParticipant,
  publicLabel,
  type SquadSummary,
} from '@blink/domain'
import {
  chatMessageRequest,
  checkinRequest,
  clubSettingsRequest,
  memberRoleRequest,
  muteRequest,
  voiceMessageRequest,
  createClubRequest,
  createSquadRequest,
  giftPrepareRequest,
  giftSubmitRequest,
  joinClubRequest,
  joinSquadRequest,
  questHasTapRush,
  questUses,
  reactionRequest,
  updateClubRulesRequest,
} from '@blink/validation'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { AuthContext, AuthVerifier } from './auth.ts'
import { type CampaignRepository, type StoredCampaign, toSummary } from './campaign-repo.ts'
import type { ClaimRepository } from './claim-repo.ts'
import { ClaimError } from './payout-service.ts'
import type { QuestService } from './quest-service.ts'
import type { Asset } from './assets.ts'
import type { EligibilityService } from './eligibility.ts'
import { NOOP_NOTIFIER, type Notifier } from './push.ts'
import type { SendService } from './send-service.ts'
import { avatarPath, type ProfileStore } from './profile.ts'
import type { RateLimiter } from './rate-limit.ts'
import { AlreadyInSquadError, newCode, SlugTakenError, type SocialStore, type StoredClub, type StoredMessage, type StoredSquad } from './social-store.ts'

/*
 * D-40: clubs, club chat (polled), club leaderboards, squads, event check-ins and the Stock Passport.
 * Offchain only. Identity comes from the verified Privy session, never from the request body; people are shown by
 * username or a shortened wallet — never email, Privy id, country or compliance data.
 */

export interface SocialDeps {
  auth: AuthVerifier
  campaigns: CampaignRepository
  claims?: ClaimRepository
  profiles?: ProfileStore
  social?: SocialStore
  /** D-41: club join rules use the Verified Quest readers (mainnet, the person's verified wallets). */
  quests?: QuestService
  /** D-44: gifts reuse the D-32 Send flow (Blink pays the fee) and the D-20 gate for both people. */
  env?: { SOLANA_CLUSTER: string; XSTOCK_COMPLIANCE: string }
  assets?: Asset[]
  send?: Pick<SendService, 'prepare' | 'submit'>
  eligibility?: Pick<EligibilityService, 'isEligibleStored'>
  notifier?: Notifier
}

interface Ctx {
  requireAuth(req: FastifyRequest): Promise<AuthContext>
  throttle(req: FastifyRequest, auth: AuthContext): void
  limiter: RateLimiter
}

const TYPE_LABEL: Record<CampaignType, string> = {
  GIFT: 'Gift',
  TAP_RUSH: 'Tap Rush',
  EARLY_CLAIM: 'Flash Drop',
  REFERRAL: 'Referral',
  SEEKER: 'Seeker Drop',
  VERIFIED_QUEST: 'Verified Quest',
}

const DAY = 24 * 60 * 60 * 1000
const send = (reply: FastifyReply, status: number, code: string, message: string) => reply.status(status).send({ error: { code, message } })

function slugify(name: string) {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return s.length >= 3 ? s : `club-${newCode(5).toLowerCase()}`
}

/** Names that could pass for Blink, an issuer or a company's official community. */
function clubNameProblem(name: string, slug: string): string | null {
  const n = `${name} ${slug}`.toLowerCase()
  if (/\bofficial\b|\bblink\b|\bxstocks\b|\bbacked\b|\badmin\b|\bsupport\b|\bstaff\b/.test(n)) return 'that name is reserved — it could look official'
  return null
}

export function registerSocialRoutes(app: FastifyInstance, deps: SocialDeps, ctx: Ctx) {
  const { requireAuth, throttle, limiter } = ctx

  function requireSocial(): SocialStore {
    if (!deps.social) throw new ClaimError('CLUBS_UNAVAILABLE', 'clubs are not available right now', 503)
    return deps.social
  }

  /** Usernames and pictures for many people at once; a shortened wallet when no username is set. */
  async function people(ids: string[]) {
    const profiles = deps.profiles && ids.length ? await deps.profiles.getMany([...new Set(ids)]) : new Map()
    return (privyUserId: string, wallet: string | null): PublicParticipant => {
      const p = profiles.get(privyUserId)
      return p?.username ? { label: `@${p.username}`, username: p.username, avatarUrl: avatarPath(p) } : { ...publicLabel(wallet), avatarUrl: avatarPath(p) }
    }
  }

  async function myWallet(privyUserId: string) {
    try {
      return (await deps.auth.getEmbeddedSolanaWallets(privyUserId))[0] ?? null
    } catch {
      return null
    }
  }

  async function summaries(clubs: StoredClub[], privyUserId: string): Promise<ClubSummary[]> {
    const social = requireSocial()
    const counts = await social.memberCounts(clubs.map((c) => c.id))
    const mine = new Map((await social.membershipsOf(privyUserId)).map((m) => [m.clubId, m]))
    const owners = clubs.map((c) => c.ownerPrivyUserId).filter((o): o is string => Boolean(o))
    const ownerRows = await Promise.all(clubs.map((c) => (c.ownerPrivyUserId ? social.membership(c.id, c.ownerPrivyUserId) : null)))
    const who = await people(owners)
    return clubs.map((c, i) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      category: c.category,
      tags: c.tags,
      visibility: c.visibility,
      memberCount: counts.get(c.id) ?? 0,
      owner: c.ownerPrivyUserId ? who(c.ownerPrivyUserId, ownerRows[i]?.publicWallet ?? null) : null,
      joined: mine.has(c.id),
      role: mine.get(c.id)?.role ?? null,
      rules: c.rules,
      createdAt: c.createdAt.toISOString(),
    }))
  }

  /** A club the caller may see: public, or private and they are a member (or hold its invite code). */
  async function visibleClub(req: FastifyRequest<{ Params: { slug: string } }>, auth: AuthContext, invite?: string) {
    const social = requireSocial()
    const club = await social.findClub(req.params.slug)
    if (!club) throw new ClaimError('NOT_FOUND', 'club not found', 404)
    const member = await social.membership(club.id, auth.privyUserId)
    if (club.visibility === 'PRIVATE' && !member && invite !== club.inviteCode) throw new ClaimError('NOT_FOUND', 'club not found', 404)
    return { club, member, social }
  }

  const isAdmin = (m: { role: string } | null | undefined) => m?.role === 'OWNER' || m?.role === 'MOD'

  /** D-43: muted members and (in admins-only chats) non-admins can read and react but not post. */
  function requireCanPost(club: StoredClub, member: { role: string; mutedUntil: Date | null }) {
    requireNotMuted(member)
    if (club.adminsOnly && !isAdmin(member)) throw new ClaimError('ADMINS_ONLY', 'only admins can send messages in this club right now', 403)
  }

  /** Owner decision 2026-10-05: a muted member can only read — no messages, voice notes, reactions, gifts or reports. */
  function requireNotMuted(member: { role: string; mutedUntil: Date | null }) {
    if (member.mutedUntil && member.mutedUntil.getTime() > Date.now() && member.role !== 'OWNER') {
      throw new ClaimError('MUTED', `an admin muted you until ${member.mutedUntil.toISOString()}`, 403)
    }
  }

  async function memberOnly(req: FastifyRequest<{ Params: { slug: string } }>, auth: AuthContext) {
    const v = await visibleClub(req, auth)
    if (!v.member) throw new ClaimError('NOT_A_MEMBER', 'join the club first', 403)
    return { ...v, member: v.member }
  }

  // ---- Clubs ----

  app.get<{ Querystring: { q?: string; tab?: string } }>('/v1/clubs', async (req) => {
    const auth = await requireAuth(req)
    const social = requireSocial()
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 40) : undefined
    if (req.query.tab === 'joined') {
      const ids = (await social.membershipsOf(auth.privyUserId)).map((m) => m.clubId)
      const clubs = await social.clubsByIds(ids)
      const byId = new Map(clubs.map((c) => [c.id, c]))
      return { clubs: await summaries(ids.map((id) => byId.get(id)).filter((c): c is StoredClub => Boolean(c)), auth.privyUserId) }
    }
    const list = await summaries(await social.listClubs({ privyUserId: auth.privyUserId, q, limit: 100 }), auth.privyUserId)
    // Discover: biggest first (real member counts), newest breaks ties.
    return { clubs: list.sort((a, b) => b.memberCount - a.memberCount || Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50) }
  })

  app.post('/v1/clubs', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const social = requireSocial()
    const parsed = createClubRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid')
    const body = parsed.data
    const slug = body.slug ?? slugify(body.name)
    const problem = clubNameProblem(body.name, slug)
    if (problem) return send(reply, 400, 'INVALID_NAME', problem)
    if ((await social.countClubsOwnedSince(auth.privyUserId, new Date(Date.now() - DAY))) >= CLUB_LIMITS.clubsPerDay) {
      return send(reply, 429, 'RATE_LIMITED', `you can start ${CLUB_LIMITS.clubsPerDay} clubs a day — try again tomorrow`)
    }
    try {
      const club = await social.createClub(
        { id: randomUUID(), slug, name: body.name, description: body.description, category: body.category, tags: body.tags, visibility: body.visibility, inviteCode: newCode(8), ownerPrivyUserId: auth.privyUserId, rules: body.rules },
        { privyUserId: auth.privyUserId, publicWallet: await myWallet(auth.privyUserId) },
      )
      return reply.status(201).send({ club: (await summaries([club], auth.privyUserId))[0] })
    } catch (err) {
      if (err instanceof SlugTakenError) return send(reply, 409, 'SLUG_TAKEN', 'a club with that name already exists — pick another name')
      throw err
    }
  })

  app.get<{ Params: { slug: string }; Querystring: { invite?: string } }>('/v1/clubs/:slug', async (req) => {
    const auth = await requireAuth(req)
    const { club, member, social } = await visibleClub(req, auth, req.query.invite)
    const [summary] = await summaries([club], auth.privyUserId)
    const ids = await social.campaignIdsForClub(club.id, 30)
    const campaigns = (await Promise.all(ids.map((id) => deps.campaigns.findById(id)))).filter(
      (c): c is StoredCampaign => Boolean(c) && c!.status !== 'DRAFT' && c!.status !== 'AWAITING_FUNDING' && c!.status !== 'AWAITING_DELEGATION',
    )
    const detail: ClubDetail = {
      ...summary!,
      inviteCode: member && club.visibility === 'PRIVATE' ? club.inviteCode : member?.role === 'OWNER' || member?.role === 'MOD' ? club.inviteCode : null,
      campaigns: campaigns.map(toSummary),
      adminsOnly: club.adminsOnly,
      pinned: null,
      myMutedUntil: member?.mutedUntil && member.mutedUntil.getTime() > Date.now() ? member.mutedUntil.toISOString() : null,
    }
    // D-43: the pinned message, unless it was deleted since.
    if (club.pinnedMessageId !== null && (club.visibility === 'PUBLIC' || member)) {
      const [pin] = await social.messagesByIds([club.pinnedMessageId])
      if (pin && !pin.deletedAt && pin.clubId === club.id) detail.pinned = (await chatView([pin], auth.privyUserId))[0] ?? null
    }
    return { club: detail }
  })

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/join', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = joinClubRequest.safeParse(req.body ?? {})
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', 'that invite code is not valid')
    const { club, member, social } = await visibleClub(req, auth, parsed.data.invite)
    if (member) return send(reply, 409, 'ALREADY_MEMBER', 'you are already in this club')
    // D-43: removed members stay out until an admin lets them back in.
    if (await social.isBanned(club.id, auth.privyUserId)) return send(reply, 403, 'REMOVED', 'an admin removed you from this club')
    // D-41: join rules are checked now, on mainnet, against the person's verified wallets (fails closed).
    if (club.rules.length) {
      if (!deps.quests) throw new ClaimError('RULES_UNAVAILABLE', 'this club’s rules can’t be checked right now', 503)
      if (!limiter.hit(`club-rules:${auth.privyUserId}`, 10, 60_000)) return send(reply, 429, 'RATE_LIMITED', 'too many checks — wait a moment')
      const evaluation = await deps.quests.checkRules(club.rules, auth.privyUserId)
      if (!evaluation.qualified) {
        return reply.status(403).send({ error: { code: 'CLUB_RULES_NOT_MET', message: 'you don’t meet this club’s rules yet' }, evaluation })
      }
    }
    await social.join(club.id, auth.privyUserId, await myWallet(auth.privyUserId))
    return { club: (await summaries([club], auth.privyUserId))[0] }
  })

  /** D-41: the owner changes who can join. Current members stay; the rules apply to new joins. */
  app.put<{ Params: { slug: string } }>('/v1/clubs/:slug/rules', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await visibleClub(req, auth)
    if (member?.role !== 'OWNER') return send(reply, 403, 'FORBIDDEN', 'only the club’s owner can change its rules')
    const parsed = updateClubRulesRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid rules')
    await social.setRules(club.id, parsed.data.rules)
    return { club: (await summaries([{ ...club, rules: parsed.data.rules }], auth.privyUserId))[0] }
  })

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/leave', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await visibleClub(req, auth)
    if (!member) return send(reply, 409, 'NOT_A_MEMBER', 'you are not in this club')
    if (member.role === 'OWNER') return send(reply, 409, 'OWNER_CANNOT_LEAVE', 'you started this club, so you can’t leave it')
    await social.leave(club.id, auth.privyUserId)
    return { club: (await summaries([club], auth.privyUserId))[0] }
  })

  // ---- Chat (polled: GET …/messages?after=<last id> every few seconds while the chat is on screen) ----

  async function chatView(messages: StoredMessage[], privyUserId: string): Promise<ChatMessage[]> {
    const social = requireSocial()
    const replyIds = [...new Set(messages.map((m) => m.replyToId).filter((x): x is bigint => x !== null))]
    const replies = new Map((await social.messagesByIds(replyIds)).map((m) => [m.id, m]))
    const reactions = await social.reactions(messages.map((m) => m.id))
    const gifts = new Map((await social.giftsByIds(messages.map((m) => m.giftId).filter((x): x is string => Boolean(x)))).map((g) => [g.id, g]))
    const giftWallets = new Map(
      await Promise.all([...gifts.values()].map(async (g) => [g.recipientPrivyUserId, (await social.membership(g.clubId, g.recipientPrivyUserId))?.publicWallet ?? null] as const)),
    )
    const who = await people([
      ...messages.map((m) => m.authorPrivyUserId),
      ...[...replies.values()].map((m) => m.authorPrivyUserId),
      ...[...gifts.values()].map((g) => g.recipientPrivyUserId),
    ])
    return messages.map((m) => {
      const mine = reactions.filter((r) => r.messageId === m.id)
      const reply = m.replyToId !== null ? replies.get(m.replyToId) : undefined
      return {
        id: m.id.toString(),
        author: who(m.authorPrivyUserId, m.authorWallet),
        mine: m.authorPrivyUserId === privyUserId,
        body: m.deletedAt ? '' : m.body,
        kind: m.kind === 'VOICE' ? ('VOICE' as const) : m.kind === 'GIFT' ? ('GIFT' as const) : ('TEXT' as const),
        voice: m.kind === 'VOICE' && m.voiceId && !m.deletedAt ? { url: `/v1/voice/${m.voiceId}`, durationMs: m.voiceMs ?? 0 } : null,
        gift: (() => {
          const g = m.kind === 'GIFT' && m.giftId && !m.deletedAt ? gifts.get(m.giftId) : undefined
          return g
            ? { to: who(g.recipientPrivyUserId, giftWallets.get(g.recipientPrivyUserId) ?? null), mint: g.mint, symbol: g.symbol, decimals: g.decimals, amountRaw: g.amountRaw.toString(), signature: g.signature, cluster: g.cluster }
            : null
        })(),
        authorId: m.deletedAt ? null : memberRef(m.clubId, m.authorPrivyUserId),
        replyTo: reply
          ? { id: reply.id.toString(), author: who(reply.authorPrivyUserId, reply.authorWallet), body: reply.deletedAt ? '' : reply.kind === 'VOICE' ? '🎤 Voice note' : reply.kind === 'GIFT' ? '🎁 Gift' : reply.body.slice(0, 140) }
          : null,
        reactions: CLUB_REACTIONS.map((emoji) => ({
          emoji,
          count: mine.filter((r) => r.emoji === emoji).length,
          mine: mine.some((r) => r.emoji === emoji && r.privyUserId === privyUserId),
        })).filter((r) => r.count > 0),
        deleted: Boolean(m.deletedAt),
        createdAt: m.createdAt.toISOString(),
      }
    })
  }

  const cursor = (v: unknown) => (typeof v === 'string' && /^\d{1,19}$/.test(v) ? BigInt(v) : undefined)

  app.get<{ Params: { slug: string }; Querystring: { before?: string; after?: string } }>('/v1/clubs/:slug/messages', async (req) => {
    const auth = await requireAuth(req)
    const { club, social } = await visibleClub(req, auth)
    // Private clubs: members only. Public clubs can be read before joining (posting needs membership).
    if (club.visibility === 'PRIVATE' && !(await social.membership(club.id, auth.privyUserId))) throw new ClaimError('NOT_A_MEMBER', 'join the club first', 403)
    const rows = await social.listMessages(club.id, { before: cursor(req.query.before), after: cursor(req.query.after), limit: CLUB_LIMITS.messagePage })
    return { messages: await chatView(rows, auth.privyUserId), serverTime: new Date().toISOString() }
  })

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/messages', async (req, reply) => {
    const auth = await requireAuth(req)
    const { club, member, social } = await memberOnly(req, auth)
    requireCanPost(club, member)
    if (!limiter.hit(`chat:${auth.privyUserId}`, CLUB_LIMITS.messagesPerMinute, 60_000)) {
      return send(reply, 429, 'RATE_LIMITED', 'you’re sending messages too fast — wait a moment')
    }
    const parsed = chatMessageRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid message')
    let replyToId: bigint | null = null
    if (parsed.data.replyTo) {
      const [target] = await social.messagesByIds([BigInt(parsed.data.replyTo)])
      if (!target || target.clubId !== club.id) return send(reply, 400, 'INVALID_REPLY', 'that message is not in this club')
      replyToId = target.id
    }
    const m = await social.addMessage({ clubId: club.id, authorPrivyUserId: auth.privyUserId, authorWallet: member.publicWallet, body: parsed.data.body, replyToId })
    return reply.status(201).send({ message: (await chatView([m], auth.privyUserId))[0] })
  })

  app.delete<{ Params: { slug: string; mid: string } }>('/v1/clubs/:slug/messages/:mid', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    const id = cursor(req.params.mid)
    const [m] = id !== undefined ? await social.messagesByIds([id]) : []
    if (!m || m.clubId !== club.id) return send(reply, 404, 'NOT_FOUND', 'message not found')
    const moderator = member.role === 'OWNER' || member.role === 'MOD'
    if (m.authorPrivyUserId !== auth.privyUserId && !moderator) return send(reply, 403, 'FORBIDDEN', 'you can only delete your own messages')
    await social.deleteMessage(m.id, auth.privyUserId)
    return { ok: true }
  })

  app.post<{ Params: { slug: string; mid: string } }>('/v1/clubs/:slug/messages/:mid/reactions', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    requireNotMuted(member)
    const parsed = reactionRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', 'that reaction is not available')
    const id = cursor(req.params.mid)
    const [m] = id !== undefined ? await social.messagesByIds([id]) : []
    if (!m || m.clubId !== club.id || m.deletedAt) return send(reply, 404, 'NOT_FOUND', 'message not found')
    await social.toggleReaction(m.id, auth.privyUserId, parsed.data.emoji as ClubReaction)
    return { message: (await chatView([m], auth.privyUserId))[0] }
  })

  /** Members report a message once each; enough distinct reports hide it until a person reviews (owner can't undo yet). */
  app.post<{ Params: { slug: string; mid: string } }>('/v1/clubs/:slug/messages/:mid/report', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    requireNotMuted(member)
    const id = cursor(req.params.mid)
    const [m] = id !== undefined ? await social.messagesByIds([id]) : []
    if (!m || m.clubId !== club.id) return send(reply, 404, 'NOT_FOUND', 'message not found')
    if (m.authorPrivyUserId === auth.privyUserId) return send(reply, 400, 'OWN_MESSAGE', 'you can delete your own message instead')
    const count = await social.report(m.id, auth.privyUserId)
    req.log.warn({ clubId: club.id, messageId: m.id.toString(), count }, 'club message reported')
    const hidden = count >= CLUB_LIMITS.reportsToHide
    if (hidden && !m.deletedAt) await social.deleteMessage(m.id, 'REPORTS')
    return { reported: true, hidden }
  })

  // ---- D-43: voice notes (AAC in MP4, ≤ 60 s, ≤ 1 MB), served by a random id like profile pictures ----

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/voice', { bodyLimit: 1_600_000 }, async (req, reply) => {
    const auth = await requireAuth(req)
    const { club, member, social } = await memberOnly(req, auth)
    requireCanPost(club, member)
    if (!limiter.hit(`chat:${auth.privyUserId}`, CLUB_LIMITS.messagesPerMinute, 60_000) || !limiter.hit(`voice:${auth.privyUserId}`, CLUB_LIMITS.voicesPerTenMinutes, 600_000)) {
      return send(reply, 429, 'RATE_LIMITED', 'you’re sending voice notes too fast — wait a moment')
    }
    const parsed = voiceMessageRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid voice note')
    const bytes = Uint8Array.from(Buffer.from(parsed.data.audio, 'base64'))
    if (bytes.length > CLUB_LIMITS.voiceMaxBytes) return send(reply, 413, 'VOICE_TOO_LARGE', 'that voice note is too long')
    // MP4 / M4A: the 'ftyp' box at byte 4. The declared type is never trusted.
    if (bytes.length < 12 || Buffer.from(bytes.subarray(4, 8)).toString('latin1') !== 'ftyp') return send(reply, 400, 'INVALID_AUDIO', 'that isn’t a supported voice note')
    let replyToId: bigint | null = null
    if (parsed.data.replyTo) {
      const [target] = await social.messagesByIds([BigInt(parsed.data.replyTo)])
      if (!target || target.clubId !== club.id) return send(reply, 400, 'INVALID_REPLY', 'that message is not in this club')
      replyToId = target.id
    }
    const voiceId = randomBytes(16).toString('base64url')
    await social.addVoice({ id: voiceId, clubId: club.id, bytes, mime: 'audio/mp4' })
    const m = await social.addMessage({ clubId: club.id, authorPrivyUserId: auth.privyUserId, authorWallet: member.publicWallet, body: '', replyToId, kind: 'VOICE', voiceId, voiceMs: parsed.data.durationMs })
    return reply.status(201).send({ message: (await chatView([m], auth.privyUserId))[0] })
  })

  /** Audio by its random 128-bit id; gone once the message is deleted. */
  app.get<{ Params: { id: string } }>('/v1/voice/:id', async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{22}$/.test(req.params.id)) return send(reply, 404, 'NOT_FOUND', 'not found')
    const social = requireSocial()
    const m = await social.messageByVoiceId(req.params.id)
    const v = m && !m.deletedAt ? await social.voice(req.params.id) : null
    if (!v) return send(reply, 404, 'NOT_FOUND', 'not found')
    return reply
      .header('content-type', v.mime)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(v.bytes))
  })

  // ---- D-43: admins — members list, roles, mute, remove, chat settings, pin ----

  const memberRef = (clubId: string, privyUserId: string) => createHash('sha256').update(`club-member:${clubId}:${privyUserId}`).digest('hex').slice(0, 16)

  app.get<{ Params: { slug: string } }>('/v1/clubs/:slug/members', async (req) => {
    const auth = await requireAuth(req)
    const { club, member, social } = await visibleClub(req, auth)
    if (club.visibility === 'PRIVATE' && !member) throw new ClaimError('NOT_A_MEMBER', 'join the club first', 403)
    const rows = await social.members(club.id, 1000)
    const who = await people(rows.map((m) => m.privyUserId))
    const rank = { OWNER: 0, MOD: 1, MEMBER: 2 } as const
    const members: ClubMemberView[] = rows
      .map((m) => ({
        id: memberRef(club.id, m.privyUserId),
        who: who(m.privyUserId, m.publicWallet),
        role: m.role,
        mutedUntil: m.mutedUntil && m.mutedUntil.getTime() > Date.now() ? m.mutedUntil.toISOString() : null,
        joinedAt: m.joinedAt.toISOString(),
        me: m.privyUserId === auth.privyUserId,
      }))
      .sort((a, b) => rank[a.role] - rank[b.role] || Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
    let removed: { id: string; who: PublicParticipant; at: string }[] | null = null
    if (isAdmin(member)) {
      const bans = await social.bans(club.id)
      const bwho = await people(bans.map((b) => b.privyUserId))
      removed = bans.map((b) => ({ id: memberRef(club.id, b.privyUserId), who: bwho(b.privyUserId, b.publicWallet), at: b.createdAt.toISOString() }))
    }
    return { members, removed }
  })

  /** The acting admin and the target member (by opaque id). Only the owner manages admins; nobody acts on the owner. */
  async function adminAction(req: FastifyRequest<{ Params: { slug: string; ref: string } }>) {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    if (!isAdmin(member)) throw new ClaimError('FORBIDDEN', 'only admins can do that', 403)
    const target = (await social.members(club.id, 5000)).find((m) => memberRef(club.id, m.privyUserId) === req.params.ref)
    if (!target) throw new ClaimError('NOT_FOUND', 'member not found', 404)
    if (target.role === 'OWNER') throw new ClaimError('FORBIDDEN', 'the club’s owner can’t be changed', 403)
    if (target.privyUserId === auth.privyUserId) throw new ClaimError('FORBIDDEN', 'you can’t do that to yourself', 403)
    if (target.role === 'MOD' && member.role !== 'OWNER') throw new ClaimError('FORBIDDEN', 'only the owner can act on other admins', 403)
    return { auth, club, member, social, target }
  }

  app.post<{ Params: { slug: string; ref: string } }>('/v1/clubs/:slug/members/:ref/role', async (req, reply) => {
    const parsed = memberRoleRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', 'role must be MOD or MEMBER')
    const { club, member, social, target } = await adminAction(req)
    if (member.role !== 'OWNER') return send(reply, 403, 'FORBIDDEN', 'only the owner can make or remove admins')
    await social.setRole(club.id, target.privyUserId, parsed.data.role)
    return { ok: true, role: parsed.data.role }
  })

  app.post<{ Params: { slug: string; ref: string } }>('/v1/clubs/:slug/members/:ref/mute', async (req, reply) => {
    const parsed = muteRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', 'pick a mute length')
    const { club, social, target } = await adminAction(req)
    const until = parsed.data.minutes ? new Date(Date.now() + parsed.data.minutes * 60_000) : null
    await social.setMuted(club.id, target.privyUserId, until)
    return { ok: true, mutedUntil: until?.toISOString() ?? null }
  })

  app.post<{ Params: { slug: string; ref: string } }>('/v1/clubs/:slug/members/:ref/remove', async (req) => {
    const { auth, club, social, target } = await adminAction(req)
    await social.ban(club.id, target.privyUserId, auth.privyUserId, target.publicWallet)
    return { ok: true }
  })

  app.post<{ Params: { slug: string; ref: string } }>('/v1/clubs/:slug/removed/:ref/restore', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    if (!isAdmin(member)) return send(reply, 403, 'FORBIDDEN', 'only admins can do that')
    const ban = (await social.bans(club.id)).find((b) => memberRef(club.id, b.privyUserId) === req.params.ref)
    if (!ban) return send(reply, 404, 'NOT_FOUND', 'not found')
    await social.unban(club.id, ban.privyUserId)
    return { ok: true }
  })

  /** Admins: "only admins can send messages" and the club description (WhatsApp's "edit group info"). */
  app.put<{ Params: { slug: string } }>('/v1/clubs/:slug/settings', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    if (!isAdmin(member)) return send(reply, 403, 'FORBIDDEN', 'only admins can change club settings')
    const parsed = clubSettingsRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid settings')
    await social.setSettings(club.id, parsed.data)
    return { ok: true, adminsOnly: parsed.data.adminsOnly ?? club.adminsOnly }
  })

  async function pin(req: FastifyRequest<{ Params: { slug: string; mid: string } }>, on: boolean) {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    if (!isAdmin(member)) throw new ClaimError('FORBIDDEN', 'only admins can pin messages', 403)
    const id = cursor(req.params.mid)
    const [m] = id !== undefined ? await social.messagesByIds([id]) : []
    if (!m || m.clubId !== club.id || m.deletedAt) throw new ClaimError('NOT_FOUND', 'message not found', 404)
    await social.setSettings(club.id, { pinnedMessageId: on ? m.id : null })
    return { ok: true }
  }
  app.post<{ Params: { slug: string; mid: string } }>('/v1/clubs/:slug/messages/:mid/pin', (req) => pin(req, true))
  app.delete<{ Params: { slug: string; mid: string } }>('/v1/clubs/:slug/messages/:mid/pin', (req) => pin(req, false))

  // ---- D-44: xStock gifts between club members (the D-32 Send flow; Blink pays the fee) ----

  const giftPending = new Map<string, { clubId: string; slug: string; recipient: string; mint: string; symbol: string; decimals: number; amountRaw: bigint; expiresAt: number }>()
  const notifier = deps.notifier ?? NOOP_NOTIFIER

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/gifts/prepare', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    // Any member can gift, including in an admins-only chat; muted members can't (owner decisions 2026-10-05).
    const { club, member, social } = await memberOnly(req, auth)
    requireNotMuted(member)
    if (!deps.send) throw new ClaimError('SEND_UNAVAILABLE', 'gifts are not available right now', 503)
    const parsed = giftPrepareRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid gift')
    // Same daily cap as Send (Blink pays these fees).
    if (!limiter.hit(`send:${auth.privyUserId}`, 20, DAY)) return send(reply, 429, 'RATE_LIMITED', 'you have reached today’s sending limit — try again tomorrow')
    const asset = deps.assets?.find((a) => a.mint === parsed.data.asset)
    if (!asset) return send(reply, 400, 'UNSUPPORTED_ASSET', 'only Blink’s supported stocks can be gifted')
    const target = (await social.members(club.id, 5000)).find((m) => memberRef(club.id, m.privyUserId) === parsed.data.to)
    if (!target) return send(reply, 404, 'NOT_FOUND', 'that person is not in this club')
    if (target.privyUserId === auth.privyUserId) return send(reply, 400, 'SELF_GIFT', 'you can’t gift yourself')
    // D-20: receiving xStocks needs a current, eligible decision too (the sender is checked inside Send).
    if (!asset.isTest && deps.env?.XSTOCK_COMPLIANCE === 'enforce') {
      if (!deps.eligibility) throw new ClaimError('ELIGIBILITY_UNAVAILABLE', 'eligibility checks are not available right now', 503)
      if (!(await deps.eligibility.isEligibleStored(target.privyUserId))) {
        return send(reply, 403, 'RECIPIENT_NOT_ELIGIBLE', 'this person can’t receive xStocks yet (they need to confirm eligibility in Blink)')
      }
    }
    const [to] = await deps.auth.getEmbeddedSolanaWallets(target.privyUserId)
    if (!to) return send(reply, 409, 'NO_STOCK_WALLET', 'their Blink wallet isn’t ready yet')
    const prepared = await deps.send.prepare(auth.privyUserId, req.ip, { asset: asset.mint, to, amountRaw: BigInt(parsed.data.amountRaw) })
    giftPending.set(auth.privyUserId, {
      clubId: club.id, slug: club.slug, recipient: target.privyUserId, mint: asset.mint, symbol: asset.symbol, decimals: asset.decimals,
      amountRaw: BigInt(parsed.data.amountRaw), expiresAt: Date.now() + 5 * 60_000,
    })
    // The recipient's address is inside the transaction the wallet signs (it is public onchain), but never shown in the app.
    return { prepared: { transaction: prepared.transaction, createsRecipientAccount: prepared.createsRecipientAccount } }
  })

  app.post<{ Params: { slug: string } }>('/v1/clubs/:slug/gifts/submit', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const { club, member, social } = await memberOnly(req, auth)
    if (!deps.send) throw new ClaimError('SEND_UNAVAILABLE', 'gifts are not available right now', 503)
    const parsed = giftSubmitRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', 'invalid transaction')
    const pending = giftPending.get(auth.privyUserId)
    if (!pending || pending.clubId !== club.id || pending.expiresAt < Date.now()) return send(reply, 409, 'EXPIRED', 'this gift expired — please try again')
    giftPending.delete(auth.privyUserId)
    // Send checks the signed transaction is exactly the one prepared for this user, then sends and confirms it.
    const { signature, confirmed } = await deps.send.submit(auth.privyUserId, parsed.data.signedTransaction)
    const gift = await social.createGift({
      id: randomUUID(), clubId: club.id, senderPrivyUserId: auth.privyUserId, recipientPrivyUserId: pending.recipient, senderWallet: member.publicWallet,
      mint: pending.mint, symbol: pending.symbol, decimals: pending.decimals, amountRaw: pending.amountRaw, cluster: deps.env?.SOLANA_CLUSTER ?? 'devnet',
      signature, status: confirmed ? 'CONFIRMED' : 'PENDING',
    })
    // Only a confirmed transfer appears in the chat and notifies the recipient (never "received" before it is).
    let message: ChatMessage | null = null
    if (confirmed) {
      const m = await social.addMessage({ clubId: club.id, authorPrivyUserId: auth.privyUserId, authorWallet: member.publicWallet, body: '', replyToId: null, kind: 'GIFT', giftId: gift.id })
      message = (await chatView([m], auth.privyUserId))[0] ?? null
      const sender = (await people([auth.privyUserId]))(auth.privyUserId, member.publicWallet)
      void notifier.notify(pending.recipient, {
        title: 'You got a gift 🎁',
        body: `${sender.label} sent you ${pending.symbol} in ${club.name}.`,
        url: `/club/${pending.slug}`,
      })
    }
    return { gift: { id: gift.id, signature, status: gift.status }, message }
  })

  // ---- Club leaderboard: points from real, explainable records only (never balances or wealth) ----

  app.get<{ Params: { slug: string }; Querystring: { period?: string } }>('/v1/clubs/:slug/leaderboard', async (req) => {
    const auth = await requireAuth(req)
    const { club, social } = await visibleClub(req, auth)
    const since = req.query.period === 'all' ? new Date(0) : new Date(Date.now() - 7 * DAY)
    const campaignIds = await social.campaignIdsForClub(club.id, 30)
    const members = new Map((await social.members(club.id, 5000)).map((m) => [m.privyUserId, m]))
    const tally = new Map<string, { rewards: Set<string>; qualified: Set<string>; checkins: Set<string> }>()
    const row = (u: string) => {
      if (!tally.has(u)) tally.set(u, { rewards: new Set(), qualified: new Set(), checkins: new Set() })
      return tally.get(u)!
    }
    if (deps.claims) {
      for (const cid of campaignIds) {
        const data = await deps.claims.roomData(cid, { leaderboard: 0, events: 5000 })
        for (const e of data.events) {
          if (e.at < since || !members.has(e.privyUserId)) continue
          if (e.type === 'PAYOUT_CONFIRMED') row(e.privyUserId).rewards.add(cid)
          if (e.type === 'PARTICIPANT_QUALIFIED' || e.type === 'REQUIREMENT_VERIFIED') row(e.privyUserId).qualified.add(cid)
        }
      }
    }
    for (const c of await social.checkinsFor(campaignIds)) if (c.at >= since && members.has(c.privyUserId)) row(c.privyUserId).checkins.add(c.campaignId)
    const who = await people([...tally.keys()])
    const entries = [...tally.entries()]
      .map(([u, t]) => ({
        u,
        rewards: t.rewards.size,
        qualified: t.qualified.size,
        checkins: t.checkins.size,
        points: t.rewards.size * CLUB_POINTS.REWARD + t.qualified.size * CLUB_POINTS.QUALIFIED + t.checkins.size * CLUB_POINTS.CHECKIN,
      }))
      .filter((e) => e.points > 0)
      .sort((a, b) => b.points - a.points)
      .slice(0, 50)
    const leaderboard: ClubLeaderboardEntry[] = entries.map((e, i) => ({
      rank: i + 1,
      who: who(e.u, members.get(e.u)?.publicWallet ?? null),
      points: e.points,
      rewards: e.rewards,
      qualified: e.qualified,
      checkins: e.checkins,
    }))
    return { leaderboard, points: CLUB_POINTS, period: req.query.period === 'all' ? 'all' : 'week' }
  })

  // ---- Event check-in (QR) ----

  async function ownCampaign(req: FastifyRequest<{ Params: { id: string } }>) {
    const auth = await requireAuth(req)
    const c = /^[0-9a-f-]{36}$/.test(req.params.id) ? await deps.campaigns.findById(req.params.id) : null
    if (!c || c.creatorPrivyUserId !== auth.privyUserId) throw new ClaimError('NOT_FOUND', 'campaign not found', 404)
    if (!c.requirements || !questUses(c.requirements, 'QR_CHECKIN')) throw new ClaimError('NOT_AN_EVENT', 'this drop has no event check-in', 409)
    return { auth, c }
  }
  const eventLink = (token: string) => `https://blinksol.site/e/${token}`

  /** Creator only: the code behind the event QR (POST rotates it, so screenshots of the old one stop working). */
  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/event-code', async (req) => {
    const { c } = await ownCampaign(req)
    const token = await requireSocial().eventToken(c.id, false)
    return { event: { token, link: eventLink(token) } }
  })
  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/event-code', async (req) => {
    const { auth, c } = await ownCampaign(req)
    throttle(req, auth)
    const token = await requireSocial().eventToken(c.id, true)
    return { event: { token, link: eventLink(token) } }
  })

  app.post('/v1/checkin', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    if (!limiter.hit(`checkin:${auth.privyUserId}`, CLUB_LIMITS.checkinsPerHour, 60 * 60 * 1000)) {
      return send(reply, 429, 'RATE_LIMITED', 'too many check-ins — try again later')
    }
    const parsed = checkinRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_CODE', 'that isn’t a Blink event code')
    const social = requireSocial()
    const campaignId = await social.campaignForEventToken(parsed.data.token)
    const c = campaignId ? await deps.campaigns.findById(campaignId) : null
    // Unknown and rotated codes look the same: nothing to learn by guessing.
    if (!c || !c.requirements || !questUses(c.requirements, 'QR_CHECKIN')) return send(reply, 404, 'INVALID_CODE', 'this event code is not valid (it may have been replaced)')
    if (c.creatorPrivyUserId === auth.privyUserId) return send(reply, 403, 'OWN_CAMPAIGN', 'you created this event')
    if (c.membersOnly && c.clubId && !(await social.membership(c.clubId, auth.privyUserId))) {
      return send(reply, 403, 'NOT_A_MEMBER', 'this event is for club members — join the club first')
    }
    if (c.status !== 'LIVE') return send(reply, 409, 'NOT_LIVE', 'this event isn’t open right now')
    const now = Date.now()
    if (c.startsAt && c.startsAt.getTime() > now) return send(reply, 409, 'NOT_STARTED', 'check-in hasn’t opened yet')
    if (c.endsAt && c.endsAt.getTime() <= now) return send(reply, 409, 'CAMPAIGN_OVER', 'this event has ended')
    const fresh = await social.checkIn(c.id, auth.privyUserId)
    return { checkin: { campaignId: c.id, alreadyCheckedIn: !fresh } }
  })

  // ---- Squads (COMBINED_TAPS: the server sums each member's best accepted Tap Rush round) ----

  function hasTapRush(c: StoredCampaign) {
    return c.type === 'TAP_RUSH' || (c.type === 'VERIFIED_QUEST' && Boolean(c.requirements && questHasTapRush(c.requirements)))
  }

  async function squadViews(campaign: StoredCampaign, squads: StoredSquad[], privyUserId: string): Promise<SquadSummary[]> {
    if (!squads.length) return []
    const social = requireSocial()
    const members = await social.squadMembers(squads.map((s) => s.id))
    const best = new Map<string, number>()
    if (deps.claims) for (const e of (await deps.claims.roomData(campaign.id, { leaderboard: 5000, events: 0 })).leaderboard) best.set(e.privyUserId, e.score)
    const who = await people(members.map((m) => m.privyUserId))
    const goal = campaign.tapRush?.goal ?? 0
    return squads.map((s) => {
      const mine = members.filter((m) => m.squadId === s.id)
      const combinedTaps = mine.reduce((a, m) => a + (best.get(m.privyUserId) ?? 0), 0)
      const target = goal * s.maxSize
      return {
        id: s.id,
        campaignId: s.campaignId,
        name: s.name,
        code: s.code,
        maxSize: s.maxSize,
        members: mine.map((m) => ({ who: who(m.privyUserId, m.publicWallet), captain: m.privyUserId === s.captainPrivyUserId, taps: best.get(m.privyUserId) ?? 0 })),
        combinedTaps,
        target,
        complete: target > 0 && combinedTaps >= target,
        mine: mine.some((m) => m.privyUserId === privyUserId),
      }
    })
  }

  async function squadCampaign(id: string) {
    const c = /^[0-9a-f-]{36}$/.test(id) ? await deps.campaigns.findById(id) : null
    if (!c) throw new ClaimError('NOT_FOUND', 'campaign not found', 404)
    if (!hasTapRush(c)) throw new ClaimError('NO_SQUADS', 'squads are for Tap Rush drops', 409)
    return c
  }

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id/squads', async (req) => {
    const auth = await requireAuth(req)
    const c = await squadCampaign(req.params.id)
    const social = requireSocial()
    const mine = await social.squadForUser(c.id, auth.privyUserId)
    const all = await squadViews(c, await social.squadsFor(c.id, 50), auth.privyUserId)
    const [mineView] = mine ? await squadViews(c, [mine], auth.privyUserId) : []
    return { mine: mineView ?? null, squads: all.sort((a, b) => b.combinedTaps - a.combinedTaps).slice(0, 20) }
  })

  app.post<{ Params: { id: string } }>('/v1/campaigns/:id/squads', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const c = await squadCampaign(req.params.id)
    if (c.status !== 'LIVE') return send(reply, 409, 'NOT_LIVE', 'this drop is not live')
    if (c.creatorPrivyUserId === auth.privyUserId) return send(reply, 403, 'OWN_CAMPAIGN', 'you created this drop')
    if (!limiter.hit(`squad:${auth.privyUserId}`, CLUB_LIMITS.squadsPerDay, DAY)) return send(reply, 429, 'RATE_LIMITED', 'you have started enough squads today')
    const parsed = createSquadRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'invalid name')
    try {
      const s = await requireSocial().createSquad(
        { id: randomUUID(), campaignId: c.id, name: parsed.data.name, code: newCode(6), captainPrivyUserId: auth.privyUserId, maxSize: CLUB_LIMITS.squadSize },
        await myWallet(auth.privyUserId),
      )
      return reply.status(201).send({ squad: (await squadViews(c, [s], auth.privyUserId))[0] })
    } catch (err) {
      if (err instanceof AlreadyInSquadError) return send(reply, 409, 'ALREADY_IN_SQUAD', 'you are already in a squad for this drop')
      throw err
    }
  })

  app.post('/v1/squads/join', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const parsed = joinSquadRequest.safeParse(req.body)
    if (!parsed.success) return send(reply, 400, 'INVALID_CODE', parsed.error.issues[0]?.message ?? 'invalid code')
    const social = requireSocial()
    const s = await social.findSquadByCode(parsed.data.code)
    if (!s) return send(reply, 404, 'INVALID_CODE', 'no squad has that code')
    const c = await squadCampaign(s.campaignId)
    if (c.status !== 'LIVE') return send(reply, 409, 'NOT_LIVE', 'this drop is not live')
    if (c.creatorPrivyUserId === auth.privyUserId) return send(reply, 403, 'OWN_CAMPAIGN', 'you created this drop')
    const r = await social.joinSquad(s, auth.privyUserId, await myWallet(auth.privyUserId))
    if (r === 'FULL') return send(reply, 409, 'SQUAD_FULL', 'this squad is full')
    if (r === 'ALREADY_IN_SQUAD') return send(reply, 409, 'ALREADY_IN_SQUAD', 'you are already in a squad for this drop')
    return { squad: (await squadViews(c, [s], auth.privyUserId))[0] }
  })

  app.post<{ Params: { id: string } }>('/v1/squads/:id/leave', async (req, reply) => {
    const auth = await requireAuth(req)
    throttle(req, auth)
    const social = requireSocial()
    const s = await social.findSquad(req.params.id)
    if (!s || (await social.squadForUser(s.campaignId, auth.privyUserId))?.id !== s.id) return send(reply, 404, 'NOT_FOUND', 'you are not in this squad')
    await social.leaveSquad(s, auth.privyUserId)
    return { ok: true, disbanded: s.captainPrivyUserId === auth.privyUserId }
  })

  // ---- Stock Passport: achievements derived from real records (no NFTs, no SOL, no balances) ----

  app.get('/v1/me/passport', async (req) => {
    const auth = await requireAuth(req)
    const social = deps.social
    const badges: PassportBadge[] = []
    const claims = deps.claims ? (await deps.claims.listForUser(auth.privyUserId, 200)).filter((c) => c.kind === 'CLAIM' && c.status === 'PAID') : []
    let firstClubDrop: { at: Date; id: string } | null = null
    for (const cl of claims) {
      const c = await deps.campaigns.findById(cl.campaignId)
      if (!c) continue
      badges.push({ id: `REWARD:${cl.id}`, title: `${c.xstockSymbol} ${TYPE_LABEL[c.type]}`, detail: 'Completed · reward settled', at: cl.updatedAt.toISOString() })
      if (c.clubId && (!firstClubDrop || cl.updatedAt < firstClubDrop.at)) firstClubDrop = { at: cl.updatedAt, id: cl.id }
    }
    if (firstClubDrop) badges.push({ id: 'FIRST_CLUB_DROP', title: 'First club drop', detail: 'Won a drop posted in a club', at: firstClubDrop.at.toISOString() })
    const checkins = social ? await social.checkinsOf(auth.privyUserId) : []
    for (const ch of checkins) {
      const c = await deps.campaigns.findById(ch.campaignId)
      badges.push({ id: `CHECKIN:${ch.campaignId}`, title: 'Event check-in', detail: c ? `${c.xstockSymbol} event` : 'Blink event', at: ch.at.toISOString() })
    }
    const memberships = social ? await social.membershipsOf(auth.privyUserId) : []
    const firstJoin = memberships.at(-1)
    if (firstJoin) badges.push({ id: 'FIRST_CLUB', title: 'First club', detail: memberships.length > 1 ? `Member of ${memberships.length} clubs` : 'Joined a club', at: firstJoin.joinedAt.toISOString() })
    // D-44: first gift sent and first gift received (confirmed transfers).
    if (social) {
      const firstSent = (await social.giftsSent(auth.privyUserId, 200)).filter((g) => g.status === 'CONFIRMED').at(-1)
      const firstGot = (await social.giftsReceived(auth.privyUserId, 200)).filter((g) => g.status === 'CONFIRMED').at(-1)
      if (firstSent) badges.push({ id: 'FIRST_GIFT_SENT', title: 'First gift sent', detail: `Gave ${firstSent.symbol} to a club member`, at: firstSent.createdAt.toISOString() })
      if (firstGot) badges.push({ id: 'FIRST_GIFT_RECEIVED', title: 'Gift received', detail: `Got ${firstGot.symbol} from a club member`, at: firstGot.createdAt.toISOString() })
    }
    let squadWins = 0
    if (social) {
      for (const s of await social.squadsOf(auth.privyUserId)) {
        const c = await deps.campaigns.findById(s.campaignId)
        if (!c) continue
        const [view] = await squadViews(c, [s], auth.privyUserId)
        if (view?.complete) {
          squadWins += 1
          badges.push({ id: `SQUAD:${s.id}`, title: `Squad goal: ${s.name}`, detail: `${view.combinedTaps.toLocaleString('en-US')} combined taps`, at: s.createdAt.toISOString() })
        }
      }
    }
    badges.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    // D-42: one-way passport number from the account id; 32-symbol alphabet without look-alikes.
    const digest = createHash('sha256').update(`blink-passport:${auth.privyUserId}`).digest()
    const sym = [...digest.subarray(0, 8)].map((b) => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 32]).join('')
    const dates = [...badges.map((b) => Date.parse(b.at)), ...memberships.map((m) => m.joinedAt.getTime())]
    const passport: Passport = {
      badges,
      rewards: claims.length,
      checkins: checkins.length,
      clubs: memberships.length,
      squadWins,
      number: `BLK-${sym.slice(0, 4)}-${sym.slice(4)}`,
      memberSince: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      level: passportLevel(badges.length).level,
    }
    return { passport }
  })
}

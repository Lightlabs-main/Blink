import { randomBytes, randomInt } from 'node:crypto'

import type { ClubCategory, ClubRole, ClubVisibility, QuestGroup } from '@blink/domain'

import { Prisma as Db } from './generated/prisma/client.ts'
import type { createPrismaClient } from './prisma-campaign-repo.ts'

/*
 * D-40: clubs, club chat, event check-ins and squads. All of it is offchain Blink state (Postgres): joining a club,
 * chatting, checking in or forming a squad never costs SOL and never writes to Solana.
 */

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export function newCode(length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}
/** 24 random bytes, URL-safe: the secret behind an event QR. */
export const newEventToken = () => randomBytes(24).toString('base64url')

export interface StoredClub {
  id: string
  slug: string
  name: string
  description: string
  category: ClubCategory
  tags: string[]
  visibility: ClubVisibility
  inviteCode: string
  ownerPrivyUserId: string | null
  /** D-41: join rules; empty = anyone. */
  rules: QuestGroup[]
  /** D-43: only the owner and admins can send messages. */
  adminsOnly: boolean
  pinnedMessageId: bigint | null
  createdAt: Date
}

/** What a creator supplies; the store fills the chat settings with their defaults. */
export type NewClub = Omit<StoredClub, 'createdAt' | 'adminsOnly' | 'pinnedMessageId'>

export interface StoredMember {
  clubId: string
  privyUserId: string
  role: ClubRole
  publicWallet: string | null
  /** D-43: muted by an admin until then. */
  mutedUntil: Date | null
  joinedAt: Date
}

export interface StoredBan {
  clubId: string
  privyUserId: string
  publicWallet: string | null
  createdAt: Date
}

export interface NewMessage {
  clubId: string
  authorPrivyUserId: string
  authorWallet: string | null
  body: string
  replyToId: bigint | null
  /** D-43: voice notes. */
  kind?: 'TEXT' | 'VOICE' | 'GIFT'
  voiceId?: string | null
  voiceMs?: number | null
  /** D-44: gifts. */
  giftId?: string | null
}

export interface StoredGift {
  id: string
  clubId: string
  senderPrivyUserId: string
  recipientPrivyUserId: string
  senderWallet: string | null
  mint: string
  symbol: string
  decimals: number
  amountRaw: bigint
  cluster: string
  signature: string
  status: 'CONFIRMED' | 'PENDING'
  createdAt: Date
}

export interface StoredMessage {
  id: bigint
  clubId: string
  authorPrivyUserId: string
  authorWallet: string | null
  body: string
  replyToId: bigint | null
  kind: string
  voiceId: string | null
  voiceMs: number | null
  giftId: string | null
  deletedAt: Date | null
  createdAt: Date
}

export interface StoredReaction {
  messageId: bigint
  privyUserId: string
  emoji: string
}

export interface StoredSquad {
  id: string
  campaignId: string
  name: string
  code: string
  captainPrivyUserId: string
  maxSize: number
  createdAt: Date
}

export interface StoredSquadMember {
  squadId: string
  campaignId: string
  privyUserId: string
  publicWallet: string | null
  joinedAt: Date
}

export class SlugTakenError extends Error {
  override name = 'SlugTakenError'
}
export class AlreadyInSquadError extends Error {
  override name = 'AlreadyInSquadError'
}

export interface SocialStore {
  /** Creates the club and, when there is an owner, their OWNER membership. Throws SlugTakenError. */
  createClub(club: NewClub, owner: { privyUserId: string; publicWallet: string | null } | null): Promise<StoredClub>
  findClub(idOrSlug: string): Promise<StoredClub | null>
  /** Owner deletion: the club disappears from every lookup and its slug is freed; rows stay for receipts. */
  deleteClub(clubId: string): Promise<void>
  /** Days (any time that day) the person posted in any club chat since `since` — for the activity streak. */
  messageTimesOf(privyUserId: string, since: Date): Promise<Date[]>
  setRules(clubId: string, rules: QuestGroup[]): Promise<void>
  /** D-43: chat settings (owner/admins). */
  setSettings(clubId: string, s: { adminsOnly?: boolean; description?: string; pinnedMessageId?: bigint | null }): Promise<void>
  setRole(clubId: string, privyUserId: string, role: 'MOD' | 'MEMBER'): Promise<void>
  setMuted(clubId: string, privyUserId: string, until: Date | null): Promise<void>
  /** Removes the membership and records the ban (they can't rejoin until unbanned). */
  ban(clubId: string, privyUserId: string, by: string, publicWallet: string | null): Promise<void>
  unban(clubId: string, privyUserId: string): Promise<void>
  isBanned(clubId: string, privyUserId: string): Promise<boolean>
  bans(clubId: string): Promise<StoredBan[]>
  /** D-43: voice-note audio by its random id. */
  addVoice(v: { id: string; clubId: string; bytes: Uint8Array; mime: string }): Promise<void>
  voice(id: string): Promise<{ bytes: Uint8Array; mime: string; clubId: string } | null>
  messageByVoiceId(voiceId: string): Promise<StoredMessage | null>
  /** D-44: xStock gifts (one row per confirmed or still-confirming transfer). */
  createGift(g: Omit<StoredGift, 'createdAt'>): Promise<StoredGift>
  giftsByIds(ids: string[]): Promise<StoredGift[]>
  giftsReceived(privyUserId: string, limit: number): Promise<StoredGift[]>
  giftsSent(privyUserId: string, limit: number): Promise<StoredGift[]>
  findClubByInvite(code: string): Promise<StoredClub | null>
  /** Public clubs plus the caller's own (private ones included), newest first, at most `limit`. */
  listClubs(opts: { privyUserId: string; q?: string; limit: number }): Promise<StoredClub[]>
  clubsByIds(ids: string[]): Promise<StoredClub[]>
  countClubsOwnedSince(privyUserId: string, since: Date): Promise<number>
  memberCounts(clubIds: string[]): Promise<Map<string, number>>
  membership(clubId: string, privyUserId: string): Promise<StoredMember | null>
  membershipsOf(privyUserId: string): Promise<StoredMember[]>
  members(clubId: string, limit: number): Promise<StoredMember[]>
  /** false when already a member. */
  join(clubId: string, privyUserId: string, publicWallet: string | null): Promise<boolean>
  /** false when not a member. Owners cannot leave (they would orphan the club). */
  leave(clubId: string, privyUserId: string): Promise<boolean>

  addMessage(m: NewMessage): Promise<StoredMessage>
  /** Ascending by id. `before`: the page just older than it (newest first page when absent); `after`: newer ones. */
  listMessages(clubId: string, opts: { before?: bigint; after?: bigint; limit: number }): Promise<StoredMessage[]>
  messagesByIds(ids: bigint[]): Promise<StoredMessage[]>
  /** Soft delete: the body is cleared, the row stays so replies and pagination keep working. */
  deleteMessage(id: bigint, by: string): Promise<void>
  reactions(messageIds: bigint[]): Promise<StoredReaction[]>
  /** Adds the reaction, or removes it when the person already gave it. */
  toggleReaction(messageId: bigint, privyUserId: string, emoji: string): Promise<void>
  /** Records one report per person per message; returns the number of distinct reports. */
  report(messageId: bigint, privyUserId: string): Promise<number>

  /** The campaign's event token, created on first use; `rotate` replaces it (old QR codes stop working). */
  eventToken(campaignId: string, rotate: boolean): Promise<string>
  campaignForEventToken(token: string): Promise<string | null>
  /** true when this is a new check-in; false when the person had already checked in. */
  checkIn(campaignId: string, privyUserId: string): Promise<boolean>
  hasCheckedIn(campaignId: string, privyUserId: string): Promise<boolean>
  checkinsOf(privyUserId: string): Promise<{ campaignId: string; at: Date }[]>
  checkinsFor(campaignIds: string[]): Promise<{ campaignId: string; privyUserId: string; at: Date }[]>
  campaignIdsForClub(clubId: string, limit: number): Promise<string[]>

  /** Creates the squad with its captain as first member. Throws AlreadyInSquadError. */
  createSquad(s: Omit<StoredSquad, 'createdAt'>, captainWallet: string | null): Promise<StoredSquad>
  findSquad(id: string): Promise<StoredSquad | null>
  findSquadByCode(code: string): Promise<StoredSquad | null>
  squadForUser(campaignId: string, privyUserId: string): Promise<StoredSquad | null>
  squadsOf(privyUserId: string): Promise<StoredSquad[]>
  squadsFor(campaignId: string, limit: number): Promise<StoredSquad[]>
  squadMembers(squadIds: string[]): Promise<StoredSquadMember[]>
  /** Atomic size check. */
  joinSquad(squad: StoredSquad, privyUserId: string, publicWallet: string | null): Promise<'OK' | 'FULL' | 'ALREADY_IN_SQUAD'>
  /** A captain leaving disbands the squad. */
  leaveSquad(squad: StoredSquad, privyUserId: string): Promise<void>
}

const isUuid = (s: string) => /^[0-9a-f-]{36}$/.test(s)

/** Test/dev store. Not for production data. */
export class InMemorySocialStore implements SocialStore {
  private readonly clubs = new Map<string, StoredClub>()
  private readonly memberRows = new Map<string, StoredMember>()
  private readonly messages: StoredMessage[] = []
  private readonly reactionRows: (StoredReaction & { at: Date })[] = []
  private readonly reports = new Set<string>()
  private readonly banRows = new Map<string, StoredBan>()
  private readonly gifts: StoredGift[] = []
  private readonly voices = new Map<string, { id: string; clubId: string; bytes: Uint8Array; mime: string }>()
  private readonly eventTokens = new Map<string, string>()
  private readonly checkins: { campaignId: string; privyUserId: string; at: Date }[] = []
  private readonly squads = new Map<string, StoredSquad>()
  private readonly squadMemberRows: StoredSquadMember[] = []
  /** Optional link to campaign rows (campaign.clubId), for campaignIdsForClub. */
  constructor(private readonly campaignClubs: () => { id: string; clubId: string | null; createdAt: Date }[] = () => []) {}

  private mk(c: string, u: string) {
    return `${c}|${u}`
  }

  async createClub(club: NewClub, owner: { privyUserId: string; publicWallet: string | null } | null) {
    for (const c of this.clubs.values()) if (c.slug === club.slug) throw new SlugTakenError()
    const stored: StoredClub = { ...club, adminsOnly: false, pinnedMessageId: null, createdAt: new Date() }
    this.clubs.set(club.id, stored)
    if (owner) this.memberRows.set(this.mk(club.id, owner.privyUserId), { clubId: club.id, privyUserId: owner.privyUserId, role: 'OWNER', publicWallet: owner.publicWallet, mutedUntil: null, joinedAt: new Date() })
    return { ...stored }
  }
  async findClub(idOrSlug: string) {
    const c = isUuid(idOrSlug) ? this.clubs.get(idOrSlug) : [...this.clubs.values()].find((x) => x.slug === idOrSlug)
    return c && !this.deleted.has(c.id) ? { ...c } : null
  }
  private readonly deleted = new Set<string>()
  async deleteClub(clubId: string) {
    const c = this.clubs.get(clubId)
    if (!c) return
    this.deleted.add(clubId)
    c.slug = freedSlug(c.slug, clubId)
  }
  async messageTimesOf(privyUserId: string, since: Date) {
    return this.messages.filter((m) => m.authorPrivyUserId === privyUserId && m.createdAt >= since).map((m) => m.createdAt)
  }
  async setRules(clubId: string, rules: QuestGroup[]) {
    const c = this.clubs.get(clubId)
    if (c) c.rules = rules
  }
  async setSettings(clubId: string, st: { adminsOnly?: boolean; description?: string; pinnedMessageId?: bigint | null }) {
    const c = this.clubs.get(clubId)
    if (!c) return
    if (st.adminsOnly !== undefined) c.adminsOnly = st.adminsOnly
    if (st.description !== undefined) c.description = st.description
    if (st.pinnedMessageId !== undefined) c.pinnedMessageId = st.pinnedMessageId
  }
  async setRole(clubId: string, privyUserId: string, role: 'MOD' | 'MEMBER') {
    const m = this.memberRows.get(this.mk(clubId, privyUserId))
    if (m && m.role !== 'OWNER') m.role = role
  }
  async setMuted(clubId: string, privyUserId: string, until: Date | null) {
    const m = this.memberRows.get(this.mk(clubId, privyUserId))
    if (m) m.mutedUntil = until
  }
  async ban(clubId: string, privyUserId: string, _by: string, publicWallet: string | null) {
    const k = this.mk(clubId, privyUserId)
    if (this.memberRows.get(k)?.role === 'OWNER') return
    this.memberRows.delete(k)
    this.banRows.set(k, { clubId, privyUserId, publicWallet, createdAt: new Date() })
  }
  async unban(clubId: string, privyUserId: string) {
    this.banRows.delete(this.mk(clubId, privyUserId))
  }
  async isBanned(clubId: string, privyUserId: string) {
    return this.banRows.has(this.mk(clubId, privyUserId))
  }
  async bans(clubId: string) {
    return [...this.banRows.values()].filter((b) => b.clubId === clubId)
  }
  async addVoice(v: { id: string; clubId: string; bytes: Uint8Array; mime: string }) {
    this.voices.set(v.id, v)
  }
  async voice(id: string) {
    return this.voices.get(id) ?? null
  }
  async messageByVoiceId(voiceId: string) {
    return this.messages.find((m) => m.voiceId === voiceId) ?? null
  }
  async createGift(g: Omit<StoredGift, 'createdAt'>) {
    const stored = { ...g, createdAt: new Date() }
    this.gifts.push(stored)
    return { ...stored }
  }
  async giftsByIds(ids: string[]) {
    return this.gifts.filter((g) => ids.includes(g.id))
  }
  async giftsReceived(privyUserId: string, limit: number) {
    return this.gifts.filter((g) => g.recipientPrivyUserId === privyUserId).reverse().slice(0, limit)
  }
  async giftsSent(privyUserId: string, limit: number) {
    return this.gifts.filter((g) => g.senderPrivyUserId === privyUserId).reverse().slice(0, limit)
  }
  async findClubByInvite(code: string) {
    return [...this.clubs.values()].find((c) => c.inviteCode === code && !this.deleted.has(c.id)) ?? null
  }
  async listClubs({ privyUserId, q, limit }: { privyUserId: string; q?: string; limit: number }) {
    const mine = new Set((await this.membershipsOf(privyUserId)).map((m) => m.clubId))
    const needle = q?.toLowerCase()
    return [...this.clubs.values()]
      .filter((c) => !this.deleted.has(c.id))
      .filter((c) => c.visibility === 'PUBLIC' || mine.has(c.id))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.slug.includes(needle) || c.tags.some((t) => t.includes(needle)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  }
  async clubsByIds(ids: string[]) {
    return ids.map((id) => this.clubs.get(id)).filter((c): c is StoredClub => Boolean(c) && !this.deleted.has(c!.id))
  }
  async countClubsOwnedSince(privyUserId: string, since: Date) {
    return [...this.clubs.values()].filter((c) => c.ownerPrivyUserId === privyUserId && c.createdAt >= since).length
  }
  async memberCounts(clubIds: string[]) {
    const out = new Map(clubIds.map((id) => [id, 0]))
    for (const m of this.memberRows.values()) if (out.has(m.clubId)) out.set(m.clubId, out.get(m.clubId)! + 1)
    return out
  }
  async membership(clubId: string, privyUserId: string) {
    return this.memberRows.get(this.mk(clubId, privyUserId)) ?? null
  }
  async membershipsOf(privyUserId: string) {
    return [...this.memberRows.values()].filter((m) => m.privyUserId === privyUserId).sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime())
  }
  async members(clubId: string, limit: number) {
    return [...this.memberRows.values()].filter((m) => m.clubId === clubId).slice(0, limit)
  }
  async join(clubId: string, privyUserId: string, publicWallet: string | null) {
    const k = this.mk(clubId, privyUserId)
    if (this.memberRows.has(k)) return false
    this.memberRows.set(k, { clubId, privyUserId, role: 'MEMBER', publicWallet, mutedUntil: null, joinedAt: new Date() })
    return true
  }
  async leave(clubId: string, privyUserId: string) {
    const k = this.mk(clubId, privyUserId)
    const m = this.memberRows.get(k)
    if (!m || m.role === 'OWNER') return false
    this.memberRows.delete(k)
    return true
  }

  async addMessage(m: NewMessage) {
    const stored: StoredMessage = { ...m, kind: m.kind ?? 'TEXT', voiceId: m.voiceId ?? null, voiceMs: m.voiceMs ?? null, giftId: m.giftId ?? null, id: BigInt(this.messages.length + 1), deletedAt: null, createdAt: new Date() }
    this.messages.push(stored)
    return { ...stored }
  }
  async listMessages(clubId: string, { before, after, limit }: { before?: bigint; after?: bigint; limit: number }) {
    const rows = this.messages.filter((m) => m.clubId === clubId && (before === undefined || m.id < before) && (after === undefined || m.id > after))
    return (after !== undefined ? rows.slice(0, limit) : rows.slice(-limit)).map((m) => ({ ...m }))
  }
  async messagesByIds(ids: bigint[]) {
    return this.messages.filter((m) => ids.includes(m.id)).map((m) => ({ ...m }))
  }
  async deleteMessage(id: bigint) {
    const m = this.messages.find((x) => x.id === id)
    if (m && !m.deletedAt) Object.assign(m, { deletedAt: new Date(), body: '' })
  }
  async reactions(messageIds: bigint[]) {
    return this.reactionRows.filter((r) => messageIds.includes(r.messageId))
  }
  async toggleReaction(messageId: bigint, privyUserId: string, emoji: string) {
    const i = this.reactionRows.findIndex((r) => r.messageId === messageId && r.privyUserId === privyUserId && r.emoji === emoji)
    if (i >= 0) this.reactionRows.splice(i, 1)
    else this.reactionRows.push({ messageId, privyUserId, emoji, at: new Date() })
  }

  async report(messageId: bigint, privyUserId: string) {
    this.reports.add(`${messageId}|${privyUserId}`)
    return [...this.reports].filter((r) => r.startsWith(`${messageId}|`)).length
  }

  async eventToken(campaignId: string, rotate: boolean) {
    if (rotate || !this.eventTokens.has(campaignId)) this.eventTokens.set(campaignId, newEventToken())
    return this.eventTokens.get(campaignId)!
  }
  async campaignForEventToken(token: string) {
    for (const [c, t] of this.eventTokens) if (t === token) return c
    return null
  }
  async checkIn(campaignId: string, privyUserId: string) {
    if (await this.hasCheckedIn(campaignId, privyUserId)) return false
    this.checkins.push({ campaignId, privyUserId, at: new Date() })
    return true
  }
  async hasCheckedIn(campaignId: string, privyUserId: string) {
    return this.checkins.some((c) => c.campaignId === campaignId && c.privyUserId === privyUserId)
  }
  async checkinsOf(privyUserId: string) {
    return this.checkins.filter((c) => c.privyUserId === privyUserId).map((c) => ({ campaignId: c.campaignId, at: c.at }))
  }
  async checkinsFor(campaignIds: string[]) {
    return this.checkins.filter((c) => campaignIds.includes(c.campaignId))
  }
  async campaignIdsForClub(clubId: string, limit: number) {
    return this.campaignClubs()
      .filter((c) => c.clubId === clubId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((c) => c.id)
  }

  async createSquad(s: Omit<StoredSquad, 'createdAt'>, captainWallet: string | null) {
    if (this.squadMemberRows.some((m) => m.campaignId === s.campaignId && m.privyUserId === s.captainPrivyUserId)) throw new AlreadyInSquadError()
    const stored = { ...s, createdAt: new Date() }
    this.squads.set(s.id, stored)
    this.squadMemberRows.push({ squadId: s.id, campaignId: s.campaignId, privyUserId: s.captainPrivyUserId, publicWallet: captainWallet, joinedAt: new Date() })
    return { ...stored }
  }
  async findSquad(id: string) {
    return this.squads.get(id) ?? null
  }
  async findSquadByCode(code: string) {
    return [...this.squads.values()].find((s) => s.code === code) ?? null
  }
  async squadForUser(campaignId: string, privyUserId: string) {
    const m = this.squadMemberRows.find((r) => r.campaignId === campaignId && r.privyUserId === privyUserId)
    return m ? (this.squads.get(m.squadId) ?? null) : null
  }
  async squadsOf(privyUserId: string) {
    return this.squadMemberRows.filter((m) => m.privyUserId === privyUserId).map((m) => this.squads.get(m.squadId)!).filter(Boolean)
  }
  async squadsFor(campaignId: string, limit: number) {
    return [...this.squads.values()].filter((s) => s.campaignId === campaignId).slice(0, limit)
  }
  async squadMembers(squadIds: string[]) {
    return this.squadMemberRows.filter((m) => squadIds.includes(m.squadId)).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
  }
  async joinSquad(squad: StoredSquad, privyUserId: string, publicWallet: string | null) {
    if (this.squadMemberRows.some((m) => m.campaignId === squad.campaignId && m.privyUserId === privyUserId)) return 'ALREADY_IN_SQUAD' as const
    if (this.squadMemberRows.filter((m) => m.squadId === squad.id).length >= squad.maxSize) return 'FULL' as const
    this.squadMemberRows.push({ squadId: squad.id, campaignId: squad.campaignId, privyUserId, publicWallet, joinedAt: new Date() })
    return 'OK' as const
  }
  async leaveSquad(squad: StoredSquad, privyUserId: string) {
    const disband = squad.captainPrivyUserId === privyUserId
    for (let i = this.squadMemberRows.length - 1; i >= 0; i--) {
      const m = this.squadMemberRows[i]!
      if (m.squadId === squad.id && (disband || m.privyUserId === privyUserId)) this.squadMemberRows.splice(i, 1)
    }
    if (disband) this.squads.delete(squad.id)
  }
}

type Prisma = ReturnType<typeof createPrismaClient>
const isUnique = (err: unknown) => (err as { code?: string }).code === 'P2002'

/** A deleted club gives its slug back (slugs are unique), so the name can be used again. */
function freedSlug(slug: string, clubId: string) {
  return `${slug.slice(0, 40)}--deleted-${clubId.slice(0, 8)}`
}

function toClub(r: { id: string; slug: string; name: string; description: string; category: string; tags: string[]; visibility: string; inviteCode: string; ownerPrivyUserId: string | null; rulesJson: unknown; adminsOnly: boolean; pinnedMessageId: bigint | null; createdAt: Date; deletedAt?: Date | null }): StoredClub {
  const { rulesJson, deletedAt: _deleted, ...rest } = r
  return { ...rest, category: r.category as ClubCategory, visibility: r.visibility as ClubVisibility, rules: Array.isArray(rulesJson) ? (rulesJson as QuestGroup[]) : [] }
}
const toGift = (r: Omit<StoredGift, 'amountRaw' | 'status'> & { amountRaw: { toFixed(d: number): string }; status: string }): StoredGift => ({
  ...r,
  amountRaw: BigInt(r.amountRaw.toFixed(0)),
  status: r.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING',
})
const toMember = (r: { clubId: string; privyUserId: string; role: string; publicWallet: string | null; mutedUntil: Date | null; joinedAt: Date }): StoredMember => ({ ...r, role: r.role as ClubRole })

export class PrismaSocialStore implements SocialStore {
  constructor(private readonly prisma: Prisma) {}

  async createClub(club: NewClub, owner: { privyUserId: string; publicWallet: string | null } | null) {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const { rules, ...data } = club
        const created = await tx.club.create({ data: { ...data, rulesJson: rules.length ? (rules as object[]) : undefined } })
        if (owner) await tx.clubMember.create({ data: { clubId: club.id, privyUserId: owner.privyUserId, role: 'OWNER', publicWallet: owner.publicWallet } })
        return created
      })
      return toClub(row)
    } catch (err) {
      if (isUnique(err)) throw new SlugTakenError()
      throw err
    }
  }
  async findClub(idOrSlug: string) {
    const row = await this.prisma.club.findUnique({ where: isUuid(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug } })
    return row && !row.deletedAt ? toClub(row) : null
  }
  async deleteClub(clubId: string) {
    const row = await this.prisma.club.findUnique({ where: { id: clubId } })
    if (!row || row.deletedAt) return
    await this.prisma.club.update({ where: { id: clubId }, data: { deletedAt: new Date(), slug: freedSlug(row.slug, clubId) } })
  }
  async messageTimesOf(privyUserId: string, since: Date) {
    const rows = await this.prisma.clubMessage.findMany({ where: { authorPrivyUserId: privyUserId, createdAt: { gte: since } }, select: { createdAt: true }, take: 5000 })
    return rows.map((r) => r.createdAt)
  }
  async setRules(clubId: string, rules: QuestGroup[]) {
    await this.prisma.club.update({ where: { id: clubId }, data: { rulesJson: rules.length ? (rules as object[]) : Db.DbNull } })
  }
  async setSettings(clubId: string, st: { adminsOnly?: boolean; description?: string; pinnedMessageId?: bigint | null }) {
    await this.prisma.club.update({ where: { id: clubId }, data: st })
  }
  async setRole(clubId: string, privyUserId: string, role: 'MOD' | 'MEMBER') {
    await this.prisma.clubMember.updateMany({ where: { clubId, privyUserId, role: { not: 'OWNER' } }, data: { role } })
  }
  async setMuted(clubId: string, privyUserId: string, until: Date | null) {
    await this.prisma.clubMember.updateMany({ where: { clubId, privyUserId }, data: { mutedUntil: until } })
  }
  async ban(clubId: string, privyUserId: string, by: string, publicWallet: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.clubMember.deleteMany({ where: { clubId, privyUserId, role: { not: 'OWNER' } } })
      if (removed.count === 0 && (await tx.clubMember.findUnique({ where: { clubId_privyUserId: { clubId, privyUserId } } }))) return
      await tx.clubBan.upsert({ where: { clubId_privyUserId: { clubId, privyUserId } }, create: { clubId, privyUserId, byPrivyUserId: by, publicWallet }, update: {} })
    })
  }
  async unban(clubId: string, privyUserId: string) {
    await this.prisma.clubBan.deleteMany({ where: { clubId, privyUserId } })
  }
  async isBanned(clubId: string, privyUserId: string) {
    return Boolean(await this.prisma.clubBan.findUnique({ where: { clubId_privyUserId: { clubId, privyUserId } } }))
  }
  async bans(clubId: string) {
    return this.prisma.clubBan.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' }, take: 500 })
  }
  async addVoice(v: { id: string; clubId: string; bytes: Uint8Array; mime: string }) {
    await this.prisma.clubVoice.create({ data: { ...v, bytes: Buffer.from(v.bytes) } })
  }
  async voice(id: string) {
    const r = await this.prisma.clubVoice.findUnique({ where: { id } })
    return r ? { bytes: new Uint8Array(r.bytes), mime: r.mime, clubId: r.clubId } : null
  }
  async messageByVoiceId(voiceId: string) {
    return this.prisma.clubMessage.findUnique({ where: { voiceId } })
  }
  async createGift(g: Omit<StoredGift, 'createdAt'>) {
    return toGift(await this.prisma.clubGift.create({ data: { ...g, amountRaw: g.amountRaw.toString() } }))
  }
  async giftsByIds(ids: string[]) {
    return ids.length ? (await this.prisma.clubGift.findMany({ where: { id: { in: ids } } })).map(toGift) : []
  }
  async giftsReceived(privyUserId: string, limit: number) {
    return (await this.prisma.clubGift.findMany({ where: { recipientPrivyUserId: privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })).map(toGift)
  }
  async giftsSent(privyUserId: string, limit: number) {
    return (await this.prisma.clubGift.findMany({ where: { senderPrivyUserId: privyUserId }, orderBy: { createdAt: 'desc' }, take: limit })).map(toGift)
  }
  async findClubByInvite(code: string) {
    const row = await this.prisma.club.findUnique({ where: { inviteCode: code } })
    return row && !row.deletedAt ? toClub(row) : null
  }
  async listClubs({ privyUserId, q, limit }: { privyUserId: string; q?: string; limit: number }) {
    const mine = (await this.prisma.clubMember.findMany({ where: { privyUserId }, select: { clubId: true } })).map((m) => m.clubId)
    const needle = q?.trim().toLowerCase()
    const rows = await this.prisma.club.findMany({
      where: {
        AND: [
          { deletedAt: null },
          { OR: [{ visibility: 'PUBLIC' }, { id: { in: mine } }] },
          needle ? { OR: [{ name: { contains: needle, mode: 'insensitive' } }, { slug: { contains: needle } }, { tags: { has: needle } }] } : {},
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return rows.map(toClub)
  }
  async clubsByIds(ids: string[]) {
    return ids.length ? (await this.prisma.club.findMany({ where: { id: { in: ids }, deletedAt: null } })).map(toClub) : []
  }
  async countClubsOwnedSince(privyUserId: string, since: Date) {
    return this.prisma.club.count({ where: { ownerPrivyUserId: privyUserId, createdAt: { gte: since } } })
  }
  async memberCounts(clubIds: string[]) {
    const out = new Map(clubIds.map((id) => [id, 0]))
    if (!clubIds.length) return out
    const rows = await this.prisma.clubMember.groupBy({ by: ['clubId'], where: { clubId: { in: clubIds } }, _count: { _all: true } })
    for (const r of rows) out.set(r.clubId, r._count._all)
    return out
  }
  async membership(clubId: string, privyUserId: string) {
    const row = await this.prisma.clubMember.findUnique({ where: { clubId_privyUserId: { clubId, privyUserId } } })
    return row ? toMember(row) : null
  }
  async membershipsOf(privyUserId: string) {
    return (await this.prisma.clubMember.findMany({ where: { privyUserId }, orderBy: { joinedAt: 'desc' }, take: 200 })).map(toMember)
  }
  async members(clubId: string, limit: number) {
    return (await this.prisma.clubMember.findMany({ where: { clubId }, orderBy: { joinedAt: 'asc' }, take: limit })).map(toMember)
  }
  async join(clubId: string, privyUserId: string, publicWallet: string | null) {
    try {
      await this.prisma.clubMember.create({ data: { clubId, privyUserId, publicWallet } })
      return true
    } catch (err) {
      if (isUnique(err)) return false
      throw err
    }
  }
  async leave(clubId: string, privyUserId: string) {
    const r = await this.prisma.clubMember.deleteMany({ where: { clubId, privyUserId, role: { not: 'OWNER' } } })
    return r.count > 0
  }

  async addMessage(m: NewMessage) {
    return this.prisma.clubMessage.create({ data: m })
  }
  async listMessages(clubId: string, { before, after, limit }: { before?: bigint; after?: bigint; limit: number }) {
    if (after !== undefined) {
      return this.prisma.clubMessage.findMany({ where: { clubId, id: { gt: after } }, orderBy: { id: 'asc' }, take: limit })
    }
    const rows = await this.prisma.clubMessage.findMany({ where: { clubId, ...(before !== undefined ? { id: { lt: before } } : {}) }, orderBy: { id: 'desc' }, take: limit })
    return rows.reverse()
  }
  async messagesByIds(ids: bigint[]) {
    return ids.length ? this.prisma.clubMessage.findMany({ where: { id: { in: ids } } }) : []
  }
  async deleteMessage(id: bigint, by: string) {
    await this.prisma.clubMessage.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: by, body: '' } })
  }
  async reactions(messageIds: bigint[]) {
    return messageIds.length ? this.prisma.clubMessageReaction.findMany({ where: { messageId: { in: messageIds } } }) : []
  }
  async toggleReaction(messageId: bigint, privyUserId: string, emoji: string) {
    const removed = await this.prisma.clubMessageReaction.deleteMany({ where: { messageId, privyUserId, emoji } })
    if (removed.count > 0) return
    try {
      await this.prisma.clubMessageReaction.create({ data: { messageId, privyUserId, emoji } })
    } catch (err) {
      if (!isUnique(err)) throw err
    }
  }

  async report(messageId: bigint, privyUserId: string) {
    try {
      await this.prisma.clubMessageReport.create({ data: { messageId, privyUserId } })
    } catch (err) {
      if (!isUnique(err)) throw err
    }
    return this.prisma.clubMessageReport.count({ where: { messageId } })
  }

  async eventToken(campaignId: string, rotate: boolean) {
    if (!rotate) {
      const existing = await this.prisma.eventCode.findUnique({ where: { campaignId } })
      if (existing) return existing.token
    }
    const token = newEventToken()
    await this.prisma.eventCode.upsert({ where: { campaignId }, create: { campaignId, token }, update: { token, createdAt: new Date() } })
    return token
  }
  async campaignForEventToken(token: string) {
    return (await this.prisma.eventCode.findUnique({ where: { token } }))?.campaignId ?? null
  }
  async checkIn(campaignId: string, privyUserId: string) {
    try {
      await this.prisma.eventCheckin.create({ data: { campaignId, privyUserId } })
      return true
    } catch (err) {
      if (isUnique(err)) return false
      throw err
    }
  }
  async hasCheckedIn(campaignId: string, privyUserId: string) {
    return Boolean(await this.prisma.eventCheckin.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } }))
  }
  async checkinsOf(privyUserId: string) {
    return (await this.prisma.eventCheckin.findMany({ where: { privyUserId }, orderBy: { createdAt: 'desc' }, take: 200 })).map((c) => ({ campaignId: c.campaignId, at: c.createdAt }))
  }
  async checkinsFor(campaignIds: string[]) {
    if (!campaignIds.length) return []
    return (await this.prisma.eventCheckin.findMany({ where: { campaignId: { in: campaignIds } }, take: 5000 })).map((c) => ({ campaignId: c.campaignId, privyUserId: c.privyUserId, at: c.createdAt }))
  }
  async campaignIdsForClub(clubId: string, limit: number) {
    return (await this.prisma.campaign.findMany({ where: { clubId }, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true } })).map((c) => c.id)
  }

  async createSquad(s: Omit<StoredSquad, 'createdAt'>, captainWallet: string | null) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const squad = await tx.squad.create({ data: s })
        await tx.squadMember.create({ data: { squadId: s.id, campaignId: s.campaignId, privyUserId: s.captainPrivyUserId, publicWallet: captainWallet } })
        return squad
      })
    } catch (err) {
      if (isUnique(err)) throw new AlreadyInSquadError()
      throw err
    }
  }
  async findSquad(id: string) {
    return isUuid(id) ? this.prisma.squad.findUnique({ where: { id } }) : null
  }
  async findSquadByCode(code: string) {
    return this.prisma.squad.findUnique({ where: { code } })
  }
  async squadForUser(campaignId: string, privyUserId: string) {
    const m = await this.prisma.squadMember.findUnique({ where: { campaignId_privyUserId: { campaignId, privyUserId } } })
    return m ? this.prisma.squad.findUnique({ where: { id: m.squadId } }) : null
  }
  async squadsOf(privyUserId: string) {
    const ids = (await this.prisma.squadMember.findMany({ where: { privyUserId }, select: { squadId: true }, take: 200 })).map((m) => m.squadId)
    return ids.length ? this.prisma.squad.findMany({ where: { id: { in: ids } } }) : []
  }
  async squadsFor(campaignId: string, limit: number) {
    return this.prisma.squad.findMany({ where: { campaignId }, orderBy: { createdAt: 'desc' }, take: limit })
  }
  async squadMembers(squadIds: string[]) {
    return squadIds.length ? this.prisma.squadMember.findMany({ where: { squadId: { in: squadIds } }, orderBy: { joinedAt: 'asc' } }) : []
  }
  async joinSquad(squad: StoredSquad, privyUserId: string, publicWallet: string | null) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise joins to this squad so two people cannot both take the last seat.
        await tx.$executeRaw`SELECT 1 FROM "Squad" WHERE "id" = ${squad.id}::uuid FOR UPDATE`
        const count = await tx.squadMember.count({ where: { squadId: squad.id } })
        if (count >= squad.maxSize) return 'FULL' as const
        await tx.squadMember.create({ data: { squadId: squad.id, campaignId: squad.campaignId, privyUserId, publicWallet } })
        return 'OK' as const
      })
    } catch (err) {
      if (isUnique(err)) return 'ALREADY_IN_SQUAD' as const
      throw err
    }
  }
  async leaveSquad(squad: StoredSquad, privyUserId: string) {
    if (squad.captainPrivyUserId === privyUserId) {
      await this.prisma.$transaction([this.prisma.squadMember.deleteMany({ where: { squadId: squad.id } }), this.prisma.squad.delete({ where: { id: squad.id } })])
    } else {
      await this.prisma.squadMember.deleteMany({ where: { squadId: squad.id, privyUserId } })
    }
  }
}

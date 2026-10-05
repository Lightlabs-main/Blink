import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository, type NewCampaign } from './campaign-repo.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { InMemoryProfileStore } from './profile.ts'
import { QuestService } from './quest-service.ts'
import { InMemorySocialStore } from './social-store.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async () => [],
  getEmbeddedSolanaWallets: async (u) => [`Wa11et${u.replace(/\W/g, '')}xxxxxxxxxxxxxxxxxxxx`],
}
const as = (u: string) => ({ authorization: `Bearer ${u}` })

let campaigns: InMemoryCampaignRepository
let claims: InMemoryClaimRepository
let social: InMemorySocialStore
let app: FastifyInstance

beforeEach(() => {
  campaigns = new InMemoryCampaignRepository()
  claims = new InMemoryClaimRepository(campaigns)
  const rows: { id: string; clubId: string | null; createdAt: Date }[] = []
  social = new InMemorySocialStore(() => rows)
  const profiles = new InMemoryProfileStore()
  const create = campaigns.create.bind(campaigns)
  campaigns.create = async (c) => {
    const s = await create(c)
    rows.push({ id: s.id, clubId: s.clubId ?? null, createdAt: s.createdAt })
    return s
  }
  app = buildApp({ env, auth, campaigns, claims, profiles, social, rpc: {} as Rpc<GetAccountInfoApi>, assets: [], quests: new QuestService({ auth, claims, social }) })
})

async function liveCampaign(overrides: Partial<NewCampaign> = {}) {
  const id = crypto.randomUUID()
  await campaigns.create({
    id, type: 'TAP_RUSH', cluster: 'devnet', creatorPrivyUserId: 'did:privy:creator', creatorWallet: '11111111111111111111111111111112',
    mint: SUPPORTED_XSTOCKS[0]!.mint, xstockSymbol: 'NVDAx', campaignSeed: 'seed', campaignTokenAccount: id, allowanceRaw: 100n, rewardPerClaimRaw: 10n,
    tapRush: { goal: 100, seconds: 30 }, ...overrides,
  })
  await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
  await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
  return (await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE'))!
}

const post = (u: string, url: string, payload?: object) => app.inject({ method: 'POST', url, headers: as(u), payload: payload ?? {} })
const get = (u: string, url: string) => app.inject({ method: 'GET', url, headers: as(u) })

describe('clubs (D-40)', () => {
  it('creates, lists with real member counts, joins once and leaves', async () => {
    expect((await get('alice', '/v1/clubs')).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/v1/clubs' })).statusCode).toBe(401)

    const created = await post('alice', '/v1/clubs', { name: 'NVDA Club', description: 'Community around NVDAx, news and drops.', category: 'ASSET', tags: ['nvda', 'tap-rush'] })
    expect(created.statusCode).toBe(201)
    expect(created.json().club).toMatchObject({ slug: 'nvda-club', memberCount: 1, joined: true, role: 'OWNER' })
    expect((await post('bob', '/v1/clubs', { name: 'NVDA Club', description: 'Another club with the same name.', category: 'ASSET' })).json().error.code).toBe('SLUG_TAKEN')
    expect((await post('bob', '/v1/clubs', { name: 'Official Apple', description: 'Pretends to be official.', category: 'ASSET' })).json().error.code).toBe('INVALID_NAME')

    expect((await post('bob', '/v1/clubs/nvda-club/join')).json().club).toMatchObject({ memberCount: 2, joined: true, role: 'MEMBER' })
    expect((await post('bob', '/v1/clubs/nvda-club/join')).json().error.code).toBe('ALREADY_MEMBER')
    expect((await get('bob', '/v1/clubs?tab=joined')).json().clubs.map((c: { slug: string }) => c.slug)).toEqual(['nvda-club'])
    expect((await get('carol', '/v1/clubs?q=nvd')).json().clubs[0]).toMatchObject({ memberCount: 2, joined: false })

    expect((await post('alice', '/v1/clubs/nvda-club/leave')).json().error.code).toBe('OWNER_CANNOT_LEAVE')
    expect((await post('bob', '/v1/clubs/nvda-club/leave')).json().club).toMatchObject({ memberCount: 1, joined: false })

    // Club joins show up in history as offchain records.
    const history = (await get('alice', '/v1/me/history')).json().items
    expect(history[0]).toMatchObject({ kind: 'CLUB_JOINED', title: 'NVDA Club', clubSlug: 'nvda-club', signature: null })
  })

  it('limits club creation per day and hides private clubs without the invite', async () => {
    for (let i = 0; i < 3; i++) expect((await post('dave', '/v1/clubs', { name: `Dave club ${i}`, description: 'A club for testing limits.', category: 'COMMUNITY' })).statusCode).toBe(201)
    expect((await post('dave', '/v1/clubs', { name: 'Dave club 4', description: 'A club for testing limits.', category: 'COMMUNITY' })).json().error.code).toBe('RATE_LIMITED')

    const priv = (await post('erin', '/v1/clubs', { name: 'Builders', description: 'Invite-only builder group.', category: 'COMMUNITY', visibility: 'PRIVATE' })).json().club
    expect((await get('frank', '/v1/clubs')).json().clubs.some((c: { slug: string }) => c.slug === priv.slug)).toBe(false)
    expect((await get('frank', `/v1/clubs/${priv.slug}`)).statusCode).toBe(404)
    const invite = (await get('erin', `/v1/clubs/${priv.slug}`)).json().club.inviteCode
    expect(invite).toMatch(/^[A-Z0-9]{8}$/)
    expect((await post('frank', `/v1/clubs/${priv.slug}/join`)).statusCode).toBe(404)
    expect((await post('frank', `/v1/clubs/${priv.slug}/join`, { invite })).json().club.joined).toBe(true)
    expect((await get('frank', `/v1/clubs/${priv.slug}`)).json().club.inviteCode).toBe(invite)
  })
})

describe('club chat (D-40)', () => {
  it('members post, reply, react and delete; non-members read public chat only', async () => {
    await post('alice', '/v1/clubs', { name: 'ORE Miners', description: 'People who mine ORE together.', category: 'ECOSYSTEM' })
    const url = '/v1/clubs/ore-miners/messages'
    expect((await post('bob', url, { body: 'hi' })).json().error.code).toBe('NOT_A_MEMBER')
    await post('bob', '/v1/clubs/ore-miners/join')

    const first = (await post('alice', url, { body: '<b>gm</b> #ore' })).json().message
    expect(first.body).toBe('<b>gm</b> #ore') // stored and returned as plain text; the app never renders HTML
    expect((await post('bob', url, { body: 'bad\u0007bell' })).statusCode).toBe(400)
    expect((await post('bob', url, { body: 'x'.repeat(501) })).statusCode).toBe(400)
    const reply = (await post('bob', url, { body: 'gm!', replyTo: first.id })).json().message
    expect(reply.replyTo).toMatchObject({ id: first.id, body: '<b>gm</b> #ore' })
    expect(reply.author.label).toMatch(/…/)

    const reacted = (await post('bob', `${url}/${first.id}/reactions`, { emoji: '🔥' })).json().message
    expect(reacted.reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }])
    expect((await post('bob', `${url}/${first.id}/reactions`, { emoji: '🍕' })).statusCode).toBe(400)
    expect((await post('bob', `${url}/${first.id}/reactions`, { emoji: '🔥' })).json().message.reactions).toEqual([])

    // Pagination: newest page, then only newer ones.
    const page = (await get('carol', url)).json().messages
    expect(page.map((m: { id: string }) => m.id)).toEqual([first.id, reply.id])
    expect((await get('carol', `${url}?after=${first.id}`)).json().messages).toHaveLength(1)

    // Only the author or the owner/mods can delete.
    expect((await app.inject({ method: 'DELETE', url: `${url}/${first.id}`, headers: as('bob') })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `${url}/${reply.id}`, headers: as('alice') })).statusCode).toBe(200)
    expect((await get('bob', url)).json().messages[1]).toMatchObject({ deleted: true, body: '' })

    // Reports: not your own; three different members hide a message.
    const spam = (await post('alice', url, { body: 'spam' })).json().message
    expect((await post('alice', `${url}/${spam.id}/report`)).json().error.code).toBe('OWN_MESSAGE')
    expect((await post('carol', `${url}/${spam.id}/report`)).json().error.code).toBe('NOT_A_MEMBER')
    for (const u of ['carol', 'dave']) await post(u, '/v1/clubs/ore-miners/join')
    expect((await post('bob', `${url}/${spam.id}/report`)).json()).toEqual({ reported: true, hidden: false })
    expect((await post('bob', `${url}/${spam.id}/report`)).json()).toEqual({ reported: true, hidden: false })
    expect((await post('carol', `${url}/${spam.id}/report`)).json().hidden).toBe(false)
    expect((await post('dave', `${url}/${spam.id}/report`)).json().hidden).toBe(true)
    expect((await get('bob', `${url}?after=${reply.id}`)).json().messages[0]).toMatchObject({ id: spam.id, deleted: true })
  })

  it('rate-limits fast senders', async () => {
    await post('alice', '/v1/clubs', { name: 'Seeker Club', description: 'Seeker owners and fans.', category: 'ECOSYSTEM' })
    const codes = []
    for (let i = 0; i < 21; i++) codes.push((await post('alice', '/v1/clubs/seeker-club/messages', { body: `m${i}` })).statusCode)
    expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true)
    expect(codes[20]).toBe(429)
  })
})

describe('club drops, event check-in and leaderboard (D-40)', () => {
  it('only members post drops in a club; a QR check-in passes the quest once', async () => {
    const club = (await post('alice', '/v1/clubs', { name: 'SKR Club', description: 'SKR holders and stakers.', category: 'ECOSYSTEM' })).json().club
    const quest = { eligibility: [{ mode: 'ALL', conditions: [{ verifier: 'CLUB_MEMBER' }] }], actions: [{ mode: 'ALL', conditions: [{ verifier: 'QR_CHECKIN' }] }] }
    // Club-member requirement needs the club; posting in a club needs membership (checked before any chain work).
    const body = { type: 'VERIFIED_QUEST', mint: SUPPORTED_XSTOCKS[0]!.mint, allowanceRaw: '100', rewardPerClaimRaw: '10', requirements: quest }
    expect((await post('bob', '/v1/campaigns', body)).json().error.message).toMatch(/club/)
    expect((await post('bob', '/v1/campaigns', { ...body, clubId: club.id })).json().error.code).toBe('NOT_A_MEMBER')

    const c = await liveCampaign({ type: 'VERIFIED_QUEST', tapRush: null, requirements: quest as never, clubId: club.id })
    expect((await get('bob', `/v1/campaigns/${c.id}/event-code`)).statusCode).toBe(404)
    const event = (await get('did:privy:creator'.replace('did:privy:', ''), `/v1/campaigns/${c.id}/event-code`)).json().event
    expect(event.link).toBe(`https://blinksol.site/e/${event.token}`)

    expect((await post('bob', '/v1/checkin', { token: 'x'.repeat(30) })).json().error.code).toBe('INVALID_CODE')
    expect((await post('bob', '/v1/checkin', { token: 'bad' })).json().error.code).toBe('INVALID_CODE')
    expect((await post('bob', '/v1/checkin', { token: event.token })).json().checkin).toEqual({ campaignId: c.id, alreadyCheckedIn: false })
    expect((await post('bob', '/v1/checkin', { token: event.token })).json().checkin.alreadyCheckedIn).toBe(true)

    // Not a member yet: the club condition fails, the check-in passes.
    let ev = (await post('bob', `/v1/campaigns/${c.id}/verify`)).json().evaluation
    expect(ev.eligibility[0].results[0]).toMatchObject({ verifier: 'CLUB_MEMBER', status: 'FAILED' })
    expect(ev.actions[0].results[0]).toMatchObject({ verifier: 'QR_CHECKIN', status: 'PASSED' })
    await post('bob', `/v1/clubs/${club.slug}/join`)
    ev = (await post('bob', `/v1/campaigns/${c.id}/verify`)).json().evaluation
    expect(ev.qualified).toBe(true)

    // Rotating the code retires the old QR.
    const rotated = (await post('creator', `/v1/campaigns/${c.id}/event-code`)).json().event
    expect(rotated.token).not.toBe(event.token)
    expect((await post('carol', '/v1/checkin', { token: event.token })).json().error.code).toBe('INVALID_CODE')

    // Club detail lists the drop; the leaderboard counts Bob's verification and check-in (5 + 5), members only.
    expect((await get('bob', `/v1/clubs/${club.slug}`)).json().club.campaigns.map((x: { id: string }) => x.id)).toEqual([c.id])
    const board = (await get('bob', `/v1/clubs/${club.slug}/leaderboard`)).json()
    expect(board.leaderboard).toEqual([expect.objectContaining({ rank: 1, points: 10, qualified: 1, checkins: 1, rewards: 0 })])

    // History and passport show the check-in.
    expect((await get('bob', '/v1/me/history')).json().items.some((i: { kind: string }) => i.kind === 'CHECKIN')).toBe(true)
    const passport = (await get('bob', '/v1/me/passport')).json().passport
    expect(passport).toMatchObject({ checkins: 1, clubs: 1, rewards: 0, squadWins: 0, level: 'EXPLORER' })
    expect(passport.number).toMatch(/^BLK-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    expect((await get('bob', '/v1/me/passport')).json().passport.number).toBe(passport.number)
    expect((await get('carol', '/v1/me/passport')).json().passport).toMatchObject({ level: 'NEWCOMER', memberSince: null })
    expect(passport.badges.map((b: { title: string }) => b.title)).toEqual(expect.arrayContaining(['Event check-in', 'First club']))
  })
})

describe('squads (D-40)', () => {
  it('creates, joins once, caps the size and sums server-recorded taps', async () => {
    const c = await liveCampaign()
    const url = `/v1/campaigns/${c.id}/squads`
    expect((await post('creator', url, { name: 'Alpha' })).json().error.code).toBe('OWN_CAMPAIGN')
    const squad = (await post('alice', url, { name: 'Alpha' })).json().squad
    expect(squad).toMatchObject({ name: 'Alpha', maxSize: 4, target: 400, combinedTaps: 0, mine: true })
    expect((await post('alice', url, { name: 'Beta' })).json().error.code).toBe('ALREADY_IN_SQUAD')
    expect((await post('bob', '/v1/squads/join', { code: 'ZZZZZZ' })).json().error.code).toBe('INVALID_CODE')
    for (const u of ['bob', 'carol', 'dave']) expect((await post(u, '/v1/squads/join', { code: squad.code })).statusCode).toBe(200)
    expect((await post('erin', '/v1/squads/join', { code: squad.code })).json().error.code).toBe('SQUAD_FULL')
    expect((await post('bob', '/v1/squads/join', { code: squad.code })).json().error.code).toBe('ALREADY_IN_SQUAD')

    // Taps come only from finished, accepted server sessions — never from the client.
    for (const [u, taps] of [['alice', 120], ['bob', 110], ['carol', 90], ['dave', 85]] as const) {
      const s = await claims.startTapSession({ campaignId: c.id, privyUserId: `did:privy:${u}`, goal: 100, seconds: 30 })
      await claims.finishTapSession(s.id, { taps, qualified: taps >= 100, finishedAt: new Date(), rejectReason: null })
    }
    const mine = (await get('carol', url)).json().mine
    expect(mine).toMatchObject({ combinedTaps: 405, target: 400, complete: true })
    expect((await get('carol', '/v1/me/passport')).json().passport.squadWins).toBe(1)

    // A captain leaving disbands the squad.
    expect((await post('alice', `/v1/squads/${squad.id}/leave`)).json()).toEqual({ ok: true, disbanded: true })
    expect((await get('bob', url)).json().mine).toBeNull()
  })
})

describe('club join rules and members-only drops (D-41)', () => {
  it('checks custom SKR / Seeker rules on join and lets only the owner change them', async () => {
    const staked = new Map<string, bigint>()
    const chain = {
      skrBalance: async () => 0n,
      skrStaked: async (w: string) => staked.get(w) ?? 0n,
      oreBalance: async () => 0n,
      oreStaked: async () => 0n,
      oreMinerRound: async () => 0n,
      oreBoardRound: async () => 1n,
    }
    const rows: { id: string; clubId: string | null; createdAt: Date }[] = []
    const store = new InMemorySocialStore(() => rows)
    const a = buildApp({ env, auth, campaigns, claims, social: store, rpc: {} as Rpc<GetAccountInfoApi>, assets: [], quests: new QuestService({ auth, claims, social: store, chain }) })
    const p = (u: string, url: string, payload: object = {}) => a.inject({ method: 'POST', url, headers: as(u), payload })
    const rules = [{ mode: 'ALL', conditions: [{ verifier: 'SKR_STAKED', minRaw: '500000000' }] }]

    expect((await p('alice', '/v1/clubs', { name: 'Tap club', description: 'Rules must be identity checks.', category: 'COMMUNITY', rules: [{ mode: 'ALL', conditions: [{ verifier: 'TAP_RUSH' }] }] })).statusCode).toBe(400)
    const club = (await p('alice', '/v1/clubs', { name: 'SKR Stakers', description: 'Stake at least 500 SKR to join.', category: 'ECOSYSTEM', rules })).json().club
    expect(club.rules).toEqual(rules)

    const refused = await p('bob', `/v1/clubs/${club.slug}/join`)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.code).toBe('CLUB_RULES_NOT_MET')
    expect(refused.json().evaluation.eligibility[0].results[0]).toMatchObject({ verifier: 'SKR_STAKED', status: 'FAILED', actualRaw: '0', requiredRaw: '500000000' })

    staked.set((await auth.getEmbeddedSolanaWallets('did:privy:bob'))[0]!, 600_000_000n)
    expect((await p('bob', `/v1/clubs/${club.slug}/join`)).json().club.joined).toBe(true)

    // Only the owner edits rules; a Seeker-or-stake rule is fine; members stay.
    const put = (u: string, body: object) => a.inject({ method: 'PUT', url: `/v1/clubs/${club.slug}/rules`, headers: as(u), payload: body })
    expect((await put('bob', { rules: [] })).statusCode).toBe(403)
    const anyRule = [{ mode: 'ANY', conditions: [{ verifier: 'SEEKER_SGT' }, { verifier: 'ORE_STAKED', minRaw: '1' }] }]
    expect((await put('alice', { rules: anyRule })).json().club).toMatchObject({ rules: anyRule, memberCount: 2 })
    await a.close()
  })

  it('keeps any kind of members-only drop to club members', async () => {
    const club = (await post('alice', '/v1/clubs', { name: 'Members Drop Club', description: 'Drops for members only.', category: 'COMMUNITY' })).json().club
    const body = { type: 'TAP_RUSH', mint: SUPPORTED_XSTOCKS[0]!.mint, allowanceRaw: '100', rewardPerClaimRaw: '10', membersOnly: true }
    expect((await post('alice', '/v1/campaigns', body)).json().error.message).toMatch(/club/)
    const c = await liveCampaign({ clubId: club.id, membersOnly: true })
    expect((await get('bob', `/v1/campaigns/${c.id}`)).json().campaign).toMatchObject({ clubId: club.id, membersOnly: true })
    expect((await post('bob', `/v1/campaigns/${c.id}/tap-rush/start`)).json().error.code).toBe('NOT_A_MEMBER')
    expect((await post('bob', `/v1/campaigns/${c.id}/claim`)).json().error.code).toBe('NOT_A_MEMBER')
    await post('bob', `/v1/clubs/${club.slug}/join`)
    // A member gets past the club gate (and then meets the normal checks: no payouts configured in this test).
    expect((await post('bob', `/v1/campaigns/${c.id}/tap-rush/start`)).json().error.code).not.toBe('NOT_A_MEMBER')
  })
})

describe('voice notes and admin controls (D-43)', () => {
  /** A tiny MP4/M4A-shaped file: size + 'ftyp' + brand, padded. */
  const m4a = (n = 400) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(n)]).toString('base64')

  it('posts, serves and deletes voice notes; refuses non-audio', async () => {
    const club = (await post('alice', '/v1/clubs', { name: 'Voice Club', description: 'Talk instead of typing.', category: 'COMMUNITY' })).json().club
    const url = `/v1/clubs/${club.slug}/voice`
    expect((await post('bob', url, { audio: m4a(), durationMs: 3000 })).json().error.code).toBe('NOT_A_MEMBER')
    await post('bob', `/v1/clubs/${club.slug}/join`)
    expect((await post('bob', url, { audio: Buffer.alloc(300).toString('base64'), durationMs: 3000 })).json().error.code).toBe('INVALID_AUDIO')
    expect((await post('bob', url, { audio: m4a(), durationMs: 61_000 })).statusCode).toBe(400)
    const res = await post('bob', url, { audio: m4a(), durationMs: 4200 })
    expect(res.statusCode).toBe(201)
    const msg = res.json().message
    expect(msg).toMatchObject({ kind: 'VOICE', body: '', voice: { durationMs: 4200 } })
    expect(msg.voice.url).toMatch(/^\/v1\/voice\/[A-Za-z0-9_-]{22}$/)
    const audio = await app.inject({ method: 'GET', url: msg.voice.url })
    expect(audio.statusCode).toBe(200)
    expect(audio.headers['content-type']).toBe('audio/mp4')
    // A text reply to a voice note shows a voice label.
    expect((await post('alice', `/v1/clubs/${club.slug}/messages`, { body: 'nice', replyTo: msg.id })).json().message.replyTo.body).toBe('🎤 Voice note')
    await app.inject({ method: 'DELETE', url: `/v1/clubs/${club.slug}/messages/${msg.id}`, headers: as('bob') })
    expect((await app.inject({ method: 'GET', url: msg.voice.url })).statusCode).toBe(404)
  })

  it('lets the owner make admins, admins mute, remove and pin, and close the chat to admins', async () => {
    const club = (await post('alice', '/v1/clubs', { name: 'Crew Club', description: 'Testing admin controls.', category: 'COMMUNITY' })).json().club
    const base = `/v1/clubs/${club.slug}`
    for (const u of ['bob', 'carol', 'dave']) await post(u, `${base}/join`)
    const list = (await get('bob', `${base}/members`)).json()
    expect(list.removed).toBeNull()
    expect(list.members.map((m: { role: string }) => m.role)).toEqual(['OWNER', 'MEMBER', 'MEMBER', 'MEMBER'])
    expect(list.members[0].id).toMatch(/^[0-9a-f]{16}$/)
    const ref = async (u: string) => (await get(u, `${base}/members`)).json().members.find((m: { me: boolean }) => m.me).id as string
    const [bobId, carolId, daveId, aliceId] = await Promise.all(['bob', 'carol', 'dave', 'alice'].map(ref))

    // Only the owner makes admins; admins can't act on the owner or each other.
    expect((await post('bob', `${base}/members/${carolId}/role`, { role: 'MOD' })).json().error.code).toBe('FORBIDDEN')
    expect((await post('alice', `${base}/members/${bobId}/role`, { role: 'MOD' })).json().role).toBe('MOD')
    expect((await post('bob', `${base}/members/${aliceId}/mute`, { minutes: 60 })).json().error.code).toBe('FORBIDDEN')
    await post('alice', `${base}/members/${carolId}/role`, { role: 'MOD' })
    expect((await post('bob', `${base}/members/${carolId}/mute`, { minutes: 60 })).json().error.code).toBe('FORBIDDEN')
    await post('alice', `${base}/members/${carolId}/role`, { role: 'MEMBER' })

    // Mute: read-only until unmuted (no posts, reactions or gifts).
    expect((await post('bob', `${base}/members/${daveId}/mute`, { minutes: 7 })).statusCode).toBe(400)
    expect((await post('bob', `${base}/members/${daveId}/mute`, { minutes: 60 })).json().mutedUntil).toBeTruthy()
    expect((await post('dave', `${base}/messages`, { body: 'hi' })).json().error.code).toBe('MUTED')
    expect((await get('dave', base)).json().club.myMutedUntil).toBeTruthy()
    await post('bob', `${base}/members/${daveId}/mute`, { minutes: 0 })
    expect((await post('dave', `${base}/messages`, { body: 'hi' })).statusCode).toBe(201)

    // Admins-only chat.
    expect((await app.inject({ method: 'PUT', url: `${base}/settings`, headers: as('carol'), payload: { adminsOnly: true } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: `${base}/settings`, headers: as('bob'), payload: { adminsOnly: true } })).json().adminsOnly).toBe(true)
    expect((await post('carol', `${base}/messages`, { body: 'hello?' })).json().error.code).toBe('ADMINS_ONLY')
    const announcement = (await post('bob', `${base}/messages`, { body: 'Drop at 6pm' })).json().message
    expect((await get('carol', base)).json().club.adminsOnly).toBe(true)

    // Pin.
    expect((await post('carol', `${base}/messages/${announcement.id}/pin`)).json().error.code).toBe('FORBIDDEN')
    await post('bob', `${base}/messages/${announcement.id}/pin`)
    expect((await get('carol', base)).json().club.pinned).toMatchObject({ id: announcement.id, body: 'Drop at 6pm' })

    // Remove = can't rejoin until restored.
    await post('bob', `${base}/members/${carolId}/remove`)
    expect((await post('carol', `${base}/join`)).json().error.code).toBe('REMOVED')
    const removed = (await get('bob', `${base}/members`)).json().removed
    expect(removed).toHaveLength(1)
    await post('bob', `${base}/removed/${removed[0].id}/restore`)
    expect((await post('carol', `${base}/join`)).json().club.joined).toBe(true)
  })
})

describe('xStock gifts in club chat (D-44)', () => {
  it('gifts through the Send flow, checks the recipient, and posts only confirmed gifts', async () => {
    const enforced = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'enforce' })
    const real = { symbol: 'NVDAx', name: 'NVIDIA xStock', mint: SUPPORTED_XSTOCKS[0]!.mint, decimals: 8, logo: null, isTest: false }
    const prepared: { user: string; to: string; amountRaw: bigint }[] = []
    let confirm = true
    const sendFake = {
      prepare: async (user: string, _ip: string, input: { asset: string; to: string; amountRaw: bigint }) => {
        prepared.push({ user, to: input.to, amountRaw: input.amountRaw })
        return { transaction: 'dHg=', from: 'me', createsRecipientAccount: true }
      },
      submit: async () => ({ signature: `sig${prepared.length}${confirm ? 'c' : 'p'}`, confirmed: confirm }),
    }
    const eligible = new Set(['did:privy:bob'])
    const store = new InMemorySocialStore()
    const notes: { to: string; body: string }[] = []
    const a = buildApp({
      env: enforced, auth, campaigns, claims, social: store, profiles: new InMemoryProfileStore(), rpc: {} as Rpc<GetAccountInfoApi>, assets: [real],
      send: sendFake as never, eligibility: { isEligibleStored: async (u: string) => eligible.has(u) } as never,
      notifier: { notify: async (to: string, m: { body: string }) => void notes.push({ to, body: m.body }) },
    })
    const p = (u: string, url: string, payload: object = {}) => a.inject({ method: 'POST', url, headers: as(u), payload })
    const g = (u: string, url: string) => a.inject({ method: 'GET', url, headers: as(u) })
    const club = (await p('alice', '/v1/clubs', { name: 'Gift Club', description: 'Members gift each other stock.', category: 'COMMUNITY' })).json().club
    const base = `/v1/clubs/${club.slug}`
    for (const u of ['bob', 'carol']) await p(u, `${base}/join`)
    const idOf = async (u: string) => (await g(u, `${base}/members`)).json().members.find((m: { me: boolean }) => m.me).id as string
    const [bobId, carolId, aliceId] = await Promise.all([idOf('bob'), idOf('carol'), idOf('alice')])

    expect((await p('alice', `${base}/gifts/prepare`, { to: aliceId, asset: real.mint, amountRaw: '1000' })).json().error.code).toBe('SELF_GIFT')
    expect((await p('alice', `${base}/gifts/prepare`, { to: carolId, asset: real.mint, amountRaw: '1000' })).json().error.code).toBe('RECIPIENT_NOT_ELIGIBLE')
    expect((await p('alice', `${base}/gifts/prepare`, { to: bobId, asset: '11111111111111111111111111111112', amountRaw: '1000' })).json().error.code).toBe('UNSUPPORTED_ASSET')
    expect((await p('zed', `${base}/gifts/prepare`, { to: bobId, asset: real.mint, amountRaw: '1000' })).json().error.code).toBe('NOT_A_MEMBER')

    // A confirmed gift: prepared to Bob's own Blink wallet (server-resolved), posted in chat, Bob notified.
    const prep = await p('alice', `${base}/gifts/prepare`, { to: bobId, asset: real.mint, amountRaw: '1000000' })
    expect(prep.json().prepared).toEqual({ transaction: 'dHg=', createsRecipientAccount: true })
    expect(prepared.at(-1)).toMatchObject({ user: 'did:privy:alice', to: (await auth.getEmbeddedSolanaWallets('did:privy:bob'))[0], amountRaw: 1_000_000n })
    expect(JSON.stringify(prep.json())).not.toContain('Wa11et')
    const done = (await p('alice', `${base}/gifts/submit`, { signedTransaction: 'x'.repeat(120) })).json()
    expect(done.gift.status).toBe('CONFIRMED')
    expect(done.message).toMatchObject({ kind: 'GIFT', gift: { symbol: 'NVDAx', amountRaw: '1000000', decimals: 8 } })
    expect(notes).toEqual([{ to: 'did:privy:bob', body: expect.stringContaining('NVDAx') }])
    expect((await p('alice', `${base}/gifts/submit`, { signedTransaction: 'x'.repeat(120) })).json().error.code).toBe('EXPIRED')

    // Bob sees it in his history and Passport; messages carry an opaque author id for gifting back.
    expect((await g('bob', '/v1/me/history')).json().items[0]).toMatchObject({ kind: 'GIFT_RECEIVED', amountRaw: '1000000', symbol: 'NVDAx' })
    expect((await g('bob', '/v1/me/passport')).json().passport.badges.map((b: { title: string }) => b.title)).toContain('Gift received')
    expect((await g('bob', `${base}/messages`)).json().messages.at(-1).authorId).toBe(aliceId)

    // Admins-only chat: members can't post but can still gift. Muted members can't do anything but read.
    await a.inject({ method: 'PUT', url: `${base}/settings`, headers: as('alice'), payload: { adminsOnly: true } })
    eligible.add('did:privy:alice')
    expect((await p('carol', `${base}/messages`, { body: 'hi' })).json().error.code).toBe('ADMINS_ONLY')
    await p('alice', `${base}/members/${carolId}/mute`, { minutes: 60 })
    expect((await p('carol', `${base}/gifts/prepare`, { to: aliceId, asset: real.mint, amountRaw: '7' })).json().error.code).toBe('MUTED')
    const lastId = (await g('carol', `${base}/messages`)).json().messages.at(-1).id
    expect((await p('carol', `${base}/messages/${lastId}/reactions`, { emoji: '🔥' })).json().error.code).toBe('MUTED')
    expect((await p('carol', `${base}/messages/${lastId}/report`)).json().error.code).toBe('MUTED')
    expect((await g('carol', `${base}/messages`)).statusCode).toBe(200)
    await p('alice', `${base}/members/${carolId}/mute`, { minutes: 0 })
    expect((await p('carol', `${base}/gifts/prepare`, { to: aliceId, asset: real.mint, amountRaw: '7' })).statusCode).toBe(200)
    expect((await p('carol', `${base}/gifts/submit`, { signedTransaction: 'x'.repeat(120) })).json().message.kind).toBe('GIFT')
    expect(notes).toHaveLength(2)

    // Still confirming: recorded, but nothing appears in chat and nobody is told it arrived.
    confirm = false
    await p('alice', `${base}/gifts/prepare`, { to: bobId, asset: real.mint, amountRaw: '5' })
    const pend = (await p('alice', `${base}/gifts/submit`, { signedTransaction: 'x'.repeat(120) })).json()
    expect(pend).toMatchObject({ gift: { status: 'PENDING' }, message: null })
    expect(notes).toHaveLength(2)
    await a.close()
  })
})

describe('OG marks (D-45)', () => {
  it('checks ORE, Seeker and SKR on mainnet readers, shows them on names, and keeps marks when a read fails', async () => {
    const ogAuth: AuthVerifier = { ...auth, getVerifiedExternalSolanaWallets: async (u) => (u === 'did:privy:olu' ? ['SeekerWa11et1111111111111111111111'] : []) }
    let skrDown = false
    const chain = {
      skrBalance: async () => 0n,
      skrStaked: async () => {
        if (skrDown) throw new Error('rpc 429')
        return 5_000_000n
      },
      oreBalance: async () => 0n,
      oreStaked: async () => 0n,
      oreMinerRound: async (w: string) => (w.includes('olu') ? 42n : 0n),
      oreBoardRound: async () => 50n,
    }
    const seeker = { findSgt: async (w: string) => (w.startsWith('Seeker') ? 'SgtMint111' : null) }
    const profiles = new InMemoryProfileStore()
    const store = new InMemorySocialStore()
    const a = buildApp({ env, auth: ogAuth, campaigns, claims, social: store, profiles, rpc: {} as Rpc<GetAccountInfoApi>, assets: [], quests: new QuestService({ auth: ogAuth, claims, social: store, chain, seeker: seeker as never }) })
    const p = (u: string, url: string, payload: object = {}) => a.inject({ method: 'POST', url, headers: as(u), payload })

    // Olu: mined ORE, owns a Seeker, stakes SKR → all three. Ben: only SKR.
    expect((await p('olu', '/v1/me/og')).json().profile).toMatchObject({ og: ['ORE', 'SEEKER', 'SKR'] })
    expect((await p('ben', '/v1/me/og')).json().profile.og).toEqual(['SKR'])

    // An RPC failure keeps the SKR mark instead of removing it.
    skrDown = true
    const again = (await p('ben', '/v1/me/og')).json()
    expect(again).toMatchObject({ profile: { og: ['SKR'] }, unknown: ['SKR'] })

    // Names carry the marks wherever people are shown (here: chat).
    const club = (await p('olu', '/v1/clubs', { name: 'OG Club', description: 'Miners, stakers, Seekers.', category: 'ECOSYSTEM' })).json().club
    await p('olu', `/v1/clubs/${club.slug}/messages`, { body: 'gm' })
    const msgs = (await a.inject({ method: 'GET', url: `/v1/clubs/${club.slug}/messages`, headers: as('ben') })).json().messages
    expect(msgs[0].author.og).toEqual(['ORE', 'SEEKER', 'SKR'])
    // Rate limit: 3 checks per 10 minutes (Ben has used 2).
    expect((await p('ben', '/v1/me/og')).statusCode).toBe(200)
    expect((await p('ben', '/v1/me/og')).statusCode).toBe(429)
    await a.close()
  })
})

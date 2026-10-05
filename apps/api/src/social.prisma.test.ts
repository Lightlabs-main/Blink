import { randomUUID } from 'node:crypto'

import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import { afterAll, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { createPrismaClient, PrismaCampaignRepository } from './prisma-campaign-repo.ts'
import { PrismaClaimRepository } from './prisma-claim-repo.ts'
import { PrismaProfileStore } from './profile.ts'
import { QuestService } from './quest-service.ts'
import { PrismaSocialStore } from './social-store.ts'

/*
 * D-40 against a real Postgres (the Prisma code paths: groupBy counts, BigInt cursors, the squad seat lock, unique
 * indexes). Runs only when SOCIAL_TEST_DATABASE_URL points at a THROWAWAY, fully migrated database.
 */
const url = process.env.SOCIAL_TEST_DATABASE_URL

describe.skipIf(!url)('social features on Postgres (D-40)', () => {
  const prisma = url ? createPrismaClient(url) : (null as never)
  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it('runs the club, chat, event, squad and passport flows with real queries', async () => {
    const run = randomUUID().slice(0, 8)
    const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
    const auth: AuthVerifier = {
      verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${run}:${token}`, sessionId: 's' }),
      getVerifiedExternalSolanaWallets: async () => [],
      getEmbeddedSolanaWallets: async (u) => [`Wa11et${u.replace(/\W/g, '').slice(-12)}xxxxxxxxxxxxxxxxxx`],
    }
    const campaigns = new PrismaCampaignRepository(prisma)
    const claims = new PrismaClaimRepository(prisma)
    const social = new PrismaSocialStore(prisma)
    const app = buildApp({ env, auth, campaigns, claims, social, profiles: new PrismaProfileStore(prisma), rpc: {} as Rpc<GetAccountInfoApi>, assets: [], quests: new QuestService({ auth, claims, social }) })
    const h = (u: string) => ({ authorization: `Bearer ${u}` })
    const post = (u: string, path: string, payload: object = {}) => app.inject({ method: 'POST', url: path, headers: h(u), payload })
    const get = (u: string, path: string) => app.inject({ method: 'GET', url: path, headers: h(u) })

    // Clubs: create, duplicate slug, join once, counts by groupBy.
    const club = (await post('alice', '/v1/clubs', { name: `Club ${run}`, description: 'Postgres test club, safe to delete.', category: 'COMMUNITY', tags: ['test'] })).json().club
    expect(club).toMatchObject({ memberCount: 1, role: 'OWNER' })
    expect((await post('bob', '/v1/clubs', { name: `Club ${run}`, description: 'Same name again for slug test.', category: 'COMMUNITY' })).json().error.code).toBe('SLUG_TAKEN')
    for (const u of ['bob', 'carol', 'dave', 'erin']) expect((await post(u, `/v1/clubs/${club.slug}/join`)).statusCode).toBe(200)
    expect((await post('bob', `/v1/clubs/${club.slug}/join`)).json().error.code).toBe('ALREADY_MEMBER')
    expect((await get('zed', `/v1/clubs?q=${run}`)).json().clubs[0]).toMatchObject({ slug: club.slug, memberCount: 5 })

    // Chat: BigInt ids as cursors, replies, reactions toggle, reports hide.
    const m1 = (await post('alice', `/v1/clubs/${club.slug}/messages`, { body: 'gm #test' })).json().message
    const m2 = (await post('bob', `/v1/clubs/${club.slug}/messages`, { body: 'gm', replyTo: m1.id })).json().message
    expect(m2.replyTo.id).toBe(m1.id)
    expect((await get('carol', `/v1/clubs/${club.slug}/messages?after=${m1.id}`)).json().messages.map((m: { id: string }) => m.id)).toEqual([m2.id])
    expect((await get('carol', `/v1/clubs/${club.slug}/messages?before=${m2.id}`)).json().messages.map((m: { id: string }) => m.id)).toEqual([m1.id])
    expect((await post('bob', `/v1/clubs/${club.slug}/messages/${m1.id}/reactions`, { emoji: '🔥' })).json().message.reactions).toEqual([{ emoji: '🔥', count: 1, mine: true }])
    expect((await post('bob', `/v1/clubs/${club.slug}/messages/${m1.id}/reactions`, { emoji: '🔥' })).json().message.reactions).toEqual([])
    for (const u of ['carol', 'dave']) expect((await post(u, `/v1/clubs/${club.slug}/messages/${m2.id}/report`)).json().hidden).toBe(false)
    expect((await post('erin', `/v1/clubs/${club.slug}/messages/${m2.id}/report`)).json().hidden).toBe(true)

    // A Tap Rush drop in the club with a QR check-in (created through the repository: no chain access needed).
    const id = randomUUID()
    await campaigns.create({
      id, type: 'VERIFIED_QUEST', cluster: 'devnet', creatorPrivyUserId: `did:privy:${run}:alice`, creatorWallet: '11111111111111111111111111111112',
      mint: SUPPORTED_XSTOCKS[0]!.mint, xstockSymbol: 'NVDAx', campaignSeed: run, campaignTokenAccount: `acct-${run}`, allowanceRaw: 100n, rewardPerClaimRaw: 10n,
      tapRush: { goal: 100, seconds: 30 }, clubId: club.id,
      requirements: { eligibility: [{ mode: 'ALL', conditions: [{ verifier: 'CLUB_MEMBER' }] }], actions: [{ mode: 'ALL', conditions: [{ verifier: 'TAP_RUSH' }, { verifier: 'QR_CHECKIN' }] }] },
    })
    await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
    expect((await get('bob', `/v1/campaigns/${id}`)).json().campaign.clubId).toBe(club.id)

    const event = (await get('alice', `/v1/campaigns/${id}/event-code`)).json().event
    expect((await get('alice', `/v1/campaigns/${id}/event-code`)).json().event.token).toBe(event.token)
    expect((await post('bob', '/v1/checkin', { token: event.token })).json().checkin.alreadyCheckedIn).toBe(false)
    expect((await post('bob', '/v1/checkin', { token: event.token })).json().checkin.alreadyCheckedIn).toBe(true)

    // Squads: five people race for four seats; the row lock lets exactly three join the captain.
    const squad = (await post('bob', `/v1/campaigns/${id}/squads`, { name: 'Alpha' })).json().squad
    const joins = await Promise.all(['carol', 'dave', 'erin', 'frank', 'gina'].map((u) => post(u, '/v1/squads/join', { code: squad.code })))
    expect(joins.filter((r) => r.statusCode === 200)).toHaveLength(3)
    expect(joins.filter((r) => r.json().error?.code === 'SQUAD_FULL')).toHaveLength(2)
    for (const [u, taps] of [['bob', 120], ['carol', 100], ['dave', 95], ['erin', 90]] as const) {
      const s = await claims.startTapSession({ campaignId: id, privyUserId: `did:privy:${run}:${u}`, goal: 100, seconds: 30 })
      await claims.finishTapSession(s.id, { taps, qualified: taps >= 100, finishedAt: new Date(), rejectReason: null })
    }
    expect((await get('dave', `/v1/campaigns/${id}/squads`)).json().mine).toMatchObject({ combinedTaps: 405, target: 400, complete: true })

    // Quest: Bob is a member, checked in and won a round.
    expect((await post('bob', `/v1/campaigns/${id}/verify`)).json().evaluation.qualified).toBe(true)

    // Leaderboard, passport, history.
    const board = (await get('bob', `/v1/clubs/${club.slug}/leaderboard?period=week`)).json().leaderboard
    expect(board[0]).toMatchObject({ rank: 1, qualified: 1, checkins: 1, points: 10 })
    expect((await get('bob', '/v1/me/passport')).json().passport).toMatchObject({ checkins: 1, clubs: 1, squadWins: 1 })
    const kinds = (await get('bob', '/v1/me/history')).json().items.map((i: { kind: string }) => i.kind)
    expect(kinds).toEqual(expect.arrayContaining(['CHECKIN', 'CLUB_JOINED']))

    // D-41: rules are stored as JSON, read back, cleared (DbNull) and enforced on join (no chain here → can't pass).
    const rules = [{ mode: 'ALL', conditions: [{ verifier: 'SKR_STAKED', minRaw: '500000000' }] }]
    const gated = (await post('alice', '/v1/clubs', { name: `Gated ${run}`, description: 'Stakers only, Postgres test.', category: 'ECOSYSTEM', rules })).json().club
    expect((await get('bob', `/v1/clubs/${gated.slug}`)).json().club.rules).toEqual(rules)
    expect((await post('bob', `/v1/clubs/${gated.slug}/join`)).json().error.code).toBe('CLUB_RULES_NOT_MET')
    expect((await app.inject({ method: 'PUT', url: `/v1/clubs/${gated.slug}/rules`, headers: h('alice'), payload: { rules: [] } })).json().club.rules).toEqual([])
    expect((await post('bob', `/v1/clubs/${gated.slug}/join`)).json().club.joined).toBe(true)

    // D-41: members-only flag round-trips and blocks non-members.
    const mo = randomUUID()
    await campaigns.create({
      id: mo, type: 'TAP_RUSH', cluster: 'devnet', creatorPrivyUserId: `did:privy:${run}:alice`, creatorWallet: '11111111111111111111111111111112',
      mint: SUPPORTED_XSTOCKS[0]!.mint, xstockSymbol: 'NVDAx', campaignSeed: `m${run}`, campaignTokenAccount: `acct-m-${run}`, allowanceRaw: 100n, rewardPerClaimRaw: 10n,
      tapRush: { goal: 100, seconds: 30 }, clubId: gated.id, membersOnly: true,
    })
    await campaigns.transitionStatus(mo, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(mo, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(mo, 'AWAITING_DELEGATION', 'LIVE')
    expect((await get('zed', `/v1/campaigns/${mo}`)).json().campaign.membersOnly).toBe(true)
    expect((await post('zed', `/v1/campaigns/${mo}/tap-rush/start`)).json().error.code).toBe('NOT_A_MEMBER')

    // D-43: voice bytes round-trip; mute, admins-only, pin and remove/restore persist.
    const audio = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(500, 7)])
    const voiceMsg = (await post('carol', `/v1/clubs/${club.slug}/voice`, { audio: audio.toString('base64'), durationMs: 2500 })).json().message
    const served = await app.inject({ method: 'GET', url: voiceMsg.voice.url })
    expect(Buffer.from(served.rawPayload).equals(audio)).toBe(true)
    const daveRef = (await get('dave', `/v1/clubs/${club.slug}/members`)).json().members.find((m: { me: boolean }) => m.me).id
    expect((await post('alice', `/v1/clubs/${club.slug}/members/${daveRef}/mute`, { minutes: 60 })).json().mutedUntil).toBeTruthy()
    expect((await post('dave', `/v1/clubs/${club.slug}/messages`, { body: 'x' })).json().error.code).toBe('MUTED')
    await app.inject({ method: 'PUT', url: `/v1/clubs/${club.slug}/settings`, headers: h('alice'), payload: { adminsOnly: true } })
    expect((await post('carol', `/v1/clubs/${club.slug}/messages`, { body: 'x' })).json().error.code).toBe('ADMINS_ONLY')
    await post('alice', `/v1/clubs/${club.slug}/messages/${m1.id}/pin`)
    expect((await get('carol', `/v1/clubs/${club.slug}`)).json().club).toMatchObject({ adminsOnly: true, pinned: { id: m1.id } })
    await post('alice', `/v1/clubs/${club.slug}/members/${daveRef}/remove`)
    expect((await post('dave', `/v1/clubs/${club.slug}/join`)).json().error.code).toBe('REMOVED')
    const removedRef = (await get('alice', `/v1/clubs/${club.slug}/members`)).json().removed[0].id
    await post('alice', `/v1/clubs/${club.slug}/removed/${removedRef}/restore`)
    expect((await post('dave', `/v1/clubs/${club.slug}/join`)).statusCode).toBe(200)
    await app.inject({ method: 'PUT', url: `/v1/clubs/${club.slug}/settings`, headers: h('alice'), payload: { adminsOnly: false } })

    // Captain leaving disbands; members can leave the club; owners cannot.
    expect((await post('bob', `/v1/squads/${squad.id}/leave`)).json().disbanded).toBe(true)
    expect((await post('alice', `/v1/clubs/${club.slug}/leave`)).json().error.code).toBe('OWNER_CANNOT_LEAVE')
    expect((await post('erin', `/v1/clubs/${club.slug}/leave`)).json().club.memberCount).toBe(4)
    await app.close()
  }, 600_000)
})

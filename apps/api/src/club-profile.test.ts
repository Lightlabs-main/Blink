import { loadEnv } from '@blink/config'
import { activityStreak } from '@blink/domain'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { InMemoryProfileStore } from './profile.ts'
import { memberRef } from './social-routes.ts'
import { InMemorySocialStore } from './social-store.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async () => [],
  getEmbeddedSolanaWallets: async (u) => [`Wa11et${u.replace(/\W/g, '')}xxxxxxxxxxxxxxxxxxxx`],
}
const as = (u: string) => ({ authorization: `Bearer ${u}` })

let app: FastifyInstance
let social: InMemorySocialStore
let campaigns: InMemoryCampaignRepository
let profiles: InMemoryProfileStore

beforeEach(() => {
  campaigns = new InMemoryCampaignRepository()
  const rows: { id: string; clubId: string | null; createdAt: Date }[] = []
  social = new InMemorySocialStore(() => rows)
  profiles = new InMemoryProfileStore()
  const create = campaigns.create.bind(campaigns)
  campaigns.create = async (c) => {
    const s = await create(c)
    rows.push({ id: s.id, clubId: s.clubId ?? null, createdAt: s.createdAt })
    return s
  }
  app = buildApp({ env, auth, campaigns, claims: new InMemoryClaimRepository(campaigns), profiles, social, rpc: {} as Rpc<GetAccountInfoApi>, assets: [] })
})

const post = (u: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: as(u), payload })
const get = (u: string, url: string) => app.inject({ method: 'GET', url, headers: as(u) })
const del = (u: string, url: string) => app.inject({ method: 'DELETE', url, headers: as(u) })
const makeClub = async (u: string, name: string, visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') =>
  (await post(u, '/v1/clubs', { name, description: 'A club used by the tests here.', category: 'COMMUNITY', visibility })).json().club

describe('club deletion', () => {
  it('only the owner deletes; the club disappears and its name can be used again', async () => {
    const club = await makeClub('alice', 'Early Users')
    await post('bob', `/v1/clubs/${club.slug}/join`)
    expect((await del('bob', `/v1/clubs/${club.slug}`)).json().error.code).toBe('NOT_OWNER')
    expect((await del('carol', `/v1/clubs/${club.slug}`)).json().error.code).toBe('NOT_A_MEMBER')
    expect((await del('alice', `/v1/clubs/${club.slug}`)).json()).toEqual({ deleted: true })
    expect((await get('bob', `/v1/clubs/${club.slug}`)).statusCode).toBe(404)
    expect((await get('bob', '/v1/clubs?tab=joined')).json().clubs).toEqual([])
    expect((await get('dave', '/v1/clubs')).json().clubs.some((c: { name: string }) => c.name === 'Early Users')).toBe(false)
    expect((await post('dave', '/v1/clubs', { name: 'Early Users', description: 'Same name, new club.', category: 'COMMUNITY' })).statusCode).toBe(201)
  })

  it('is refused while a funded drop still runs in the club', async () => {
    const club = await makeClub('alice', 'Drop Club')
    const id = crypto.randomUUID()
    await campaigns.create({
      id, type: 'GIFT', cluster: 'devnet', creatorPrivyUserId: 'did:privy:alice', creatorWallet: '11111111111111111111111111111112', mint: SUPPORTED_XSTOCKS[0]!.mint,
      xstockSymbol: 'NVDAx', campaignSeed: 'seed', campaignTokenAccount: id, allowanceRaw: 100n, rewardPerClaimRaw: 10n, tapRush: null, clubId: club.id,
    })
    await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
    expect((await del('alice', `/v1/clubs/${club.slug}`)).json().error.code).toBe('CLUB_HAS_LIVE_DROPS')
    expect((await get('alice', `/v1/clubs/${club.slug}`)).statusCode).toBe(200)
  })
})

describe('member profile card', () => {
  it('shows role, public clubs only, the streak and no wallet', async () => {
    const main = await makeClub('alice', 'Main Club')
    const side = await makeClub('alice', 'Side Club')
    const secret = await makeClub('bob', 'Secret Club', 'PRIVATE')
    await post('bob', `/v1/clubs/${main.slug}/join`)
    await post('bob', `/v1/clubs/${side.slug}/join`)
    await profiles.setUsername('did:privy:bob', 'bob')
    await post('bob', `/v1/clubs/${main.slug}/messages`, { body: 'gm' })

    const res = await get('alice', `/v1/clubs/${main.slug}/members/${memberRef(main.id, 'did:privy:bob')}/profile`)
    expect(res.statusCode).toBe(200)
    const p = res.json().profile
    expect(p).toMatchObject({ who: { label: '@bob' }, role: 'MEMBER', me: false, stats: { streakDays: 1, rewards: 0, checkins: 0, oreDeploys: 0 } })
    expect(p.clubs.map((c: { name: string }) => c.name).sort()).toEqual(['Main Club', 'Side Club'])
    expect(JSON.stringify(p)).not.toContain('Secret Club')
    expect(JSON.stringify(p)).not.toContain('Wa11et')
    expect(secret.slug).toBeTruthy()
    expect((await get('alice', `/v1/clubs/${main.slug}/members/${'f'.repeat(16)}/profile`)).statusCode).toBe(404)
  })

  it('counts a streak back from today or yesterday', () => {
    const now = new Date('2026-10-10T12:00:00Z')
    const d = (iso: string) => new Date(iso)
    expect(activityStreak([], now)).toBe(0)
    expect(activityStreak([d('2026-10-10T01:00:00Z'), d('2026-10-09T23:00:00Z'), d('2026-10-08T10:00:00Z')], now)).toBe(3)
    expect(activityStreak([d('2026-10-09T10:00:00Z'), d('2026-10-08T10:00:00Z')], now)).toBe(2)
    expect(activityStreak([d('2026-10-08T10:00:00Z')], now)).toBe(0)
    expect(activityStreak([d('2026-10-10T10:00:00Z'), d('2026-10-08T10:00:00Z')], now)).toBe(1)
  })
})

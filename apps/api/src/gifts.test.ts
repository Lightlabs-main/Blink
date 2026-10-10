import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { normalizeName, splitNames } from './gift-routes.ts'
import { InMemoryProfileStore } from './profile.ts'
import { InMemorySocialStore } from './social-store.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const MINT = SUPPORTED_XSTOCKS[0]!.mint
const ASSETS = SUPPORTED_XSTOCKS.map(({ symbol, name, mint, decimals, logo }) => ({ symbol, name, mint, decimals, logo, isTest: false }))
const CREATOR_WALLET = '11111111111111111111111111111112'
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async (u) => (u === 'did:privy:creator' ? [CREATOR_WALLET] : []),
  getEmbeddedSolanaWallets: async () => [],
}
const as = (u: string) => ({ authorization: `Bearer ${u}` })

let app: FastifyInstance
let campaigns: InMemoryCampaignRepository
let profiles: InMemoryProfileStore

beforeEach(async () => {
  campaigns = new InMemoryCampaignRepository()
  profiles = new InMemoryProfileStore()
  await profiles.setUsername('did:privy:alice', 'alice')
  await profiles.setUsername('did:privy:bob', 'bob')
  await profiles.setSkr('did:privy:bob', { name: 'bobby.skr', wallet: 'W' })
  await profiles.setUsername('did:privy:creator', 'maris')
  app = buildApp({
    env, auth, campaigns, claims: new InMemoryClaimRepository(campaigns), profiles, social: new InMemorySocialStore(), assets: ASSETS,
    rpc: { getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: null }) }) } as unknown as Rpc<GetAccountInfoApi>,
  })
})

const post = (u: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: as(u), payload })
const get = (u: string, url: string) => app.inject({ method: 'GET', url, headers: as(u) })
const giftDrop = (recipients: string[], each = '100', total?: string) =>
  post('creator', '/v1/campaigns', { type: 'GIFT', mint: MINT, rewardPerClaimRaw: each, allowanceRaw: total ?? (BigInt(each) * BigInt(recipients.length)).toString(), recipients })

describe('finding people by name', () => {
  it('normalizes @names and .skr names and splits pasted lists', () => {
    expect(normalizeName('@Alice')).toEqual({ kind: 'username', key: 'alice' })
    expect(normalizeName('Bobby.SKR')).toEqual({ kind: 'skr', key: 'bobby.skr' })
    expect(normalizeName('not a name!')).toBeNull()
    expect(splitNames(['@alice, bob\nbobby.skr  @ALICE'])).toEqual(['@alice', 'bob', 'bobby.skr'])
  })

  it('flags names that are not on Blink and marks yourself', async () => {
    const res = await post('alice', '/v1/people/resolve', { names: ['@alice, bobby.skr, ghost, bad name!'] })
    const r = res.json().results
    expect(r.map((x: { input: string; found: boolean }) => [x.input, x.found])).toEqual([['@alice', true], ['bobby.skr', true], ['ghost', false], ['bad', false], ['name!', false]])
    expect(r[0]).toMatchObject({ isYou: true, person: { label: '@alice', handle: '@alice' } })
    expect(r[1]).toMatchObject({ isYou: false, person: { username: 'bob', skrName: 'bobby.skr', handle: 'bobby.skr' } })
    expect(JSON.stringify(r)).not.toContain('did:privy')
  })
})

describe('gift drop to named people', () => {
  it('refuses unknown names, yourself and a pool that isn’t one reward per person', async () => {
    expect((await giftDrop(['@alice', 'ghost'])).json().error).toMatchObject({ code: 'UNKNOWN_RECIPIENTS', message: 'not on Blink: ghost' })
    expect((await giftDrop(['@maris'])).json().error.code).toBe('SELF_GIFT')
    expect((await giftDrop(['@alice', 'bob'], '100', '300')).json().error.code).toBe('POOL_MISMATCH')
    expect((await post('creator', '/v1/campaigns', { type: 'EARLY_CLAIM', mint: MINT, rewardPerClaimRaw: '100', allowanceRaw: '100', recipients: ['@alice'] })).statusCode).toBe(400)
  })

  it('is private: only its recipients see it and can claim it', async () => {
    const made = await giftDrop(['@alice', 'bobby.skr'])
    expect(made.statusCode).toBe(201)
    const c = made.json().campaign
    expect(c.recipientCount).toBe(2)
    expect(JSON.stringify(c)).not.toContain('did:privy')
    await campaigns.transitionStatus(c.id, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(c.id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(c.id, 'AWAITING_DELEGATION', 'LIVE')

    expect((await app.inject({ method: 'GET', url: '/v1/campaigns' })).json().campaigns).toEqual([])
    expect((await get('alice', '/v1/me/gifts-for-me')).json().drops.map((d: { campaign: { id: string }; from: string }) => [d.campaign.id, d.from])).toEqual([[c.id, '@maris']])
    expect((await get('bob', '/v1/me/gifts-for-me')).json().drops).toHaveLength(1)
    expect((await get('carol', '/v1/me/gifts-for-me')).json().drops).toEqual([])
    expect((await post('carol', `/v1/campaigns/${c.id}/claim`)).json().error.code).toBe('NOT_A_RECIPIENT')
  })
})

describe('gift a person', () => {
  it('finds the person by name and refuses unknown people and yourself', async () => {
    const send = { prepare: async () => ({ transaction: 'tx', createsRecipientAccount: false }), submit: async () => ({ signature: 's', confirmed: true }) }
    app = buildApp({ env, auth, campaigns, profiles, social: new InMemorySocialStore(), assets: ASSETS, rpc: {} as Rpc<GetAccountInfoApi>, send: send as never })
    expect((await post('alice', '/v1/gifts/prepare', { to: 'ghost', asset: MINT, amountRaw: '1' })).json().error.code).toBe('PERSON_NOT_FOUND')
    expect((await post('alice', '/v1/gifts/prepare', { to: '@alice', asset: MINT, amountRaw: '1' })).json().error.code).toBe('SELF_GIFT')
    // Bob has no Blink wallet in this fake: found by .skr name, then refused for that reason (not "not found").
    expect((await post('alice', '/v1/gifts/prepare', { to: 'bobby.skr', asset: MINT, amountRaw: '1' })).json().error.code).toBe('NO_STOCK_WALLET')
  })
})

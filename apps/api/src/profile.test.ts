import { loadEnv } from '@blink/config'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'
import { InMemoryProfileStore, usernameProblem } from './profile.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async () => [],
  getEmbeddedSolanaWallets: async () => [],
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64')
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 7)]).toString('base64')

let app: ReturnType<typeof buildApp>
afterEach(async () => app?.close())

function build() {
  const profiles = new InMemoryProfileStore()
  app = buildApp({ env, auth, campaigns: new InMemoryCampaignRepository(), rpc: {} as Rpc<GetAccountInfoApi>, assets: [], profiles })
  return profiles
}
const as = (u: string) => ({ authorization: `Bearer ${u}` })

describe('usernames and pictures (D-37)', () => {
  it('validates, reserves and keeps usernames unique (case-insensitive)', async () => {
    expect(usernameProblem('ab')).not.toBeNull()
    expect(usernameProblem('blink')).toBe('that username is reserved')
    expect(usernameProblem('maris_01')).toBeNull()
    build()
    const set = (u: string, username: string | null) => app.inject({ method: 'PUT', url: '/v1/me/profile', headers: as(u), payload: { username } })
    expect((await set('a', 'Maris')).json().profile.username).toBe('maris')
    expect((await set('b', 'MARIS')).json().error.code).toBe('USERNAME_TAKEN')
    expect((await set('b', 'no spaces')).json().error.code).toBe('INVALID_USERNAME')
    expect((await set('b', 'admin')).json().error.code).toBe('INVALID_USERNAME')
    // A released name is never handed to someone else; its first owner can take it back.
    expect((await set('a', null)).json().profile.username).toBeNull()
    expect((await set('b', 'maris')).json().error.code).toBe('USERNAME_TAKEN')
    expect((await set('a', 'stella')).json().profile.username).toBe('stella')
    expect((await set('b', 'maris')).json().error.code).toBe('USERNAME_TAKEN')
    expect((await set('a', 'maris')).json().profile.username).toBe('maris')
  })

  it('accepts only real JPEG/PNG pictures and serves them by an opaque id', async () => {
    build()
    expect((await app.inject({ method: 'PUT', url: '/v1/me/avatar', headers: as('a'), payload: { image: GIF } })).json().error.code).toBe('INVALID_IMAGE')
    const ok = await app.inject({ method: 'PUT', url: '/v1/me/avatar', headers: as('a'), payload: { image: JPEG } })
    const url = ok.json().profile.avatarUrl as string
    expect(url).toMatch(/^\/v1\/avatars\/[A-Za-z0-9_-]+\?v=1$/)
    expect(url).not.toContain('did:privy')
    const img = await app.inject({ method: 'GET', url })
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toBe('image/jpeg')
    await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: as('a') })
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })
})

describe('history (D-38)', () => {
  it('lists sends and funded drops, newest first, only for the caller', async () => {
    const { InMemoryTransferStore } = await import('./history.ts')
    const transfers = new InMemoryTransferStore()
    const campaigns = new InMemoryCampaignRepository()
    app = buildApp({ env, auth, campaigns, rpc: {} as Rpc<GetAccountInfoApi>, assets: [], transfers })
    await transfers.record({ privyUserId: 'did:privy:a', cluster: 'devnet', asset: 'SOL', symbol: 'SOL', decimals: 9, amountRaw: 5n, toAddress: 'To1', signature: 'sig-1', status: 'CONFIRMED' })
    await transfers.record({ privyUserId: 'did:privy:b', cluster: 'devnet', asset: 'SOL', symbol: 'SOL', decimals: 9, amountRaw: 7n, toAddress: 'To2', signature: 'sig-2', status: 'CONFIRMED' })
    const res = await app.inject({ method: 'GET', url: '/v1/me/history', headers: as('a') })
    const items = res.json().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'SENT', symbol: 'SOL', amountRaw: '5', signature: 'sig-1', counterparty: 'To1', mint: null })
    expect((await app.inject({ method: 'GET', url: '/v1/me/history' })).statusCode).toBe(401)
  })
})

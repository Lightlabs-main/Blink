import { loadEnv } from '@blink/config'
import { buildSkrStakeInstructions, SKR_GUARDIAN_POOL, SKR_MINT, SKR_STAKE_CONFIG, SKR_STAKE_VAULT, SKR_STAKING_PROGRAM, SkrStakeError, skrSharesForAmount } from '@blink/solana'
import { AccountRole, address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'
import { ExpoPushNotifier, InMemoryPushTokenStore } from './push.ts'
import type { SkrStaking } from './skr-service.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const LINKED = 'So11111111111111111111111111111111111111112'
const OTHER = 'Stake11111111111111111111111111111111111111'
const TOKEN = 'ExponentPushToken[abcdefghijklmnop]'

function fakeAuth(): AuthVerifier {
  return {
    async verifyAccessToken(token) {
      return { privyUserId: `did:privy:${token}`, sessionId: 's' }
    },
    async getVerifiedExternalSolanaWallets() {
      return [LINKED]
    },
    async getEmbeddedSolanaWallets() {
      return []
    },
  }
}

const calls: { wallet: string; action: string; amountRaw?: bigint; all?: boolean }[] = []
const fakeSkr: SkrStaking = {
  async position(wallet) {
    return { wallet, guardianPool: SKR_GUARDIAN_POOL, walletRaw: '5000000', stakedRaw: '0', unstakingRaw: '0', minStakeRaw: '1000000', cooldownSeconds: 172800, withdrawableAt: null }
  },
  async prepare(wallet, action, amountRaw, all) {
    calls.push({ wallet, action, amountRaw, all })
    if (action === 'withdraw') throw new SkrStakeError('INVALID', 'Nothing is unstaking.')
    return { transaction: 'AQID', minContextSlot: '1', lastValidBlockHeight: '2' }
  },
}

let app: ReturnType<typeof buildApp>
afterEach(async () => {
  await app?.close()
  calls.length = 0
})

function build(pushTokens = new InMemoryPushTokenStore()) {
  app = buildApp({
    env,
    auth: fakeAuth(),
    campaigns: new InMemoryCampaignRepository(),
    rpc: {} as Rpc<GetAccountInfoApi>,
    assets: [],
    skr: fakeSkr,
    pushTokens,
  })
  return pushTokens
}

const auth = (user: string) => ({ authorization: `Bearer ${user}` })

describe('push tokens (D-24)', () => {
  it('stores a valid Expo token for the caller and removes only their own', async () => {
    const store = build()
    const bad = await app.inject({ method: 'POST', url: '/v1/me/push-token', headers: auth('a'), payload: { token: 'nope', platform: 'android' } })
    expect(bad.statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/v1/me/push-token', payload: { token: TOKEN, platform: 'android' } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: '/v1/me/push-token', headers: auth('a'), payload: { token: TOKEN, platform: 'android' } })).statusCode).toBe(200)
    expect(await store.tokensFor('did:privy:a')).toEqual([TOKEN])
    // Another user cannot remove it…
    await app.inject({ method: 'DELETE', url: '/v1/me/push-token', headers: auth('b'), payload: { token: TOKEN } })
    expect(await store.tokensFor('did:privy:a')).toEqual([TOKEN])
    // …the owner can.
    await app.inject({ method: 'DELETE', url: '/v1/me/push-token', headers: auth('a'), payload: { token: TOKEN } })
    expect(await store.tokensFor('did:privy:a')).toEqual([])
  })

  it('sends through Expo and forgets unregistered devices', async () => {
    const store = new InMemoryPushTokenStore()
    await store.save(TOKEN, 'u', 'android')
    await store.save('ExponentPushToken[qrstuvwxyz123456]', 'u', 'android')
    const sent: unknown[] = []
    const notifier = new ExpoPushNotifier({
      store,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }) }
      },
    })
    await notifier.notify('u', { title: 'Your stock arrived', body: 'Your NVDAx reward is in your stock wallet.', url: '/home' })
    const body = sent[0] as { to: string; title: string; data: { url: string } }[]
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ to: TOKEN, title: 'Your stock arrived', data: { url: '/home' } })
    expect(await store.tokensFor('u')).toEqual([TOKEN])
  })

  it('never throws when the push service is down', async () => {
    const store = new InMemoryPushTokenStore()
    await store.save(TOKEN, 'u', 'android')
    const notifier = new ExpoPushNotifier({ store, fetch: async () => Promise.reject(new Error('offline')) })
    await expect(notifier.notify('u', { title: 't', body: 'b' })).resolves.toBeUndefined()
  })
})

describe('SKR staking routes (D-23)', () => {
  it('only serves wallets Privy verified for the caller', async () => {
    build()
    const other = await app.inject({ method: 'GET', url: `/v1/skr/position?wallet=${OTHER}`, headers: auth('a') })
    expect(other.statusCode).toBe(403)
    const mine = await app.inject({ method: 'GET', url: `/v1/skr/position?wallet=${LINKED}`, headers: auth('a') })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().position.walletRaw).toBe('5000000')
    const prep = await app.inject({ method: 'POST', url: '/v1/skr/prepare', headers: auth('a'), payload: { wallet: OTHER, action: 'stake', amountRaw: '1000000' } })
    expect(prep.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('prepares an unsigned transaction and surfaces program reasons', async () => {
    build()
    const ok = await app.inject({ method: 'POST', url: '/v1/skr/prepare', headers: auth('a'), payload: { wallet: LINKED, action: 'stake', amountRaw: '1000000' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().prepared.transaction).toBe('AQID')
    expect(calls[0]).toMatchObject({ wallet: LINKED, action: 'stake', amountRaw: 1_000_000n })
    const no = await app.inject({ method: 'POST', url: '/v1/skr/prepare', headers: auth('a'), payload: { wallet: LINKED, action: 'withdraw' } })
    expect(no.statusCode).toBe(400)
    expect(no.json().error).toEqual({ code: 'SKR_INVALID', message: 'Nothing is unstaking.' })
    const bad = await app.inject({ method: 'POST', url: '/v1/skr/prepare', headers: auth('a'), payload: { wallet: LINKED, action: 'drain' } })
    expect(bad.statusCode).toBe(400)
  })
})

describe('SKR staking instructions (official IDL)', () => {
  const user = address(LINKED)

  it('stake: discriminator, u64 amount and the IDL account order', async () => {
    const [ix] = await buildSkrStakeInstructions({ action: 'stake', user, amountRaw: 2_500_000n })
    expect(ix!.programAddress).toBe(SKR_STAKING_PROGRAM)
    expect([...ix!.data!]).toEqual([206, 176, 202, 18, 200, 209, 179, 108, 0xa0, 0x25, 0x26, 0, 0, 0, 0, 0])
    const accts = ix!.accounts!
    expect(accts).toHaveLength(12)
    expect(accts[1]!.address).toBe(SKR_STAKE_CONFIG)
    expect(accts[2]!.address).toBe(SKR_GUARDIAN_POOL)
    expect(accts[3]).toEqual({ address: user, role: AccountRole.WRITABLE_SIGNER })
    expect(accts[6]!.address).toBe(SKR_STAKE_VAULT)
    expect(accts[7]!.address).toBe(SKR_MINT)
  })

  it('unstake encodes shares as u128; withdraw creates the ATA first', async () => {
    const [un] = await buildSkrStakeInstructions({ action: 'unstake', user, shares: (1n << 64n) + 1n })
    expect([...un!.data!].slice(8)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])
    expect(un!.accounts![3]).toEqual({ address: user, role: AccountRole.READONLY_SIGNER })
    const w = await buildSkrStakeInstructions({ action: 'withdraw', user })
    expect(w).toHaveLength(2)
    expect([...w[0]!.data!]).toEqual([1])
    expect(w[1]!.accounts![2]).toEqual({ address: user, role: AccountRole.WRITABLE })
  })

  it('never unstakes more shares than the position holds', () => {
    expect(skrSharesForAmount(1_000_000n, 1_000_000_000n, 10_000_000n)).toBe(1_000_000n)
    expect(skrSharesForAmount(1_000_000n, 2_000_000_000n, 10_000_000n)).toBe(500_000n)
    expect(skrSharesForAmount(50_000_000n, 1_000_000_000n, 10_000_000n)).toBe(10_000_000n)
  })
})

describe('remove a linked Solana wallet (D-26)', () => {
  it('removes only the caller’s own linked wallet', async () => {
    const removed: string[] = []
    app = buildApp({
      env,
      auth: { ...fakeAuth(), unlinkExternalSolanaWallet: async (_u, a) => (removed.push(a), []) },
      campaigns: new InMemoryCampaignRepository(),
      rpc: {} as Rpc<GetAccountInfoApi>,
      assets: [],
    })
    expect((await app.inject({ method: 'DELETE', url: `/v1/me/wallets/${OTHER}`, headers: auth('a') })).statusCode).toBe(404)
    const ok = await app.inject({ method: 'DELETE', url: `/v1/me/wallets/${LINKED}`, headers: auth('a') })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ verifiedCreatorWallets: [] })
    expect(removed).toEqual([LINKED])
  })
})

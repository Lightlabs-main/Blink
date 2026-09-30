import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository, type NewCampaign, type StoredCampaign } from './campaign-repo.ts'
import { InMemoryClaimRepository, type StoredClaim } from './claim-repo.ts'
import type { PayoutService } from './payout-service.ts'

const CREATOR_WALLET = '11111111111111111111111111111112'
const MINT = SUPPORTED_XSTOCKS[0]!.mint
const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' })
const ASSETS = SUPPORTED_XSTOCKS.map(({ symbol, name, mint, decimals, logo }) => ({ symbol, name, mint, decimals, logo, isTest: false }))

/** Token "user-N" authenticates as did:privy:N with embedded wallet "wallet-N". */
function fakeAuth(): AuthVerifier {
  return {
    async verifyAccessToken(token) {
      return { privyUserId: `did:privy:${token.replace('user-', '')}`, sessionId: 's' }
    },
    async getVerifiedExternalSolanaWallets() {
      return []
    },
    async getEmbeddedSolanaWallets(userId) {
      return [`wallet-${userId.replace('did:privy:', '')}`]
    },
  }
}

/** Pays instantly unless told to fail; records what it paid. */
function fakePayouts(claims: InMemoryClaimRepository, opts: { fail?: boolean } = {}): PayoutService & { paid: string[] } {
  const paid: string[] = []
  return {
    paid,
    async pay(_c: StoredCampaign, claim: StoredClaim) {
      if (opts.fail) {
        await claims.markFailed(claim.id, 'EXPIRED')
        return { ...claim, status: 'FAILED' }
      }
      await claims.markSending(claim.id, `sig-${claim.id}`, 100n)
      paid.push(claim.recipientWallet)
      return (await claims.markPaid(claim.id))!
    },
    async reconcile(claim) {
      return claim
    },
    async feePayerAddress() {
      return CREATOR_WALLET
    },
  }
}

let app: ReturnType<typeof buildApp>
let campaigns: InMemoryCampaignRepository
let claims: InMemoryClaimRepository
afterEach(async () => {
  await app?.close()
  vi.useRealTimers()
})

function build(opts: { failPayouts?: boolean; noPayouts?: boolean } = {}) {
  campaigns = new InMemoryCampaignRepository()
  claims = new InMemoryClaimRepository(campaigns)
  const payouts = opts.noPayouts ? undefined : fakePayouts(claims, { fail: opts.failPayouts })
  app = buildApp({
    env,
    auth: fakeAuth(),
    campaigns,
    rpc: {} as Rpc<GetAccountInfoApi>,
    assets: ASSETS,
    claims,
    payouts,
  })
  return payouts
}

async function liveCampaign(overrides: Partial<NewCampaign> = {}): Promise<StoredCampaign> {
  const id = crypto.randomUUID()
  await campaigns.create({
    id,
    type: 'GIFT',
    cluster: 'devnet',
    creatorPrivyUserId: 'did:privy:creator',
    creatorWallet: CREATOR_WALLET,
    mint: MINT,
    xstockSymbol: 'NVDAx',
    campaignSeed: id.replaceAll('-', ''),
    campaignTokenAccount: `acct-${id}`,
    allowanceRaw: 300n,
    rewardPerClaimRaw: 100n,
    tapRush: null,
    ...overrides,
  })
  await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
  await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
  return (await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE'))!
}

const as = (user: string) => ({ authorization: `Bearer user-${user}` })
const claim = (id: string, user: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: `/v1/campaigns/${id}/claim`, headers: as(user), payload })

describe('claims (fixed amount per person)', () => {
  it('pays the fixed amount to the caller’s Blink wallet and reports it', async () => {
    const payouts = build()!
    const c = await liveCampaign()
    const res = await claim(c.id, 'alice')
    expect(res.statusCode).toBe(200)
    expect(res.json().claim).toMatchObject({ status: 'PAID', amountRaw: '100', recipientWallet: 'wallet-alice', xstockSymbol: 'NVDAx' })
    expect(payouts.paid).toEqual(['wallet-alice'])
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(100n)
  })

  it('is idempotent: a second claim returns the same claim and never pays twice', async () => {
    const payouts = build()!
    const c = await liveCampaign()
    const first = (await claim(c.id, 'alice')).json().claim
    const again = (await claim(c.id, 'alice')).json().claim
    expect(again.id).toBe(first.id)
    expect(payouts.paid).toHaveLength(1)
  })

  it('stops at the pool: first come, first served, never over the allowance', async () => {
    const payouts = build()!
    const c = await liveCampaign({ allowanceRaw: 250n, rewardPerClaimRaw: 100n })
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((u) => claim(c.id, u)))
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2)
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json().error.code)).toEqual(['EXHAUSTED', 'EXHAUSTED'])
    expect(payouts.paid).toHaveLength(2)
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(200n)
  })

  it('the creator cannot claim their own drop', async () => {
    build()
    const c = await liveCampaign()
    const res = await claim(c.id, 'creator')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('OWN_CAMPAIGN')
  })

  it('rejects drops that are not live or not claimable', async () => {
    build()
    const referral = await liveCampaign({ type: 'REFERRAL' })
    expect((await claim(referral.id, 'alice')).json().error.code).toBe('NOT_CLAIMABLE')
    const legacy = await liveCampaign({ rewardPerClaimRaw: null })
    expect((await claim(legacy.id, 'alice')).json().error.code).toBe('NOT_CLAIMABLE')
    const paused = await liveCampaign()
    await campaigns.transitionStatus(paused.id, 'LIVE', 'PAUSED', 'OWNER_PAUSED')
    expect((await claim(paused.id, 'alice')).json().error.code).toBe('NOT_LIVE')
  })

  it('a failed payout releases the pool and the user can retry', async () => {
    build({ failPayouts: true })
    const c = await liveCampaign()
    expect((await claim(c.id, 'alice')).json().claim.status).toBe('FAILED')
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
    const retry = await claims.reserve({ campaignId: c.id, privyUserId: 'did:privy:alice', recipientWallet: 'wallet-alice', amountRaw: 100n, tapSessionId: null })
    expect(retry).toMatchObject({ ok: true, fresh: true })
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(100n)
  })

  it('503 when payouts are not configured, without holding any stock', async () => {
    build({ noPayouts: true })
    const c = await liveCampaign()
    const res = await claim(c.id, 'alice')
    expect(res.statusCode).toBe(503)
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
  })

  it('GET claim and /v1/me/claims show the caller’s claims only', async () => {
    build()
    const c = await liveCampaign()
    await claim(c.id, 'alice')
    const mine = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/claim`, headers: as('alice') })
    expect(mine.json().claim.status).toBe('PAID')
    const bob = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/claim`, headers: as('bob') })
    expect(bob.json().claim).toBeNull()
    const list = await app.inject({ method: 'GET', url: '/v1/me/claims', headers: as('alice') })
    expect(list.json().claims).toHaveLength(1)
  })

  it('the public summary shows the reward and how much is claimed', async () => {
    build()
    const c = await liveCampaign()
    await claim(c.id, 'alice')
    const res = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}` })
    expect(res.json().campaign).toMatchObject({ rewardPerClaimRaw: '100', claimedRaw: '100', tapRush: null })
  })
})

describe('Tap Rush', () => {
  const rules = { goal: 20, seconds: 10 }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
  })

  async function play(id: string, user: string, taps: number, afterMs = rules.seconds * 1000) {
    const start = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/tap-rush/start`, headers: as(user) })
    const session = start.json().session
    vi.setSystemTime(Date.now() + afterMs)
    const finish = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/tap-rush/finish`,
      headers: as(user),
      payload: { sessionId: session.id, taps },
    })
    return { session, finish }
  }

  it('reaching the goal in time qualifies, and the round can be claimed once', async () => {
    const payouts = build()!
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { session, finish } = await play(c.id, 'alice', 25)
    expect(session).toMatchObject({ goal: 20, seconds: 10 })
    expect(finish.json()).toMatchObject({ qualified: true, taps: 25 })
    const res = await claim(c.id, 'alice', { tapSessionId: session.id })
    expect(res.json().claim.status).toBe('PAID')
    expect(payouts.paid).toEqual(['wallet-alice'])
  })

  it('missing the goal does not qualify', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { session, finish } = await play(c.id, 'alice', 19)
    expect(finish.json().qualified).toBe(false)
    const res = await claim(c.id, 'alice', { tapSessionId: session.id })
    expect(res.json().error.code).toBe('NOT_QUALIFIED')
  })

  it('a claim without a qualifying round is refused', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NOT_QUALIFIED')
  })

  it('a round finished too early is rejected', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { finish } = await play(c.id, 'alice', 25, 4000)
    expect(finish.statusCode).toBe(422)
    expect(finish.json().error.code).toBe('ROUND_TIMING_INVALID')
  })

  it('an impossible tap count is rejected', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { finish } = await play(c.id, 'alice', 201)
    expect(finish.json().error.code).toBe('ROUND_REJECTED')
  })

  it('someone else cannot use your qualifying round', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { session } = await play(c.id, 'alice', 25)
    const res = await claim(c.id, 'bob', { tapSessionId: session.id })
    expect(res.json().error.code).toBe('NOT_QUALIFIED')
  })

  it('limits the number of tries', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    for (let i = 0; i < 10; i++) await play(c.id, 'alice', 1)
    const res = await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/tap-rush/start`, headers: as('alice') })
    expect(res.statusCode).toBe(429)
  })

  it('creating a Tap Rush without rules applies the defaults', async () => {
    build()
    const wallets = { ...fakeAuth(), getVerifiedExternalSolanaWallets: async () => [CREATOR_WALLET] }
    await app.close()
    app = buildApp({
      env,
      auth: wallets,
      campaigns,
      rpc: { getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: null }) }) } as unknown as Rpc<GetAccountInfoApi>,
      assets: ASSETS,
      claims,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: as('creator'),
      payload: { type: 'TAP_RUSH', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '100' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().campaign.tapRush).toEqual({ goal: 50, seconds: 10 })
  })
})

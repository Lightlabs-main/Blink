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
function fakePayouts(
  claims: InMemoryClaimRepository,
  opts: { fail?: boolean; failFor?: string[]; ready?: boolean } = {},
): PayoutService & { paid: string[] } {
  const paid: string[] = []
  return {
    paid,
    async checkReady() {
      return opts.ready === false ? { ok: false as const, reason: 'ALLOWANCE_EXHAUSTED' as const, detail: ['ALLOWANCE_EXHAUSTED'] } : { ok: true as const }
    },
    async pay(_c: StoredCampaign, claim: StoredClaim) {
      if (opts.fail || opts.failFor?.includes(claim.recipientWallet)) {
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

function build(opts: { failPayouts?: boolean; failFor?: string[]; noPayouts?: boolean; ready?: boolean } = {}) {
  campaigns = new InMemoryCampaignRepository()
  claims = new InMemoryClaimRepository(campaigns)
  const payouts = opts.noPayouts ? undefined : fakePayouts(claims, { fail: opts.failPayouts, failFor: opts.failFor, ready: opts.ready })
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

/** Human-like tap times: ~7 taps/s with natural jitter. */
function humanTaps(count: number, seconds = 10) {
  const times: number[] = []
  let t = 120
  for (let i = 0; i < count; i++) {
    times.push(Math.min(t, seconds * 1000))
    t += 110 + ((i * 37) % 60)
  }
  return times
}
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
    const seeker = await liveCampaign({ type: 'SEEKER' })
    expect((await claim(seeker.id, 'alice')).json().error.code).toBe('NOT_CLAIMABLE')
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

  async function play(id: string, user: string, taps: number, afterMs = rules.seconds * 1000, tapTimesMs = humanTaps(taps)) {
    const start = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/tap-rush/start`, headers: as(user) })
    const session = start.json().session
    vi.setSystemTime(Date.now() + afterMs)
    const finish = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${id}/tap-rush/finish`,
      headers: as(user),
      payload: { sessionId: session.id, taps, tapTimesMs },
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
    const { finish } = await play(c.id, 'alice', 201, undefined, Array.from({ length: 201 }, (_, i) => i * 49))
    expect(finish.json().error.code).toBe('ROUND_REJECTED')
  })

  it('machine-timed taps are rejected even when the count is plausible', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const metronome = Array.from({ length: 30 }, (_, i) => 100 + i * 150)
    const { finish } = await play(c.id, 'alice', 30, undefined, metronome)
    expect(finish.statusCode).toBe(422)
    expect(finish.json().error.message).toMatch(/automated/)
  })

  it('a tap count that does not match the tap times is rejected', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: rules })
    const { finish } = await play(c.id, 'alice', 40, undefined, humanTaps(25))
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

describe('Referral drops (both get the reward, D-14)', () => {
  async function invite(id: string, user: string) {
    const res = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/referral`, headers: as(user) })
    return res.json().referral.code as string
  }

  it('a friend claiming through an invite pays the friend and the referrer', async () => {
    const payouts = build()!
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 1000n })
    const code = await invite(c.id, 'alice')
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/)
    expect(await invite(c.id, 'alice')).toBe(code)
    const res = await claim(c.id, 'bob', { ref: code })
    expect(res.json().claim).toMatchObject({ status: 'PAID', kind: 'CLAIM', recipientWallet: 'wallet-bob' })
    expect(payouts.paid).toEqual(['wallet-bob', 'wallet-alice'])
    const mine = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/referral`, headers: as('alice') })
    expect(mine.json().referral.bonus).toMatchObject({ kind: 'REFERRAL_BONUS', status: 'PAID' })
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(200n)
  })

  it('each referrer is paid once; later friends still get their reward', async () => {
    const payouts = build()!
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 1000n })
    const code = await invite(c.id, 'alice')
    await claim(c.id, 'bob', { ref: code })
    await claim(c.id, 'carol', { ref: code })
    expect(payouts.paid).toEqual(['wallet-bob', 'wallet-alice', 'wallet-carol'])
  })

  it('needs a valid invite from someone else', async () => {
    build()
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 1000n })
    expect((await claim(c.id, 'bob')).json().error.code).toBe('NEEDS_INVITE')
    expect((await claim(c.id, 'bob', { ref: 'ABCDEFGH' })).json().error.code).toBe('NEEDS_INVITE')
    const code = await invite(c.id, 'bob')
    expect((await claim(c.id, 'bob', { ref: code })).json().error.code).toBe('SELF_REFERRAL')
  })

  it('when only one reward is left, the friend is refused rather than the pool overdrawn', async () => {
    build()
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 100n })
    const code = await invite(c.id, 'alice')
    expect((await claim(c.id, 'bob', { ref: code })).json().error.code).toBe('EXHAUSTED')
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
  })

  it('a failed bonus can be retried by the referrer once the friend is paid', async () => {
    const failing = ['wallet-alice']
    build({ failFor: failing })
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 1000n })
    const code = await invite(c.id, 'alice')
    expect((await claim(c.id, 'bob', { ref: code })).json().claim.status).toBe('PAID')
    const before = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/referral`, headers: as('alice') })
    expect(before.json().referral.bonus.status).toBe('FAILED')
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(100n)

    failing.length = 0
    const retry = await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/referral/bonus/retry`, headers: as('alice') })
    expect(retry.json().claim).toMatchObject({ kind: 'REFERRAL_BONUS', status: 'PAID' })
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(200n)
  })

  it('the creator cannot get an invite link', async () => {
    build()
    const c = await liveCampaign({ type: 'REFERRAL' })
    const res = await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/referral`, headers: as('creator') })
    expect(res.json().error.code).toBe('OWN_CAMPAIGN')
  })
})

describe('resuming paused drops', () => {
  const resume = (id: string, user = 'creator') => app.inject({ method: 'POST', url: `/v1/campaigns/${id}/resume`, headers: as(user) })

  it('puts a paused drop back live when the onchain check passes', async () => {
    build()
    const c = await liveCampaign()
    await campaigns.transitionStatus(c.id, 'LIVE', 'PAUSED', 'ALLOWANCE_EXHAUSTED')
    expect((await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}` })).json().campaign.pauseReason).toBe('ALLOWANCE_EXHAUSTED')
    const res = await resume(c.id)
    expect(res.json().campaign).toMatchObject({ status: 'LIVE', pauseReason: null })
  })

  it('stays paused and explains why when the check fails', async () => {
    build({ ready: false })
    const c = await liveCampaign()
    await campaigns.transitionStatus(c.id, 'LIVE', 'PAUSED', 'ALLOWANCE_EXHAUSTED')
    const res = await resume(c.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('STILL_NOT_READY')
    expect((await campaigns.findById(c.id))!.status).toBe('PAUSED')
  })

  it('ends a paused drop that cannot fit another reward', async () => {
    build()
    const c = await liveCampaign({ allowanceRaw: 100n })
    await claim(c.id, 'alice')
    const row = campaigns.row(c.id)!
    row.status = 'PAUSED'
    expect((await resume(c.id)).json().campaign.status).toBe('ENDED')
  })

  it('only the creator can resume', async () => {
    build()
    const c = await liveCampaign()
    await campaigns.transitionStatus(c.id, 'LIVE', 'PAUSED', 'OWNER_PAUSED')
    expect((await resume(c.id, 'alice')).statusCode).toBe(404)
  })
})

describe('background sweep', () => {
  it('releases reservations abandoned before signing', async () => {
    build()
    const c = await liveCampaign()
    const r = await claims.reserve({ campaignId: c.id, privyUserId: 'did:privy:ghost', recipientWallet: 'wallet-ghost', amountRaw: 100n, tapSessionId: null })
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(100n)
    if (r.ok) r.claim.updatedAt = new Date(Date.now() - 10 * 60_000)
    const { ClaimService } = await import('./claim-service.ts')
    const payouts = fakePayouts(claims)
    const swept = await new ClaimService({ env, auth: fakeAuth(), campaigns, claims, payouts }).sweep()
    expect(swept).toBe(1)
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
  })
})

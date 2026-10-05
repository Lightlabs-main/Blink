import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository, type NewCampaign, type StoredCampaign } from './campaign-repo.ts'
import { InMemoryClaimRepository, type StoredClaim } from './claim-repo.ts'
import { EligibilityService } from './eligibility.ts'
import { type ChainReader, QuestService } from './quest-service.ts'
import type { PayoutService } from './payout-service.ts'

const CREATOR_WALLET = '11111111111111111111111111111112'
const MINT = SUPPORTED_XSTOCKS[0]!.mint
// Mechanics tests run with the eligibility gate off; 'xStocks eligibility gate' below turns it on.
const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const ASSETS = SUPPORTED_XSTOCKS.map(({ symbol, name, mint, decimals, logo }) => ({ symbol, name, mint, decimals, logo, isTest: false }))

/** Token "user-N" authenticates as did:privy:N with embedded wallet "wallet-N". */
function fakeAuth(): AuthVerifier {
  return {
    async verifyAccessToken(token) {
      return { privyUserId: `did:privy:${token.replace('user-', '')}`, sessionId: 's' }
    },
    async getVerifiedExternalSolanaWallets(userId) {
      // Each test user has one SIWS-verified external wallet: their "Seeker" wallet.
      return [`seedvault-${userId.replace('did:privy:', '')}`]
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
    async feePayerStatus() {
      return { address: CREATOR_WALLET, balanceLamports: 5_000_000n, low: true }
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

function build(
  opts: {
    failPayouts?: boolean
    failFor?: string[]
    noPayouts?: boolean
    ready?: boolean
    env?: typeof env
    sgt?: Record<string, string>
    eligibility?: EligibilityService
    chain?: ChainReader
  } = {},
) {
  campaigns = new InMemoryCampaignRepository()
  claims = new InMemoryClaimRepository(campaigns)
  const payouts = opts.noPayouts ? undefined : fakePayouts(claims, { fail: opts.failPayouts, failFor: opts.failFor, ready: opts.ready })
  app = buildApp({
    env: opts.env ?? env,
    auth: fakeAuth(),
    campaigns,
    rpc: {} as Rpc<GetAccountInfoApi>,
    assets: ASSETS,
    claims,
    payouts,
    seeker: opts.sgt ? { findSgt: async (wallet: string) => opts.sgt![wallet] ?? null } : undefined,
    eligibility: opts.eligibility,
    quests: new QuestService({
      auth: fakeAuth(),
      claims,
      chain: opts.chain,
      seeker: opts.sgt ? { findSgt: async (wallet: string) => opts.sgt![wallet] ?? null } : undefined,
    }),
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
    const unknown = await liveCampaign({ type: 'GIFT', rewardPerClaimRaw: null })
    expect((await claim(unknown.id, 'alice')).json().error.code).toBe('NOT_CLAIMABLE')
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
    expect(res.json().campaign.tapRush).toEqual({ goal: 1000, seconds: 120 })
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
  it('a claim released by the sweep can no longer be sent (no double pay)', async () => {
    build()
    const c = await liveCampaign()
    const r = await claims.reserve({ campaignId: c.id, privyUserId: 'did:privy:slow', recipientWallet: 'wallet-slow', amountRaw: 100n, tapSessionId: null })
    if (!r.ok) throw new Error('reserve failed')
    await claims.markFailed(r.claim.id, 'STALE_RESERVATION') // the sweep, while signing was slow
    expect(await claims.markSending(r.claim.id, 'sig-late', 100n)).toBe(false)
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
  })

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

describe('status', () => {
  it('reports the fee payer and flags a low balance', async () => {
    build()
    const res = await app.inject({ method: 'GET', url: '/v1/status' })
    expect(res.json()).toEqual({
      cluster: 'devnet',
      payouts: { enabled: true, feePayer: CREATOR_WALLET, balanceLamports: '5000000', low: true, killSwitch: false },
      compliance: { xstocks: 'off' },
    })
  })
})

describe('rate limits and the per-IP claim cap (D-16)', () => {
  it('throttles a single user who hammers the claim route', async () => {
    build()
    const c = await liveCampaign()
    const codes: number[] = []
    for (let i = 0; i < 32; i++) codes.push((await claim(c.id, 'alice')).statusCode)
    expect(codes.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(codes.slice(30)).toEqual([429, 429])
  })

  it('caps successful claims per IP per drop when configured', async () => {
    build({ env: loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', CLAIMS_PER_IP_PER_CAMPAIGN: '2', XSTOCK_COMPLIANCE: 'off' }) })
    const c = await liveCampaign({ allowanceRaw: 1000n })
    expect((await claim(c.id, 'a')).statusCode).toBe(200)
    expect((await claim(c.id, 'b')).statusCode).toBe(200)
    const third = await claim(c.id, 'c')
    expect(third.statusCode).toBe(429)
    expect(third.json().error.code).toBe('IP_LIMIT')
    // Re-asking for an existing claim is not a new claim and is never blocked by the cap.
    expect((await claim(c.id, 'a')).json().claim.status).toBe('PAID')
  })
})

describe('Seeker drops (D-17)', () => {
  it('pays a user whose verified wallet holds a Seeker Genesis Token', async () => {
    const payouts = build({ sgt: { 'seedvault-alice': 'SGT-MINT-1' } })!
    const c = await liveCampaign({ type: 'SEEKER' })
    const res = await claim(c.id, 'alice')
    expect(res.json().claim).toMatchObject({ status: 'PAID', recipientWallet: 'wallet-alice' })
    expect(payouts.paid).toEqual(['wallet-alice'])
  })

  it('refuses without a Seeker Genesis Token', async () => {
    build({ sgt: {} })
    const c = await liveCampaign({ type: 'SEEKER' })
    const res = await claim(c.id, 'bob')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('NEEDS_SEEKER')
  })

  it('one claim per Seeker device, even from another account', async () => {
    build({ sgt: { 'seedvault-alice': 'SGT-MINT-1', 'seedvault-mallory': 'SGT-MINT-1' } })
    const c = await liveCampaign({ type: 'SEEKER' })
    expect((await claim(c.id, 'alice')).statusCode).toBe(200)
    const again = await claim(c.id, 'mallory')
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('DEVICE_ALREADY_CLAIMED')
  })

  it('503 when Seeker verification is not configured', async () => {
    build()
    const c = await liveCampaign({ type: 'SEEKER' })
    expect((await claim(c.id, 'alice')).json().error.code).toBe('SEEKER_UNAVAILABLE')
  })
})

describe('xStocks eligibility gate (D-20) and payout kill switch', () => {
  const enforced = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com' })
  /** Every request in these tests comes from 127.0.0.1; the fake resolver says which country that is. */
  let ipCountry: string | null = 'DE'
  function gated(extra: { failFor?: string[] } = {}) {
    campaigns = new InMemoryCampaignRepository()
    claims = new InMemoryClaimRepository(campaigns)
    const eligibility = new EligibilityService({ env: enforced, store: claims, ipCountry: { countryOf: () => ipCountry } })
    const payouts = fakePayouts(claims, { failFor: extra.failFor })
    app = buildApp({ env: enforced, auth: fakeAuth(), campaigns, rpc: {} as Rpc<GetAccountInfoApi>, assets: ASSETS, claims, payouts, eligibility })
    return payouts
  }
  const declare = (user: string, body: object) => app.inject({ method: 'POST', url: '/v1/me/eligibility', headers: as(user), payload: body })
  beforeEach(() => {
    ipCountry = 'DE'
  })

  it('blocks a claim until the user confirms eligibility, then pays', async () => {
    const payouts = gated()
    const c = await liveCampaign()
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NEEDS_ELIGIBILITY')
    const res = await declare('alice', { country: 'DE', notUsPerson: true })
    expect(res.json().eligibility).toMatchObject({ eligible: true, reason: 'ELIGIBLE', declaredCountry: 'DE', current: true })
    expect((await claim(c.id, 'alice')).json().claim.status).toBe('PAID')
    expect(payouts.paid).toEqual(['wallet-alice'])
  })

  it('refuses restricted countries, U.S. persons and a missing region attestation', async () => {
    gated()
    expect((await declare('a', { country: 'RU', notUsPerson: true })).json().eligibility.reason).toBe('DECLARED_COUNTRY_RESTRICTED')
    expect((await declare('n', { country: 'NG', notUsPerson: true })).json().eligibility.eligible).toBe(true)
    expect((await declare('b', { country: 'DE', notUsPerson: false })).json().eligibility.reason).toBe('US_PERSON')
    expect((await declare('c', { country: 'UA', notUsPerson: true })).json().eligibility.reason).toBe('REGION_ATTESTATION_MISSING')
    expect((await declare('d', { country: 'UA', notUsPerson: true, attestations: ['NOT_IN_OCCUPIED_REGION'] })).json().eligibility.eligible).toBe(true)
    const c = await liveCampaign()
    expect((await claim(c.id, 'a')).json().error.code).toBe('NOT_ELIGIBLE')
  })

  it('checks the IP country again at claim time and fails closed when it is unknown', async () => {
    gated()
    const c = await liveCampaign({ allowanceRaw: 1000n })
    await declare('alice', { country: 'DE', notUsPerson: true })
    ipCountry = 'US'
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NOT_ELIGIBLE')
    ipCountry = null
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NOT_ELIGIBLE')
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
  })

  it('a declaration made from a restricted IP is not eligible', async () => {
    gated()
    ipCountry = 'GB'
    expect((await declare('alice', { country: 'DE', notUsPerson: true })).json().eligibility).toMatchObject({ eligible: false, reason: 'IP_COUNTRY_RESTRICTED' })
  })

  it('an ineligible referrer earns no bonus; the eligible friend is still paid', async () => {
    const payouts = gated()
    const c = await liveCampaign({ type: 'REFERRAL', allowanceRaw: 1000n })
    await declare('alice', { country: 'RU', notUsPerson: true })
    const code = (await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/referral`, headers: as('alice') })).json().referral.code
    await declare('bob', { country: 'DE', notUsPerson: true })
    expect((await claim(c.id, 'bob', { ref: code })).json().claim.status).toBe('PAID')
    expect(payouts.paid).toEqual(['wallet-bob'])
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(100n)
  })

  it('Tap Rush cannot start without eligibility', async () => {
    gated()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: { goal: 20, seconds: 10 } })
    const res = await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/tap-rush/start`, headers: as('alice') })
    expect(res.json().error.code).toBe('NEEDS_ELIGIBILITY')
  })

  it('fails closed when the gate is enforced but not configured', async () => {
    campaigns = new InMemoryCampaignRepository()
    claims = new InMemoryClaimRepository(campaigns)
    app = buildApp({ env: enforced, auth: fakeAuth(), campaigns, rpc: {} as Rpc<GetAccountInfoApi>, assets: ASSETS, claims, payouts: fakePayouts(claims) })
    const c = await liveCampaign()
    const res = await claim(c.id, 'alice')
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('ELIGIBILITY_UNAVAILABLE')
  })

  it('the kill switch stops claims before anything is reserved and shows in /v1/status', async () => {
    build({ env: loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off', PAYOUTS_ENABLED: 'false' }) })
    const c = await liveCampaign()
    const res = await claim(c.id, 'alice')
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('PAYOUTS_PAUSED')
    expect((await campaigns.findById(c.id))!.claimedRaw).toBe(0n)
    expect((await app.inject({ method: 'GET', url: '/v1/status' })).json().payouts.killSwitch).toBe(true)
  })
})

describe('Verified Quest (D-21)', () => {
  /** "Verified Seeker AND (hold >= 500 SKR OR stake >= 500 SKR) AND complete Tap Rush" (update §6 example). */
  const SEEKER_SKR_TAP = {
    eligibility: [
      { mode: 'ALL' as const, conditions: [{ verifier: 'SEEKER_SGT' as const }] },
      {
        mode: 'ANY' as const,
        conditions: [
          { verifier: 'SKR_BALANCE' as const, minRaw: '500000000' },
          { verifier: 'SKR_STAKED' as const, minRaw: '500000000' },
        ],
      },
    ],
    actions: [{ mode: 'ALL' as const, conditions: [{ verifier: 'TAP_RUSH' as const }] }],
  }
  const rules = { goal: 20, seconds: 10 }

  /** Wallet "seedvault-<user>" holds/stakes per the maps (raw SKR); everything else is zero. */
  function chain(skrHeld: Record<string, bigint>, skrStaked: Record<string, bigint>, fail = false, oreRounds: Record<string, bigint> = {}, board = 1_000n): ChainReader {
    const read = (m: Record<string, bigint>) => async (w: string) => {
      if (fail) throw new Error('rpc 429')
      return m[w] ?? 0n
    }
    return {
      skrBalance: read(skrHeld),
      skrStaked: read(skrStaked),
      oreBalance: read({}),
      oreStaked: read({}),
      oreMinerRound: read(oreRounds),
      oreBoardRound: async () => {
        if (fail) throw new Error('rpc 429')
        return board
      },
    }
  }

  const verify = (id: string, user: string) => app.inject({ method: 'POST', url: `/v1/campaigns/${id}/verify`, headers: as(user) })

  async function winRound(id: string, user: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/tap-rush/start`, headers: as(user) })
    const session = start.json().session
    vi.setSystemTime(Date.now() + 10_000)
    const times = Array.from({ length: 25 }, (_, i) => 120 + i * 140 + ((i * 53) % 70))
    await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/tap-rush/finish`, headers: as(user), payload: { sessionId: session.id, taps: 25, tapTimesMs: times } })
    vi.useRealTimers()
  }

  it('shows each requirement separately and qualifies only when every group passes', async () => {
    const payouts = build({ sgt: { 'seedvault-alice': 'SGT-1' }, chain: chain({}, { 'seedvault-alice': 784_000_000n }) })!
    const c = await liveCampaign({ type: 'VERIFIED_QUEST', requirements: SEEKER_SKR_TAP, tapRush: rules })

    const before = (await verify(c.id, 'alice')).json().evaluation
    expect(before.qualified).toBe(false)
    expect(before.eligibility[0].results[0]).toMatchObject({ verifier: 'SEEKER_SGT', status: 'PASSED' })
    expect(before.eligibility[1]).toMatchObject({ mode: 'ANY', passed: true })
    expect(before.eligibility[1].results[1]).toMatchObject({ verifier: 'SKR_STAKED', status: 'PASSED', actualRaw: '784000000', requiredRaw: '500000000' })
    expect(before.actions[0].results[0]).toMatchObject({ verifier: 'TAP_RUSH', status: 'NOT_STARTED' })
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NOT_QUALIFIED')

    await winRound(c.id, 'alice')
    expect((await verify(c.id, 'alice')).json().evaluation.qualified).toBe(true)
    expect((await claim(c.id, 'alice')).json().claim.status).toBe('PAID')
    expect(payouts.paid).toEqual(['wallet-alice'])
  })

  it('without the Seeker, or below every SKR threshold, the user does not qualify', async () => {
    build({ sgt: {}, chain: chain({ 'seedvault-bob': 499_999_999n }, {}) })
    const c = await liveCampaign({ type: 'VERIFIED_QUEST', requirements: SEEKER_SKR_TAP, tapRush: rules })
    await winRound(c.id, 'bob')
    const ev = (await verify(c.id, 'bob')).json().evaluation
    expect(ev.eligibility[0].results[0].status).toBe('FAILED')
    expect(ev.eligibility[1].passed).toBe(false)
    expect(ev.qualified).toBe(false)
    expect((await claim(c.id, 'bob')).json().error.code).toBe('NOT_QUALIFIED')
  })

  it('fails closed when the chain cannot be read', async () => {
    build({ sgt: { 'seedvault-alice': 'SGT-1' }, chain: chain({}, {}, true) })
    const c = await liveCampaign({ type: 'VERIFIED_QUEST', requirements: SEEKER_SKR_TAP, tapRush: rules })
    await winRound(c.id, 'alice')
    const ev = (await verify(c.id, 'alice')).json().evaluation
    expect(ev.eligibility[1].results.map((r: { status: string }) => r.status)).toEqual(['ERROR', 'ERROR'])
    expect(ev.qualified).toBe(false)
    expect((await claim(c.id, 'alice')).json().error.code).toBe('NOT_QUALIFIED')
  })

  it('creation validates requirements against the registry', async () => {
    build()
    const creator = { ...fakeAuth(), getVerifiedExternalSolanaWallets: async () => [CREATOR_WALLET] }
    await app.close()
    app = buildApp({
      env,
      auth: creator,
      campaigns,
      rpc: { getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: null }) }) } as unknown as Rpc<GetAccountInfoApi>,
      assets: ASSETS,
      claims,
    })
    const make = (requirements: object) =>
      app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('creator'), payload: { type: 'VERIFIED_QUEST', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '100', requirements } })
    const ok = await make(SEEKER_SKR_TAP)
    expect(ok.statusCode).toBe(201)
    expect(ok.json().campaign).toMatchObject({ type: 'VERIFIED_QUEST', requirements: SEEKER_SKR_TAP, tapRush: { goal: 1000, seconds: 120 } })
    const stored = await campaigns.findById(ok.json().campaign.id)
    expect(stored!.requirementsHash).toMatch(/^[0-9a-f]{64}$/)

    const bad = async (r: object) => (await make(r)).statusCode
    // D-33: the start round is set by the server only; a creator cannot choose it.
    expect(await bad({ eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY', afterRound: '1' }] }] })).toBe(400)
    // D-39: X posts are allowed; required text only on X posts.
    expect(await bad({ eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'TAP_RUSH', mustInclude: '#Blink' }] }] })).toBe(400)
    expect(await bad({ eligibility: [{ mode: 'ALL', conditions: [{ verifier: 'TAP_RUSH' }] }], actions: [] })).toBe(400)
    expect(await bad({ eligibility: [{ mode: 'ALL', conditions: [{ verifier: 'SKR_STAKED' }] }], actions: [] })).toBe(400)
    expect(await bad({ eligibility: [], actions: [] })).toBe(400)
    const noReq = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('creator'), payload: { type: 'VERIFIED_QUEST', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '100' } })
    expect(noReq.statusCode).toBe(400)
  })

  it('ORE mining (D-33): records the round at creation; only mining after it qualifies', async () => {
    build()
    const creator = { ...fakeAuth(), getVerifiedExternalSolanaWallets: async () => [CREATOR_WALLET] }
    await app.close()
    const oreChain = chain({}, {}, false, { 'seedvault-alice': 1_001n, 'seedvault-bob': 1_000n }, 1_000n)
    app = buildApp({
      env,
      auth: creator,
      campaigns,
      rpc: { getAccountInfo: () => ({ send: async () => ({ context: { slot: 1n }, value: null }) }) } as unknown as Rpc<GetAccountInfoApi>,
      assets: ASSETS,
      claims,
      quests: new QuestService({ auth: creator, claims, chain: oreChain }),
    })
    const requirements = { eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY' }] }] }
    const made = await app.inject({ method: 'POST', url: '/v1/campaigns', headers: as('creator'), payload: { type: 'VERIFIED_QUEST', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '100', requirements } })
    expect(made.statusCode).toBe(201)
    expect(made.json().campaign.requirements.actions[0].conditions[0]).toEqual({ verifier: 'ORE_ACTIVITY', afterRound: '1000' })

    // Evaluation (each test user's verified wallet is "seedvault-<name>").
    await app.close()
    build({ chain: oreChain })
    const c = await liveCampaign({ type: 'VERIFIED_QUEST', requirements: { eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY', afterRound: '1000' }] }] } })
    const alice = (await verify(c.id, 'alice')).json().evaluation
    expect(alice.qualified).toBe(true)
    const bob = (await verify(c.id, 'bob')).json().evaluation
    expect(bob.actions[0].results[0]).toMatchObject({ status: 'FAILED', detail: 'NOT_MINED_SINCE_START' })
    const never = (await verify(c.id, 'carol')).json().evaluation
    expect(never.qualified).toBe(false)
  })

  it('ORE mining fails closed when ORE cannot be read', async () => {
    build({ chain: chain({}, {}, true) })
    const c = await liveCampaign({ type: 'VERIFIED_QUEST', requirements: { eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY', afterRound: '1000' }] }] } })
    const ev = (await verify(c.id, 'alice')).json().evaluation
    expect(ev.actions[0].results[0].status).toBe('ERROR')
    expect(ev.qualified).toBe(false)
  })

  it('respects the campaign window', async () => {
    build()
    const soon = await liveCampaign({ startsAt: new Date(Date.now() + 3_600_000) })
    expect((await claim(soon.id, 'alice')).json().error.code).toBe('NOT_STARTED')
    const over = await liveCampaign({ endsAt: new Date(Date.now() - 1000) })
    expect((await claim(over.id, 'alice')).json().error.code).toBe('CAMPAIGN_OVER')
  })
})

describe('live campaign room (D-21)', () => {
  it('reports real counts, a truncated-wallet leaderboard and events, and never leaks identities', async () => {
    build()
    const c = await liveCampaign({ type: 'TAP_RUSH', tapRush: { goal: 20, seconds: 10 }, allowanceRaw: 300n })
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const [user, taps] of [['alice', 25], ['bob', 18]] as const) {
      const s = (await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/tap-rush/start`, headers: as(user) })).json().session
      vi.setSystemTime(Date.now() + 10_000)
      const times = Array.from({ length: taps }, (_, i) => 120 + i * 140 + ((i * 53) % 70))
      await app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/tap-rush/finish`, headers: as(user), payload: { sessionId: s.id, taps, tapTimesMs: times } })
      if (user === 'alice') await claim(c.id, 'alice', { tapSessionId: s.id })
    }
    vi.useRealTimers()
    const res = await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/room` })
    const room = res.json().room
    expect(room).toMatchObject({ joined: 2, qualified: 1, rewardsRemaining: 2, status: 'LIVE' })
    expect(room.leaderboard.map((e: { score: number }) => e.score)).toEqual([25, 18])
    expect(room.leaderboard[0].who.label).toMatch(/^wall…lice$/)
    expect(room.events.map((e: { type: string }) => e.type)).toContain('PAYOUT_CONFIRMED')
    expect(res.body).not.toMatch(/did:privy|country|eligib/i)
  })

  it('quests without a score show progress, not a leaderboard', async () => {
    build()
    const c = await liveCampaign({ type: 'GIFT' })
    const room = (await app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/room` })).json().room
    expect(room.leaderboard).toBeNull()
  })
})

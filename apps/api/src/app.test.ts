import { loadEnv } from '@blink/config'
import { deriveCampaignTokenAccount } from '@blink/solana'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import { address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import { AuthError, type AuthVerifier, extractEmbeddedSolanaWallets, extractVerifiedExternalSolanaWallets } from './auth.ts'
import { InMemoryCampaignRepository, type StoredCampaign } from './campaign-repo.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { type FundingService, FundingRequestError } from './funding-service.ts'

// Arbitrary valid addresses used only as test inputs.
const CREATOR = '11111111111111111111111111111112'
const OTHER_WALLET = '11111111111111111111111111111113'
const MINT = SUPPORTED_XSTOCKS[0]!.mint

function fakeAuth(wallets: string[]): AuthVerifier {
  return {
    async verifyAccessToken(token) {
      if (token !== 'good-token') throw new AuthError('invalid or expired Privy access token')
      return { privyUserId: 'did:privy:test', sessionId: 's1' }
    },
    async getVerifiedExternalSolanaWallets() {
      return wallets
    },
    async getEmbeddedSolanaWallets() {
      return []
    },
  }
}

/** RPC stub: getAccountInfo returns null (account absent) unless `exists` is set. */
function fakeRpc(exists = false): Rpc<GetAccountInfoApi> {
  return {
    getAccountInfo: () => ({
      send: async () => ({
        context: { slot: 1n },
        value: exists
          ? { data: ['', 'base64'], executable: false, lamports: 1n, owner: CREATOR, rentEpoch: 0n, space: 0n }
          : null,
      }),
    }),
  } as unknown as Rpc<GetAccountInfoApi>
}

// Mechanics tests; the xStocks eligibility gate is tested in claims.test.ts.
const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
let app: ReturnType<typeof buildApp>
afterEach(async () => app?.close())

const ASSETS = SUPPORTED_XSTOCKS.map(({ symbol, name, mint, decimals, logo }) => ({ symbol, name, mint, decimals, logo, isTest: false }))

function build(
  opts: { wallets?: string[]; exists?: boolean; funding?: FundingService; repo?: InMemoryCampaignRepository; auth?: AuthVerifier } = {},
) {
  app = buildApp({
    env,
    auth: opts.auth ?? fakeAuth(opts.wallets ?? [CREATOR]),
    campaigns: opts.repo ?? new InMemoryCampaignRepository(),
    rpc: fakeRpc(opts.exists),
    assets: ASSETS,
    funding: opts.funding,
  })
  return app
}

const post = (body: unknown, headers: Record<string, string> = { authorization: 'Bearer good-token' }) =>
  app.inject({ method: 'POST', url: '/v1/campaigns', payload: body as object, headers })

describe('POST /v1/campaigns', () => {
  const body = { type: 'TAP_RUSH', mint: MINT, allowanceRaw: '1000000', rewardPerClaimRaw: '1' }

  it('401 without a valid Privy token', async () => {
    build()
    expect((await post(body, {})).statusCode).toBe(401)
    expect((await post(body, { authorization: 'Bearer bad' })).statusCode).toBe(401)
  })

  it('creates a DRAFT with a server-derived campaign account', async () => {
    build()
    const res = await post(body)
    expect(res.statusCode).toBe(201)
    const { campaign } = res.json()
    expect(campaign.status).toBe('DRAFT')
    expect(campaign.creatorWallet).toBe(CREATOR)
    expect(campaign.campaignSeed).toBe(campaign.id.replaceAll('-', ''))
    expect(campaign.campaignTokenAccount).toBe(
      await deriveCampaignTokenAccount({ creator: address(CREATOR), campaignSeed: campaign.campaignSeed }),
    )
  })

  it('rejects client-supplied creatorWallet / campaign account in the body', async () => {
    build()
    expect((await post({ ...body, creatorWallet: OTHER_WALLET })).statusCode).toBe(400)
    expect((await post({ ...body, campaignTokenAccount: OTHER_WALLET })).statusCode).toBe(400)
  })

  it('403 when the user has no SIWS-verified wallet', async () => {
    build({ wallets: [] })
    expect((await post(body)).statusCode).toBe(403)
  })

  it('403 when X-Creator-Wallet is not one of the verified wallets', async () => {
    build({ wallets: [CREATOR] })
    const res = await post(body, { authorization: 'Bearer good-token', 'x-creator-wallet': OTHER_WALLET })
    expect(res.statusCode).toBe(403)
  })

  it('requires explicit selection when several wallets are verified', async () => {
    build({ wallets: [CREATOR, OTHER_WALLET] })
    expect((await post(body)).statusCode).toBe(403)
    const res = await post(body, { authorization: 'Bearer good-token', 'x-creator-wallet': OTHER_WALLET })
    expect(res.statusCode).toBe(201)
    expect(res.json().campaign.creatorWallet).toBe(OTHER_WALLET)
  })

  it('422 for an unsupported mint', async () => {
    build()
    expect((await post({ ...body, mint: OTHER_WALLET })).statusCode).toBe(422)
  })

  it('409 and stops if the derived account already exists', async () => {
    build({ exists: true })
    const res = await post(body)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('DERIVED_ACCOUNT_EXISTS')
  })
})

describe('extractEmbeddedSolanaWallets', () => {
  it('keeps only Privy embedded Solana wallets', () => {
    expect(
      extractEmbeddedSolanaWallets([
        { type: 'wallet', chain_type: 'solana', wallet_client: 'privy', connector_type: 'embedded', address: 'E' },
        { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address: 'X', verified_at: 1 },
        { type: 'wallet', chain_type: 'ethereum', wallet_client: 'privy', address: '0x' },
      ]),
    ).toEqual(['E'])
  })
})

describe('extractVerifiedExternalSolanaWallets', () => {
  it('keeps only verified external Solana wallets', () => {
    expect(
      extractVerifiedExternalSolanaWallets([
        { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address: 'A', verified_at: 1 },
        { type: 'wallet', chain_type: 'solana', wallet_client: 'privy', connector_type: 'embedded', address: 'B', verified_at: 1 },
        { type: 'wallet', chain_type: 'ethereum', wallet_client: 'unknown', address: 'C', verified_at: 1 },
        { type: 'email', address: 'x@y.z', verified_at: 1 },
        { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address: 'D', verified_at: 0 },
        null,
      ]),
    ).toEqual(['A'])
  })

  it('lists the most recently linked wallet first (the app funds from the first one)', () => {
    expect(
      extractVerifiedExternalSolanaWallets([
        { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address: 'OLD', verified_at: 100 },
        { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address: 'NEW', verified_at: 200 },
      ]),
    ).toEqual(['NEW', 'OLD'])
  })
})

describe('read endpoints', () => {
  it('GET /v1/campaigns lists only LIVE campaigns (none by default)', async () => {
    build()
    await post({ type: 'GIFT', mint: MINT, allowanceRaw: '1', rewardPerClaimRaw: '1' })
    const res = await app.inject({ method: 'GET', url: '/v1/campaigns' })
    expect(res.statusCode).toBe(200)
    expect(res.json().campaigns).toEqual([])
  })

  it('GET /v1/campaigns hides LIVE drops from another network and drops past their end', async () => {
    const repo = new InMemoryCampaignRepository()
    build({ repo })
    const base = { type: 'GIFT' as const, creatorPrivyUserId: 'did:privy:test', creatorWallet: CREATOR, mint: MINT, xstockSymbol: 'NVDAx', allowanceRaw: 1n, rewardPerClaimRaw: 1n, tapRush: null }
    const live = async (id: string, extra: { cluster: 'devnet' | 'mainnet-beta'; endsAt?: Date }) => {
      const c = await repo.create({ ...base, id, campaignSeed: id, campaignTokenAccount: `acct-${id}`, ...extra })
      c.status = 'LIVE'
    }
    await live('here-open', { cluster: env.SOLANA_CLUSTER as 'devnet' })
    await live('here-later', { cluster: env.SOLANA_CLUSTER as 'devnet', endsAt: new Date(Date.now() + 3_600_000) })
    await live('here-ended', { cluster: env.SOLANA_CLUSTER as 'devnet', endsAt: new Date(Date.now() - 1000) })
    await live('other-network', { cluster: 'mainnet-beta' })
    const res = await app.inject({ method: 'GET', url: '/v1/campaigns' })
    expect(res.json().campaigns.map((c: { id: string }) => c.id).sort()).toEqual(['here-later', 'here-open'])
  })

  it('GET /v1/me requires auth and returns verified wallets', async () => {
    build()
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401)
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer good-token' } })
    expect(res.json()).toEqual({ privyUserId: 'did:privy:test', verifiedCreatorWallets: [CREATOR] })
  })

  it('GET /v1/me/campaigns returns only my campaigns, newest first', async () => {
    build()
    const a = (await post({ type: 'GIFT', mint: MINT, allowanceRaw: '1', rewardPerClaimRaw: '1' })).json().campaign.id
    await new Promise((r) => setTimeout(r, 5))
    const b = (await post({ type: 'TAP_RUSH', mint: MINT, allowanceRaw: '2', rewardPerClaimRaw: '1' })).json().campaign.id
    const res = await app.inject({ method: 'GET', url: '/v1/me/campaigns', headers: { authorization: 'Bearer good-token' } })
    expect(res.json().campaigns.map((c: { id: string }) => c.id)).toEqual([b, a])
  })

  it('GET /v1/xstocks returns null market fields without a market source', async () => {
    build()
    const res = await app.inject({ method: 'GET', url: '/v1/xstocks' })
    expect(res.json().xstocks[0]).toMatchObject({ multiplier: null, paused: null })
  })
})

describe('GET /v1/me/holdings', () => {
  it('requires auth', async () => {
    build()
    expect((await app.inject({ method: 'GET', url: '/v1/me/holdings' })).statusCode).toBe(401)
  })
  it('reports unavailable without a read source, listing verified wallets only', async () => {
    build()
    const res = await app.inject({ method: 'GET', url: '/v1/me/holdings', headers: { authorization: 'Bearer good-token' } })
    expect(res.json()).toEqual({ available: false, wallets: [{ wallet: CREATOR, kind: 'creator', balances: null }] })
  })
})

describe('funding routes', () => {
  const body = { type: 'TAP_RUSH', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '1' }
  const auth = { authorization: 'Bearer good-token' }
  const signed = { signedTransaction: 'A'.repeat(200) }

  function fakeFunding(opts: { live?: boolean; submitError?: FundingRequestError } = {}): FundingService & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async prepare(c: StoredCampaign) {
        calls.push('prepare')
        return {
          transaction: 'AAAA',
          minContextSlot: '1',
          summary: {
            campaignAccount: c.campaignTokenAccount,
            delegate: CREATOR,
            amountRaw: c.allowanceRaw.toString(),
            rentLamports: '1',
            accountSpace: '175',
          },
        }
      },
      async submit() {
        calls.push('submit')
        if (opts.submitError) throw opts.submitError
        return { signature: 'sig' }
      },
      async verify() {
        calls.push('verify')
        return { live: opts.live ?? true, status: { problems: [] } as never }
      },
    }
  }

  const url = (id: string, step: string) => `/v1/campaigns/${id}/funding/${step}`

  it('prepare → submit → LIVE when verified onchain', async () => {
    const funding = fakeFunding()
    build({ funding })
    const id = (await post(body)).json().campaign.id
    expect((await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/v1/campaigns/${id}` })).json().campaign.status).toBe('AWAITING_FUNDING')
    const sub = await app.inject({ method: 'POST', url: url(id, 'submit'), headers: auth, payload: signed })
    expect(sub.statusCode).toBe(200)
    expect(sub.json()).toMatchObject({ signature: 'sig', verified: true, campaign: { status: 'LIVE' } })
    expect(funding.calls).toEqual(['prepare', 'submit', 'verify'])
  })

  it('stays AWAITING_FUNDING when onchain state does not verify', async () => {
    build({ funding: fakeFunding({ live: false }) })
    const id = (await post(body)).json().campaign.id
    await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })
    const sub = await app.inject({ method: 'POST', url: url(id, 'submit'), headers: auth, payload: signed })
    expect(sub.json()).toMatchObject({ verified: false, campaign: { status: 'AWAITING_FUNDING' } })
  })

  it('only the creator can fund; anyone else gets 404', async () => {
    const repo = new InMemoryCampaignRepository()
    build({ funding: fakeFunding(), repo })
    const id = (await post(body)).json().campaign.id
    await app.close()

    // Same repository, different authenticated user.
    const intruder: AuthVerifier = {
      async verifyAccessToken() {
        return { privyUserId: 'did:privy:someone-else', sessionId: 's' }
      },
      async getVerifiedExternalSolanaWallets() {
        return [OTHER_WALLET]
      },
      async getEmbeddedSolanaWallets() {
        return []
      },
    }
    build({ funding: fakeFunding(), repo, auth: intruder })
    const res = await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })
    expect(res.statusCode).toBe(404)
  })

  it('rejects a malformed signed transaction body', async () => {
    build({ funding: fakeFunding() })
    const id = (await post(body)).json().campaign.id
    await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })
    const res = await app.inject({ method: 'POST', url: url(id, 'submit'), headers: auth, payload: { signedTransaction: 'not base64!' } })
    expect(res.statusCode).toBe(400)
  })

  it('surfaces funding errors with their code and HTTP status', async () => {
    build({ funding: fakeFunding({ submitError: new FundingRequestError('TRANSACTION_MISMATCH', 'differs', 400) }) })
    const id = (await post(body)).json().campaign.id
    await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })
    const res = await app.inject({ method: 'POST', url: url(id, 'submit'), headers: auth, payload: signed })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('TRANSACTION_MISMATCH')
  })

  it('cannot submit before prepare', async () => {
    build({ funding: fakeFunding() })
    const id = (await post(body)).json().campaign.id
    const res = await app.inject({ method: 'POST', url: url(id, 'submit'), headers: auth, payload: signed })
    expect(res.statusCode).toBe(409)
  })

  it('503 when funding is not configured', async () => {
    build()
    const id = (await post(body)).json().campaign.id
    expect((await app.inject({ method: 'POST', url: url(id, 'prepare'), headers: auth })).statusCode).toBe(503)
  })
})

describe('creator wind-down: close a drop (W-1)', () => {
  const auth = { authorization: 'Bearer good-token' }
  const signed = { signedTransaction: 'A'.repeat(200) }

  function closer(closed = true): FundingService & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      prepare: async () => ({ transaction: 'AAAA', minContextSlot: '1', summary: { campaignAccount: 'a', delegate: CREATOR, amountRaw: '1', rentLamports: '1', accountSpace: '175' } }),
      submit: async () => ({ signature: 'sig' }),
      verify: async () => ({ live: true, status: { problems: [] } as never }),
      prepareClose: async (c: StoredCampaign) => {
        calls.push(`prepareClose:${c.status}`)
        return { transaction: 'BBBB', minContextSlot: '1', summary: { campaignAccount: c.campaignTokenAccount, returnRaw: '600', rentLamports: '1539240', revokesDelegate: true } }
      },
      submitClose: async () => {
        calls.push('submitClose')
        return { signature: 'closesig', closed }
      },
    }
  }

  async function liveDrop(repo: InMemoryCampaignRepository) {
    build({ repo, funding: closer() })
    const id = (await post({ type: 'TAP_RUSH', mint: MINT, allowanceRaw: '1000', rewardPerClaimRaw: '100' })).json().campaign.id
    await repo.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
    await repo.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await repo.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
    await app.close()
    return id
  }

  it('ends the drop, then closes it after the creator signs; only the creator can', async () => {
    const repo = new InMemoryCampaignRepository()
    const id = await liveDrop(repo)
    const funding = closer()
    build({ repo, funding })
    const url = (step: string) => `/v1/campaigns/${id}/close/${step}`
    expect((await app.inject({ method: 'POST', url: url('prepare'), headers: { authorization: 'Bearer other-token' } })).statusCode).toBe(401)
    const prep = await app.inject({ method: 'POST', url: url('prepare'), headers: auth })
    expect(prep.statusCode).toBe(200)
    expect(prep.json()).toMatchObject({ campaign: { status: 'ENDED' }, prepared: { summary: { returnRaw: '600', revokesDelegate: true } } })
    expect(funding.calls).toEqual(['prepareClose:ENDED'])
    const sub = await app.inject({ method: 'POST', url: url('submit'), headers: auth, payload: signed })
    expect(sub.json()).toMatchObject({ signature: 'closesig', closed: true, campaign: { status: 'CLOSED' } })
    expect((await app.inject({ method: 'POST', url: url('prepare'), headers: auth })).json().error.code).toBe('WRONG_STATUS')
  })

  it('refuses to close while a reward is still being sent', async () => {
    const repo = new InMemoryCampaignRepository()
    const id = await liveDrop(repo)
    const claims = new InMemoryClaimRepository(repo)
    await claims.reserve({ campaignId: id, privyUserId: 'did:privy:someone', recipientWallet: 'w', amountRaw: 100n, tapSessionId: null })
    app = buildApp({ env, auth: fakeAuth([CREATOR]), campaigns: repo, claims, rpc: fakeRpc(false), assets: ASSETS, funding: closer() })
    const res = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/close/prepare`, headers: auth })
    expect(res.json().error.code).toBe('PAYOUTS_IN_FLIGHT')
    // The drop is already ended, so no new reward can be reserved meanwhile.
    expect((await app.inject({ method: 'GET', url: `/v1/campaigns/${id}` })).json().campaign.status).toBe('ENDED')
  })

  it('stays ENDED (not CLOSED) if the account is still there after the transaction', async () => {
    const repo = new InMemoryCampaignRepository()
    const id = await liveDrop(repo)
    build({ repo, funding: closer(false) })
    await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/close/prepare`, headers: auth })
    const sub = await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/close/submit`, headers: auth, payload: signed })
    expect(sub.json()).toMatchObject({ closed: false, campaign: { status: 'ENDED' } })
  })
})

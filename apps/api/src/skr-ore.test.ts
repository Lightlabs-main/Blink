import { readFileSync } from 'node:fs'

import { ConfigError, loadEnv } from '@blink/config'
import type { RpcJsonTransaction, TokenBalanceTx } from '@blink/solana'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import {
  appendTransactionMessageInstructions,
  type createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type GetAccountInfoApi,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository, type NewCampaign } from './campaign-repo.ts'
import { InMemoryChainActivityStore } from './chain-activity-store.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { InMemoryProfileStore } from './profile.ts'
import { resolveSkrIdentity, type SkrNameResolver } from './skr-identity.ts'
import { memberRef } from './social-routes.ts'
import { InMemorySocialStore } from './social-store.ts'
import type { WalletTxRelay } from './wallet-relay.ts'

const fixture = <T>(name: string) => JSON.parse(readFileSync(new URL(`../../../packages/solana/src/__fixtures__/${name}`, import.meta.url), 'utf8')) as T
const ORE_TX = fixture<RpcJsonTransaction>('ore-deploy-tx.json')
const SKR_TX = fixture<TokenBalanceTx>('skr-transfer-tx.json')
const ORE_SIG = (ORE_TX as unknown as { transaction: { signatures: string[] } }).transaction.signatures[0]!
const ORE_WALLET = ORE_TX.transaction.message.accountKeys[0]!
const SKR_ROWS = [...(SKR_TX.meta!.preTokenBalances ?? []), ...(SKR_TX.meta!.postTokenBalances ?? [])].filter((r) => r.mint === 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3')
const SKR_DELTA = (owner: string) =>
  (SKR_TX.meta!.postTokenBalances ?? []).filter((r) => r.owner === owner && r.mint === SKR_ROWS[0]!.mint).reduce((a, r) => a + BigInt(r.uiTokenAmount.amount), 0n) -
  (SKR_TX.meta!.preTokenBalances ?? []).filter((r) => r.owner === owner && r.mint === SKR_ROWS[0]!.mint).reduce((a, r) => a + BigInt(r.uiTokenAmount.amount), 0n)
const SKR_OWNERS = [...new Set(SKR_ROWS.map((r) => r.owner!))]
const SKR_FROM = SKR_OWNERS.find((o) => SKR_DELTA(o) < 0n)!
const SKR_TO = SKR_OWNERS.find((o) => SKR_DELTA(o) > 0n)!
const SKR_AMOUNT = SKR_DELTA(SKR_TO)

const base = { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com', SOLANA_CLUSTER: 'mainnet-beta', MAINNET_ENABLED: 'true', XSTOCK_COMPLIANCE: 'enforce' }
const as = (u: string) => ({ authorization: `Bearer ${u}` })

/** Verified (SIWS) wallets per test user; alice holds the real fixtures' wallets. */
const wallets: Record<string, string[]> = { alice: [ORE_WALLET, SKR_FROM], bob: [SKR_TO], creator: [SKR_FROM] }
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async (u) => wallets[u.replace('did:privy:', '')] ?? [],
  getEmbeddedSolanaWallets: async () => [],
}

/** The relay is the only part that talks to the network; here it replays the real transactions. */
function fakeRelay(): WalletTxRelay {
  return {
    remember: () => {},
    forget: () => {},
    relay: async () => ORE_SIG,
    confirmedTransaction: async (sig: string) => (sig === ORE_SIG ? ORE_TX : SKR_TX),
  } as unknown as WalletTxRelay
}

let app: FastifyInstance
let store: InMemoryChainActivityStore
let campaigns: InMemoryCampaignRepository
let social: InMemorySocialStore
let profiles: InMemoryProfileStore

function build(extraEnv: Record<string, string> = {}) {
  const env = loadEnv({ ...base, ...extraEnv })
  campaigns = new InMemoryCampaignRepository()
  store = new InMemoryChainActivityStore()
  social = new InMemorySocialStore()
  profiles = new InMemoryProfileStore()
  app = buildApp({
    env, auth, campaigns, claims: new InMemoryClaimRepository(campaigns), profiles, social, rpc: {} as Rpc<GetAccountInfoApi>, assets: [],
    chain: { store, rpc: {} as ReturnType<typeof createSolanaRpc>, relay: fakeRelay() },
  })
}

async function liveCampaign(overrides: Partial<NewCampaign> = {}) {
  const id = crypto.randomUUID()
  await campaigns.create({
    id, type: 'GIFT', cluster: 'mainnet-beta', creatorPrivyUserId: 'did:privy:creator', creatorWallet: SKR_FROM, mint: SUPPORTED_XSTOCKS[0]!.mint,
    xstockSymbol: 'NVDAx', campaignSeed: 'seed', campaignTokenAccount: id, allowanceRaw: 100n, rewardPerClaimRaw: 10n, tapRush: null, ...overrides,
  })
  await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
  await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
  return (await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE'))!
}

/** A decodable signed transaction (self-transfer, random key): only its first signature matters to the routes. */
async function signedTx(): Promise<string> {
  const signer = await generateKeyPairSigner()
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 1n }, m),
    (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: signer, destination: signer.address, amount: 1n })], m),
  )
  return getBase64EncodedWireTransaction(await signTransactionMessageWithSigners(msg))
}

const post = (u: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: as(u), payload })
const get = (u: string, url: string) => app.inject({ method: 'GET', url, headers: as(u) })

describe('config gates (D-49..D-51)', () => {
  it('refuses to start ORE deploys without a cap and boosts without an owner-approved package', () => {
    expect(() => loadEnv({ ...base, ORE_DEPLOY_ENABLED: 'true' })).toThrow(ConfigError)
    expect(() => loadEnv({ ...base, SKR_BOOST_ENABLED: 'true', SKR_BOOST_PRICE_RAW: '1000000' })).toThrow(ConfigError)
    expect(() => loadEnv({ ...base, SKR_BOOST_ENABLED: 'true', SKR_BOOST_PRICE_RAW: '1000000', SKR_BOOST_HOURS: '6', SKR_BOOST_DESTINATION: SKR_TO })).not.toThrow()
  })

  it('exposes only enabled features; everything spends nothing by default', async () => {
    build()
    const f = (await app.inject({ method: 'GET', url: '/v1/features' })).json()
    expect(f).toMatchObject({ tips: { enabled: false }, boost: { enabled: false }, ore: { deployEnabled: false, rewardsEnabled: false } })
    expect((await post('alice', '/v1/ore/deploy/prepare', { squares: [1], amountLamports: '10000' })).json().error.code).toBe('ORE_DEPLOY_DISABLED')
    expect((await post('alice', '/v1/clubs/x/tips/prepare', { to: '0'.repeat(16), amountRaw: '1' })).json().error.code).toBe('SKR_TIPS_DISABLED')
    expect((await post('creator', `/v1/campaigns/${crypto.randomUUID()}/boost/prepare`)).json().error.code).toBe('SKR_BOOST_DISABLED')
  })
})

describe('ORE deploy verification route (real mainnet deploy)', () => {
  beforeEach(() => build())

  it('records a verified deploy once, awards the ORE Miner mark and adds receipts', async () => {
    const res = await post('alice', '/v1/ore/deploy/verify', { signature: ORE_SIG })
    expect(res.statusCode).toBe(200)
    const d = res.json().deploy
    expect(d).toMatchObject({ signature: ORE_SIG, created: true, minerMark: true, network: 'Solana Mainnet' })
    expect(d.squares.length).toBeGreaterThan(0)
    expect((await profiles.get('did:privy:alice'))?.og).toContain('ORE')
    // Idempotent: verifying again creates nothing new.
    expect((await post('alice', '/v1/ore/deploy/verify', { signature: ORE_SIG })).json().deploy.created).toBe(false)
    const history = (await get('alice', '/v1/me/history')).json().items as { kind: string; details?: { roundId?: string } }[]
    expect(history.filter((h) => h.kind === 'ORE_DEPLOY_CONFIRMED')).toHaveLength(1)
    expect(history.find((h) => h.kind === 'ORE_DEPLOY_CONFIRMED')?.details?.roundId).toBe(d.roundId)
    expect(history.some((h) => h.kind === 'ORE_MINER_VERIFIED')).toBe(true)
    expect((await get('alice', '/v1/ore/me')).json()).toMatchObject({ verifiedDeploys: 1, minerMark: true })
  })

  it('refuses a deploy by someone else’s wallet and replays across accounts', async () => {
    expect((await post('bob', '/v1/ore/deploy/verify', { signature: ORE_SIG })).json().error.code).toBe('ORE_WRONG_AUTHORITY')
    expect((await profiles.get('did:privy:bob'))?.og ?? []).not.toContain('ORE')
    await post('alice', '/v1/ore/deploy/verify', { signature: ORE_SIG })
    // Same signature presented by another account that (hypothetically) also lists the wallet.
    wallets.mallory = [ORE_WALLET]
    expect((await post('mallory', '/v1/ore/deploy/verify', { signature: ORE_SIG })).json().error.code).toBe('SIGNATURE_REUSED')
  })

  it('never lets an ORE mining quest carry an xStock reward without owner approval', async () => {
    const res = await post('creator', '/v1/campaigns', {
      type: 'VERIFIED_QUEST', mint: SUPPORTED_XSTOCKS[0]!.mint, allowanceRaw: '1000', rewardPerClaimRaw: '100',
      requirements: { eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'ORE_ACTIVITY' }] }] },
    })
    expect(res.json().error.code).toBe('ORE_REWARDS_DISABLED')
  })
})

describe('SKR tips (real mainnet transfer)', () => {
  beforeEach(() => build({ SKR_TIPS_ENABLED: 'true' }))

  it('confirms a tip only from the verified transfer, once, and shows it to both people', async () => {
    const tip = await store.createTip({
      id: crypto.randomUUID(), senderPrivyUserId: 'did:privy:alice', recipientPrivyUserId: 'did:privy:bob', senderWallet: SKR_FROM, recipientWallet: SKR_TO,
      clubId: null, amountRaw: SKR_AMOUNT, cluster: 'mainnet-beta',
    })
    const tx = await signedTx()
    // Someone else can't submit alice's tip.
    expect((await post('bob', `/v1/skr/tips/${tip.id}/submit`, { signedTransaction: tx })).statusCode).toBe(404)
    const res = await post('alice', `/v1/skr/tips/${tip.id}/submit`, { signedTransaction: tx })
    expect(res.statusCode).toBe(200)
    expect(res.json().tip).toMatchObject({ status: 'CONFIRMED', direction: 'SENT', amountRaw: SKR_AMOUNT.toString() })
    // Re-submitting returns the same confirmed tip; the same signature can't back another tip.
    expect((await post('alice', `/v1/skr/tips/${tip.id}/submit`, { signedTransaction: tx })).json().tip.status).toBe('CONFIRMED')
    const other = await store.createTip({ ...tip, id: crypto.randomUUID() })
    expect((await post('alice', `/v1/skr/tips/${other.id}/submit`, { signedTransaction: tx })).json().error.code).toBe('SIGNATURE_REUSED')
    expect((await get('bob', '/v1/me/history')).json().items.some((i: { kind: string }) => i.kind === 'SKR_TIP_RECEIVED')).toBe(true)
    expect((await get('alice', '/v1/me/history')).json().items.some((i: { kind: string }) => i.kind === 'SKR_TIP_SENT')).toBe(true)
  })

  it('fails a tip whose confirmed transfer does not match (wrong amount)', async () => {
    const tip = await store.createTip({
      id: crypto.randomUUID(), senderPrivyUserId: 'did:privy:alice', recipientPrivyUserId: 'did:privy:bob', senderWallet: SKR_FROM, recipientWallet: SKR_TO,
      clubId: null, amountRaw: SKR_AMOUNT + 1n, cluster: 'mainnet-beta',
    })
    expect((await post('alice', `/v1/skr/tips/${tip.id}/submit`, { signedTransaction: await signedTx() })).json().error.code).toBe('TIP_NOT_VERIFIED')
    expect((await store.getTip(tip.id))?.status).toBe('FAILED')
    expect((await get('bob', '/v1/me/history')).json().items.some((i: { kind: string }) => i.kind === 'SKR_TIP_RECEIVED')).toBe(false)
  })

  it('checks club membership, the target and self-tips before building anything', async () => {
    const club = await social.createClub({ id: crypto.randomUUID(), slug: 'tips-club', name: 'Tips club', description: 'd', category: 'COMMUNITY', tags: [], visibility: 'PUBLIC', inviteCode: 'ABCDEFGH', rules: [] } as never, { privyUserId: 'did:privy:alice', publicWallet: null })
    await social.join(club.id, 'did:privy:bob', null)
    expect((await post('carol', '/v1/clubs/tips-club/tips/prepare', { to: memberRef(club.id, 'did:privy:bob'), amountRaw: '1000000' })).json().error.code).toBe('NOT_A_MEMBER')
    expect((await post('alice', '/v1/clubs/tips-club/tips/prepare', { to: memberRef(club.id, 'did:privy:alice'), amountRaw: '1000000' })).json().error.code).toBe('SELF_TIP')
    expect((await post('alice', '/v1/clubs/tips-club/tips/prepare', { to: 'f'.repeat(16), amountRaw: '1000000' })).json().error.code).toBe('NOT_FOUND')
    expect((await post('alice', '/v1/clubs/tips-club/tips/prepare', { to: memberRef(club.id, 'did:privy:bob'), amountRaw: '10000000001' })).json().error.code).toBe('SKR_TIP_TOO_LARGE')
  })
})

describe('SKR boosts (D-50)', () => {
  const pkg = { SKR_BOOST_ENABLED: 'true', SKR_BOOST_PRICE_RAW: SKR_AMOUNT.toString(), SKR_BOOST_HOURS: '6', SKR_BOOST_DESTINATION: SKR_TO }
  beforeEach(() => build(pkg))

  it('activates once from the verified payment, features the drop, and never for other drops', async () => {
    const a = await liveCampaign()
    const b = await liveCampaign()
    const boost = await store.createBoost({ id: crypto.randomUUID(), campaignId: a.id, payerPrivyUserId: 'did:privy:creator', payerWallet: SKR_FROM, destination: SKR_TO, amountRaw: SKR_AMOUNT, hours: 6, cluster: 'mainnet-beta' })
    const res = await post('creator', `/v1/campaigns/${a.id}/boost/${boost.id}/submit`, { signedTransaction: await signedTx() })
    expect(res.statusCode).toBe(200)
    const out = res.json().boost
    expect(out.status).toBe('CONFIRMED')
    expect(Date.parse(out.endsAt) - Date.parse(out.startsAt)).toBe(6 * 3_600_000)
    const list = (await app.inject({ method: 'GET', url: '/v1/campaigns' })).json().campaigns as { id: string; boostedUntil: string | null }[]
    expect(list[0]).toMatchObject({ id: a.id, boostedUntil: out.endsAt })
    expect(list.find((c) => c.id === b.id)?.boostedUntil).toBeNull()
    expect((await get('creator', '/v1/me/history')).json().items.find((i: { kind: string }) => i.kind === 'SKR_BOOST_PURCHASED')).toMatchObject({ status: 'CONFIRMED', details: { endsAt: out.endsAt } })
  })

  it('stacks a second boost after the first, expires on server time and refuses non-creators and ended drops', async () => {
    const a = await liveCampaign()
    const now = new Date('2026-10-10T00:00:00Z')
    const one = await store.createBoost({ id: crypto.randomUUID(), campaignId: a.id, payerPrivyUserId: 'did:privy:creator', payerWallet: SKR_FROM, destination: SKR_TO, amountRaw: 1n, hours: 6, cluster: 'mainnet-beta' })
    const two = await store.createBoost({ ...one, id: crypto.randomUUID() })
    await store.markBoostSubmitted(one.id, 'sigA')
    await store.markBoostSubmitted(two.id, 'sigB')
    const first = await store.activateBoost(one.id, now)
    const second = await store.activateBoost(two.id, now)
    expect(second.startsAt).toEqual(first.endsAt)
    expect((await store.activateBoost(one.id, new Date())).endsAt).toEqual(first.endsAt)
    expect((await store.activeBoosts([a.id], new Date(now.getTime() + 11 * 3_600_000))).get(a.id)).toEqual(second.endsAt)
    expect((await store.activeBoosts([a.id], new Date(now.getTime() + 12 * 3_600_000 + 1))).size).toBe(0)
    await expect(store.markBoostSubmitted(two.id, 'sigA')).rejects.toThrow('signature already recorded')

    expect((await post('bob', `/v1/campaigns/${a.id}/boost/prepare`)).json().error.code).toBe('NOT_CREATOR')
    const ended = await liveCampaign({ endsAt: new Date(Date.now() - 1000) })
    expect((await post('creator', `/v1/campaigns/${ended.id}/boost/prepare`)).json().error.code).toBe('BOOST_NOT_LIVE')
  })
})

describe('.skr identity (D-52)', () => {
  const resolver = (names: Record<string, string[]>, owners: Record<string, string | null>, fail = false): SkrNameResolver => ({
    namesOf: async (w) => {
      if (fail) throw new Error('rpc down')
      return names[w] ?? []
    },
    ownerOf: async (n) => owners[n] ?? null,
  })

  it('binds a name only when reverse and forward resolution agree for a verified wallet', async () => {
    expect(await resolveSkrIdentity(resolver({ W1: ['maris.skr'] }, { 'maris.skr': 'W1' }), ['W1'])).toEqual({ status: 'VERIFIED', name: 'maris.skr', wallet: 'W1' })
    // Forward points elsewhere (stale or spoofed record): not bound.
    expect(await resolveSkrIdentity(resolver({ W1: ['maris.skr'] }, { 'maris.skr': 'W2' }), ['W1'])).toEqual({ status: 'NONE' })
    expect(await resolveSkrIdentity(resolver({}, {}), ['W1'])).toEqual({ status: 'NONE' })
    expect(await resolveSkrIdentity(resolver({}, {}), [])).toEqual({ status: 'NONE' })
    // RPC failure is "unable to verify", never a verdict.
    expect(await resolveSkrIdentity(resolver({}, {}, true), ['W1'])).toEqual({ status: 'UNAVAILABLE' })
  })

  it('shows the verified name in public views and keeps the Blink username', async () => {
    build()
    await profiles.setUsername('did:privy:alice', 'maris')
    await profiles.setSkr('did:privy:alice', { name: 'maris.skr', wallet: ORE_WALLET })
    const p = (await get('alice', '/v1/me/profile')).json()
    expect(p.profile).toMatchObject({ username: 'maris', skrName: 'maris.skr' })
  })
})

import { loadEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import { buildApp } from './app.ts'
import type { AuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'
import { InMemoryClaimRepository } from './claim-repo.ts'
import { QuestService } from './quest-service.ts'
import { InMemoryXTaskStore, parsePostUrl, postTextFromEmbed, postTime, type XPostReader } from './x-quest.ts'

const env = loadEnv({ SOLANA_RPC_URL: 'https://api.devnet.solana.com', XSTOCK_COMPLIANCE: 'off' })
const auth: AuthVerifier = {
  verifyAccessToken: async (token) => ({ privyUserId: `did:privy:${token}`, sessionId: 's' }),
  getVerifiedExternalSolanaWallets: async () => [],
  getEmbeddedSolanaWallets: async (u) => [`wallet-${u}`],
}
/** A post id minted "now" (snowflake: ms since X's epoch << 22). */
const nowId = () => ((BigInt(Date.now()) - 1288834974657n) << 22n).toString()

describe('X post links (D-39)', () => {
  it('parses x.com / twitter.com status links and post times', () => {
    expect(parsePostUrl('https://x.com/Maris/status/1840000000000000000?s=20')).toEqual({ handle: 'maris', postId: '1840000000000000000', url: 'https://x.com/Maris/status/1840000000000000000' })
    expect(parsePostUrl('https://mobile.twitter.com/a_b/status/123456')?.handle).toBe('a_b')
    expect(parsePostUrl('https://evil.com/x.com/a/status/1')).toBeNull()
    expect(parsePostUrl('https://x.com/a/likes')).toBeNull()
    expect(postTime('20').getUTCFullYear()).toBe(2010)
    expect(postTextFromEmbed('<blockquote><p lang="en">Hi &amp; <a href="#">#Blink</a> BLINK-ABC234</p>&mdash; M</blockquote>')).toBe('Hi & #Blink BLINK-ABC234')
  })

  it('verifies a public post with the person’s code, once per X account per drop', async () => {
    const campaigns = new InMemoryCampaignRepository()
    const claims = new InMemoryClaimRepository(campaigns)
    const xTasks = new InMemoryXTaskStore()
    const posts = new Map<string, { authorHandle: string; text: string }>()
    const xReader: XPostReader = { read: async (url) => (posts.has(url) ? { ok: true, post: posts.get(url)! } : { ok: false, reason: 'NOT_FOUND' }) }
    const app = buildApp({ env, auth, campaigns, claims, rpc: {} as Rpc<GetAccountInfoApi>, assets: [], xTasks, xReader, quests: new QuestService({ auth, claims, xTasks }) })
    const id = crypto.randomUUID()
    await campaigns.create({
      id, type: 'VERIFIED_QUEST', cluster: 'devnet', creatorPrivyUserId: 'did:privy:creator', creatorWallet: '11111111111111111111111111111112',
      mint: SUPPORTED_XSTOCKS[0]!.mint, xstockSymbol: 'NVDAx', campaignSeed: 'seed', campaignTokenAccount: 'acct', allowanceRaw: 100n, rewardPerClaimRaw: 10n, tapRush: null,
      requirements: { eligibility: [], actions: [{ mode: 'ALL', conditions: [{ verifier: 'X_QUEST', mustInclude: '#Blink' }] }] },
    })
    await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
    await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
    await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
    const as = (u: string) => ({ authorization: `Bearer ${u}` })
    const task = (await app.inject({ method: 'GET', url: `/v1/campaigns/${id}/x-task`, headers: as('alice') })).json().task
    expect(task.code).toMatch(/^BLINK-[2-9A-Z]{6}$/)
    expect(task.suggestedText).toContain(task.code)

    const submit = (u: string, url: string) => app.inject({ method: 'POST', url: `/v1/campaigns/${id}/x-task`, headers: as(u), payload: { url } })
    const pid = nowId()
    const url = `https://x.com/alice/status/${pid}`
    expect((await submit('alice', 'https://x.com/alice')).json().error.code).toBe('X_URL_INVALID')
    expect((await submit('alice', url)).json().error.code).toBe('X_POST_NOT_FOUND')
    posts.set(url, { authorHandle: 'alice', text: `joining ${task.code}` })
    expect((await submit('alice', url)).json().error.code).toBe('X_TEXT_MISSING')
    posts.set(url, { authorHandle: 'alice', text: `joining #blink` })
    expect((await submit('alice', url)).json().error.code).toBe('X_CODE_MISSING')
    expect((await submit('alice', 'https://x.com/alice/status/1234567890123')).json().error.code).toBe('X_POST_TOO_OLD')
    posts.set(url, { authorHandle: 'alice', text: `joining #Blink ${task.code.toLowerCase()}` })
    expect((await submit('alice', url)).json().task).toMatchObject({ verified: true, authorHandle: 'alice' })

    // The quest now passes for Alice.
    const ev = (await app.inject({ method: 'POST', url: `/v1/campaigns/${id}/verify`, headers: as('alice') })).json().evaluation
    expect(ev.actions[0].results[0].status).toBe('PASSED')

    // Bob cannot reuse Alice's X account (one X account per drop).
    const bobCode = (await app.inject({ method: 'GET', url: `/v1/campaigns/${id}/x-task`, headers: as('bob') })).json().task.code
    const url2 = `https://x.com/alice/status/${(BigInt(pid) + 1n).toString()}`
    posts.set(url2, { authorHandle: 'alice', text: `#Blink ${bobCode}` })
    expect((await submit('bob', url2)).json().error.code).toBe('X_ACCOUNT_USED')
    await app.close()
  })
})

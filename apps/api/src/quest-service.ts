import {
  type OgType,
  combineQuest,
  type QuestRequirements,
  type ConditionResult,
  type QuestCondition,
  type QuestEvaluation,
  VERIFIERS,
} from '@blink/domain'
import {
  ORE_MINT,
  readMintDecimals,
  readOreBoardRound,
  readOreMinerRound,
  readOreStaked,
  readSkrStaked,
  readTokenBalance,
  SKR_MINT,
} from '@blink/solana'
import {
  address,
  type GetAccountInfoApi,
  type GetGenesisHashApi,
  type GetProgramAccountsApi,
  type GetTokenAccountsByOwnerApi,
  type Rpc,
} from '@solana/kit'

import type { AuthVerifier } from './auth.ts'
import type { StoredCampaign } from './campaign-repo.ts'
import type { ClaimRepository } from './claim-repo.ts'
import type { SeekerVerifier } from './claim-service.ts'
import type { SocialStore } from './social-store.ts'
import type { XTaskStore } from './x-quest.ts'

/** Mainnet-only protocol reads for Verified Quest (SKR, ORE). */
export interface ChainReader {
  skrBalance(wallet: string): Promise<bigint>
  skrStaked(wallet: string): Promise<bigint>
  oreBalance(wallet: string): Promise<bigint>
  oreStaked(wallet: string): Promise<bigint>
  /** D-33: the last ORE round `wallet` mined in (0 = never) and the round being mined now. */
  oreMinerRound(wallet: string): Promise<bigint>
  oreBoardRound(): Promise<bigint>
}

/** Mainnet-beta genesis hash, VERIFIED against the live cluster 2026-10-01. */
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/**
 * Reads SKR / ORE from mainnet. On first use it refuses a non-mainnet RPC and checks that the onchain mint decimals
 * still match the registry (update §28: the mint is canonical), so a mismatch is an error rather than a wrong answer.
 */
export class MainnetChainReader implements ChainReader {
  private ready: Promise<void> | null = null

  constructor(private readonly rpc: Rpc<GetAccountInfoApi & GetProgramAccountsApi & GetTokenAccountsByOwnerApi & GetGenesisHashApi>) {}

  private check() {
    this.ready ??= (async () => {
      const genesis = await this.rpc.getGenesisHash().send()
      if (genesis !== MAINNET_GENESIS) throw new Error(`quest RPC is not mainnet-beta (genesis ${genesis})`)
      const [skr, ore] = await Promise.all([readMintDecimals(this.rpc, SKR_MINT), readMintDecimals(this.rpc, ORE_MINT)])
      if (skr !== VERIFIERS.SKR_BALANCE.amount!.decimals || ore !== VERIFIERS.ORE_BALANCE.amount!.decimals) {
        throw new Error(`mint decimals changed (SKR ${skr}, ORE ${ore}); update the verifier registry`)
      }
    })().catch((err: unknown) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  async skrBalance(wallet: string) {
    await this.check()
    return readTokenBalance(this.rpc, address(wallet), SKR_MINT)
  }
  async skrStaked(wallet: string) {
    await this.check()
    return (await readSkrStaked(this.rpc, address(wallet))).raw
  }
  async oreBalance(wallet: string) {
    await this.check()
    return readTokenBalance(this.rpc, address(wallet), ORE_MINT)
  }
  async oreStaked(wallet: string) {
    await this.check()
    return readOreStaked(this.rpc, address(wallet))
  }
  async oreMinerRound(wallet: string) {
    await this.check()
    return readOreMinerRound(this.rpc, address(wallet))
  }
  async oreBoardRound() {
    await this.check()
    return readOreBoardRound(this.rpc)
  }
}

export interface QuestOutcome {
  evaluation: QuestEvaluation
  /** The qualifying Tap Rush round to consume on claim, when the quest has a TAP_RUSH action. */
  tapSessionId: string | null
}

/**
 * Server-authoritative Verified Quest evaluation (update §5, §20, §22): current onchain state, read for the caller's
 * Privy-verified wallets only, immediately before reservation. Any read failure is ERROR, which never qualifies.
 */
export class QuestService {
  constructor(
    private readonly deps: {
      auth: AuthVerifier
      claims: ClaimRepository
      chain?: ChainReader
      seeker?: SeekerVerifier
      /** D-39: verified X posts. */
      xTasks?: XTaskStore
      /** D-40: club membership and event check-ins. */
      social?: SocialStore
      log?: { warn: (o: object, msg: string) => void }
    },
  ) {}

  /** D-33: the ORE round being mined now, recorded on ORE_ACTIVITY conditions when a campaign is created. */
  async currentOreRound(): Promise<bigint> {
    if (!this.deps.chain) throw new Error('mainnet reader not configured')
    return this.deps.chain.oreBoardRound()
  }

  async evaluate(campaign: StoredCampaign, privyUserId: string): Promise<QuestOutcome> {
    if (!campaign.requirements) throw new Error('campaign has no requirements')
    const { evaluation, tapSessionId, embedded } = await this.run(campaign.requirements, privyUserId, campaign)
    await this.deps.claims.putQuestVerification({ campaignId: campaign.id, privyUserId, evaluation, publicWallet: embedded[0] ?? null })
    return { evaluation, tapSessionId: evaluation.qualified ? tapSessionId : null }
  }

  /**
   * D-45: OG marks on mainnet: Seeker owner (SGT), any SKR staked, ORE ever mined (or staked). `unknown` lists the
   * marks that couldn't be read right now, so a failed read never removes a mark the person already has.
   */
  async ogStatus(privyUserId: string): Promise<{ og: OgType[]; unknown: OgType[] }> {
    const groups: { type: OgType; group: QuestRequirements['eligibility'][number] }[] = [
      { type: 'ORE', group: { mode: 'ANY', conditions: [{ verifier: 'ORE_ACTIVITY', afterRound: '0' }, { verifier: 'ORE_STAKED', minRaw: '1' }] } },
      { type: 'SEEKER', group: { mode: 'ALL', conditions: [{ verifier: 'SEEKER_SGT' }] } },
      { type: 'SKR', group: { mode: 'ALL', conditions: [{ verifier: 'SKR_STAKED', minRaw: '1' }] } },
    ]
    const { evaluation } = await this.run({ eligibility: groups.map((g) => g.group), actions: [] }, privyUserId, null)
    const og: OgType[] = []
    const unknown: OgType[] = []
    groups.forEach((g, i) => {
      const r = evaluation.eligibility[i]
      if (r?.passed) og.push(g.type)
      else if (r?.results.some((x) => x.status === 'ERROR')) unknown.push(g.type)
    })
    return { og, unknown }
  }

  /** D-41: a club's join rules (eligibility groups only; read-only, nothing is stored). */
  async checkRules(groups: QuestRequirements['eligibility'], privyUserId: string): Promise<QuestEvaluation> {
    return (await this.run({ eligibility: groups, actions: [] }, privyUserId, null)).evaluation
  }

  /** Campaign-specific verifiers (Tap Rush, X, club, check-in) need `campaign`; without it they never pass. */
  private async run(requirements: QuestRequirements, privyUserId: string, campaign: StoredCampaign | null) {
    const [external, embedded] = await Promise.all([
      this.deps.auth.getVerifiedExternalSolanaWallets(privyUserId),
      this.deps.auth.getEmbeddedSolanaWallets(privyUserId),
    ])
    // Only wallets Privy has verified for this user: SIWS-linked external wallets plus their embedded wallet.
    const wallets = [...new Set([...external, ...embedded])]

    const cache = new Map<string, Promise<bigint>>()
    const sum = (key: string, read: (w: string) => Promise<bigint>) => {
      if (!cache.has(key)) cache.set(key, Promise.all(wallets.map(read)).then((v) => v.reduce((a, b) => a + b, 0n)))
      return cache.get(key)!
    }
    const chain = this.deps.chain

    let tapSessionId: string | null = null
    const results = new Map<QuestCondition, ConditionResult>()
    const all = [...requirements.eligibility, ...requirements.actions].flatMap((g) => g.conditions)

    await Promise.all(
      all.map(async (c) => {
        const def = VERIFIERS[c.verifier]
        if (!def || def.availability !== 'ENABLED') {
          results.set(c, { verifier: c.verifier, status: 'FAILED', detail: 'UNAVAILABLE' })
          return
        }
        try {
          if ((c.verifier === 'TAP_RUSH' || c.verifier === 'X_QUEST' || c.verifier === 'CLUB_MEMBER' || c.verifier === 'QR_CHECKIN') && !campaign) {
            throw new Error(`${c.verifier} needs a campaign`)
          }
          // Past the guard above, the campaign-specific verifiers always have a campaign.
          if (c.verifier === 'TAP_RUSH') {
            const session = await this.deps.claims.findUnusedQualifiedSession(campaign!.id, privyUserId)
            if (session) tapSessionId = session.id
            results.set(c, { verifier: c.verifier, status: session ? 'PASSED' : 'NOT_STARTED' })
            return
          }
          if (c.verifier === 'X_QUEST') {
            // D-39: verified when the person submitted a post Blink checked (see the x-task route).
            const task = this.deps.xTasks ? await this.deps.xTasks.get(campaign!.id, privyUserId) : null
            results.set(c, { verifier: c.verifier, status: task?.verifiedAt ? 'PASSED' : 'NOT_STARTED', detail: task?.authorHandle ? `@${task.authorHandle}` : undefined })
            return
          }
          if (c.verifier === 'CLUB_MEMBER') {
            // D-40: membership of the drop's own club (Blink state). It never replaces the xStocks eligibility gate.
            if (!this.deps.social) throw new Error('clubs not configured')
            const member = campaign!.clubId ? await this.deps.social.membership(campaign!.clubId, privyUserId) : null
            results.set(c, { verifier: c.verifier, status: member ? 'PASSED' : 'FAILED', detail: member ? undefined : 'NOT_A_MEMBER' })
            return
          }
          if (c.verifier === 'QR_CHECKIN') {
            if (!this.deps.social) throw new Error('event check-in not configured')
            const done = await this.deps.social.hasCheckedIn(campaign!.id, privyUserId)
            results.set(c, { verifier: c.verifier, status: done ? 'PASSED' : 'NOT_STARTED' })
            return
          }
          if (c.verifier === 'SEEKER_SGT') {
            if (!this.deps.seeker) throw new Error('Seeker verification not configured')
            let found = false
            for (const w of external) if (!found && (await this.deps.seeker.findSgt(w))) found = true
            results.set(c, { verifier: c.verifier, status: found ? 'PASSED' : 'FAILED', detail: found ? undefined : 'NO_SGT' })
            return
          }
          if (!chain) throw new Error('mainnet reader not configured')
          if (c.verifier === 'ORE_ACTIVITY') {
            // D-33: mined in a round after the one recorded when the campaign was created (any verified wallet).
            if (c.afterRound === undefined) throw new Error('ORE_ACTIVITY condition has no start round')
            const after = BigInt(c.afterRound)
            const rounds = await Promise.all(wallets.map((w) => chain.oreMinerRound(w)))
            const last = rounds.reduce((a, b) => (b > a ? b : a), 0n)
            results.set(c, { verifier: c.verifier, status: last > after ? 'PASSED' : 'FAILED', detail: last > after ? undefined : 'NOT_MINED_SINCE_START' })
            return
          }
          const required = BigInt(c.minRaw ?? '0')
          const actual =
            c.verifier === 'SKR_BALANCE'
              ? await sum('skrB', (w) => chain.skrBalance(w))
              : c.verifier === 'SKR_STAKED'
                ? await sum('skrS', (w) => chain.skrStaked(w))
                : c.verifier === 'SKR_TOTAL'
                  ? (await sum('skrB', (w) => chain.skrBalance(w))) + (await sum('skrS', (w) => chain.skrStaked(w)))
                  : c.verifier === 'ORE_BALANCE'
                    ? await sum('oreB', (w) => chain.oreBalance(w))
                    : await sum('oreS', (w) => chain.oreStaked(w))
          results.set(c, {
            verifier: c.verifier,
            status: actual >= required ? 'PASSED' : 'FAILED',
            actualRaw: actual.toString(),
            requiredRaw: required.toString(),
          })
        } catch (err) {
          // Fail closed: an unreadable condition never passes.
          this.deps.log?.warn({ err, verifier: c.verifier, campaignId: campaign?.id }, 'quest condition could not be verified')
          results.set(c, { verifier: c.verifier, status: 'ERROR', detail: 'UNAVAILABLE_RIGHT_NOW' })
        }
      }),
    )

    const evaluation = combineQuest(requirements, (c) => results.get(c)!, new Date().toISOString())
    return { evaluation, tapSessionId: tapSessionId as string | null, embedded }
  }
}

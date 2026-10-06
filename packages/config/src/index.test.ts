import { describe, expect, it } from 'vitest'

import {
  assertMainnetSpendAllowed,
  checkBudget,
  ConfigError,
  loadEnv,
  MAINNET_HARD_CEILING_LAMPORTS,
} from './index.ts'

const base = { SOLANA_RPC_URL: 'https://api.devnet.solana.com' }

describe('loadEnv', () => {
  it('defaults to devnet with mainnet disabled', () => {
    const env = loadEnv(base)
    expect(env.SOLANA_CLUSTER).toBe('devnet')
    expect(env.MAINNET_ENABLED).toBe(false)
    expect(env.MAINNET_GO_APPROVED).toBe(false)
    expect(env.API_PORT).toBe(4310)
  })

  it('refuses mainnet-beta without MAINNET_ENABLED', () => {
    expect(() => loadEnv({ ...base, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(ConfigError)
  })

  it('refuses MAINNET_ENABLED on a non-mainnet cluster', () => {
    expect(() => loadEnv({ ...base, MAINNET_ENABLED: 'true' })).toThrow(ConfigError)
  })

  it('refuses GO approval without MAINNET_ENABLED', () => {
    expect(() => loadEnv({ ...base, MAINNET_GO_APPROVED: 'true' })).toThrow(ConfigError)
  })

  it('refuses a budget above the 0.10 SOL hard ceiling', () => {
    expect(() =>
      loadEnv({
        ...base,
        SOLANA_CLUSTER: 'mainnet-beta',
        MAINNET_ENABLED: 'true',
        MAINNET_BUDGET_LAMPORTS: (MAINNET_HARD_CEILING_LAMPORTS + 1n).toString(),
      }),
    ).toThrow(/hard ceiling/)
  })

  it('rejects non-boolean flags rather than guessing', () => {
    expect(() => loadEnv({ ...base, MAINNET_ENABLED: 'yes' })).toThrow(ConfigError)
  })
})

describe('assertMainnetSpendAllowed', () => {
  const mainnet = { ...base, SOLANA_CLUSTER: 'mainnet-beta', MAINNET_ENABLED: 'true' }

  it('refuses spending without GO approval', () => {
    expect(() => assertMainnetSpendAllowed(loadEnv(mainnet))).toThrow(/MAINNET_GO_APPROVED/)
  })

  it('allows spending only with every guard present', () => {
    expect(() => assertMainnetSpendAllowed(loadEnv({ ...mainnet, MAINNET_GO_APPROVED: 'true' }))).not.toThrow()
  })
})

describe('checkBudget', () => {
  // 0.02 SOL budget → 0.015 SOL committable; 25 % (0.005 SOL) always stays as a buffer (W-3).
  const state = {
    spentLamports: 10_000_000n,
    reservedLamports: 2_500_000n,
    estimatedNextOperationLamports: 2_500_000n,
    configuredBudgetLamports: 20_000_000n,
  }

  it('allows an operation landing exactly on 75 % of the budget', () => {
    expect(checkBudget(state)).toEqual({ allowed: true, projectedLamports: 15_000_000n, remainingAfterLamports: 0n })
  })

  it('blocks an operation that would eat into the 25 % safety buffer', () => {
    expect(checkBudget({ ...state, estimatedNextOperationLamports: 2_500_001n }).allowed).toBe(false)
    expect(checkBudget({ ...state, estimatedNextOperationLamports: 7_500_000n }).allowed).toBe(false)
  })

  it('never allows more than the hard ceiling even if configured higher', () => {
    const decision = checkBudget({
      spentLamports: MAINNET_HARD_CEILING_LAMPORTS,
      reservedLamports: 0n,
      estimatedNextOperationLamports: 1n,
      configuredBudgetLamports: MAINNET_HARD_CEILING_LAMPORTS * 2n,
    })
    expect(decision.allowed).toBe(false)
  })

  it('rejects negative values', () => {
    expect(checkBudget({ ...state, reservedLamports: -1n }).allowed).toBe(false)
  })
})

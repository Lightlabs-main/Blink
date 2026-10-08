import { type Address, address, getAddressEncoder, getBase64Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import {
  decodeOreStake,
  decodeUserStake,
  deriveOreStake,
  deriveUserStake,
  ORE_STAKE_PROGRAM,
  readOreStaked,
  readSkrStaked,
  SKR_MINT,
  SKR_STAKE_CONFIG,
  SKR_STAKING_PROGRAM,
  skrStakedRaw,
} from './stake-readers.ts'
import { SKR_GUARDIAN_POOL } from './skr-staking.ts'

const enc = getAddressEncoder()
const b64 = getBase64Decoder()
const USER = address('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')
const OTHER_USER = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
const POOL_A = address('DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr')
const POOL_B = address('11111111111111111111111111111112')
const WRONG = address('11111111111111111111111111111113')

function le(value: bigint, bytes: number) {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(8 * i)) & 0xffn)
  return out
}

function stakeConfigBytes(sharePrice: bigint, mint: Address = SKR_MINT) {
  const b = new Uint8Array(193)
  b.set([238, 151, 43, 3, 11, 151, 63, 176], 0)
  b.set(enc.encode(mint), 41)
  b.set(le(sharePrice, 16), 137)
  return b
}

function userStakeBytes(o: { user?: Address; pool?: Address; config?: Address; shares: bigint; unstaking?: bigint }) {
  const b = new Uint8Array(169)
  b.set([102, 53, 163, 107, 9, 138, 87, 153], 0)
  b.set(enc.encode(o.config ?? SKR_STAKE_CONFIG), 9)
  b.set(enc.encode(o.user ?? USER), 41)
  b.set(enc.encode(o.pool ?? POOL_A), 73)
  b.set(le(o.shares, 16), 105)
  b.set(le(o.unstaking ?? 0n, 8), 153)
  return b
}

function oreStakeBytes(authority: Address, balance: bigint) {
  const b = new Uint8Array(160)
  b[0] = 108
  b.set(enc.encode(authority), 8)
  b.set(le(balance, 8), 40)
  return b
}

type Acc = { pubkey: Address; account: { owner: Address; data: [string, 'base64'] } }

/** Minimal RPC fake: a config account, a set of program accounts, and single accounts by address. */
function fakeRpc(o: { config?: Uint8Array | null; configOwner?: Address; programAccounts?: Acc[]; accounts?: Record<string, { owner: Address; bytes: Uint8Array }> }) {
  return {
    getAccountInfo: (addr: Address) => ({
      send: async () => {
        if (addr === SKR_STAKE_CONFIG) {
          return { value: o.config ? { owner: o.configOwner ?? SKR_STAKING_PROGRAM, data: [b64.decode(o.config), 'base64'] } : null }
        }
        const a = o.accounts?.[addr]
        return { value: a ? { owner: a.owner, data: [b64.decode(a.bytes), 'base64'] } : null }
      },
    }),
    getProgramAccounts: () => ({ send: async () => o.programAccounts ?? [] }),
    getTokenAccountsByOwner: () => ({ send: async () => ({ value: [] }) }),
  } as never
}

async function position(o: { user?: Address; pool: Address; config?: Address; shares: bigint; owner?: Address; key?: Address }): Promise<Acc> {
  return {
    pubkey: o.key ?? (await deriveUserStake(o.user ?? USER, o.pool)),
    account: { owner: o.owner ?? SKR_STAKING_PROGRAM, data: [b64.decode(userStakeBytes(o)), 'base64'] },
  }
}

const PRICE = 1_147_028_992n // the live share price read 2026-10-01

describe('SKR staked aggregation (update §28)', () => {
  it('decodes a UserStake and values shares at the share price', () => {
    const s = decodeUserStake(userStakeBytes({ shares: 500_000_000n, unstaking: 7n }))
    expect(s).toMatchObject({ user: USER, guardianPool: POOL_A, shares: 500_000_000n, unstakingAmount: 7n })
    expect(skrStakedRaw(1_000_000_000n, PRICE)).toBe(1_147_028_992n)
  })

  it('one position', async () => {
    const rpc = fakeRpc({ config: stakeConfigBytes(PRICE), programAccounts: [await position({ pool: POOL_A, shares: 1_000_000_000n })] })
    expect(await readSkrStaked(rpc, USER)).toEqual({ raw: 1_147_028_992n, positions: 1 })
  })

  it('sums several guardian pools', async () => {
    const rpc = fakeRpc({
      config: stakeConfigBytes(PRICE),
      programAccounts: [await position({ pool: POOL_A, shares: 1_000_000_000n }), await position({ pool: POOL_B, shares: 2_000_000_000n })],
    })
    expect(await readSkrStaked(rpc, USER)).toEqual({ raw: 3_441_086_976n, positions: 2 })
  })

  it('D-48: a stake made outside Blink (stake.solanamobile.com / Seed Vault, any guardian pool) counts', async () => {
    // Detection depends only on (stake config, owner), never on Blink's default pool or on Blink having built the tx.
    expect(POOL_B).not.toBe(SKR_GUARDIAN_POOL)
    const rpc = fakeRpc({ config: stakeConfigBytes(PRICE), programAccounts: [await position({ pool: POOL_B, shares: 1_000_000_000n })] })
    expect(await readSkrStaked(rpc, USER)).toEqual({ raw: 1_147_028_992n, positions: 1 })
  })

  it('zero stake and closed (zero-share) positions count as nothing', async () => {
    expect(await readSkrStaked(fakeRpc({ config: stakeConfigBytes(PRICE) }), USER)).toEqual({ raw: 0n, positions: 0 })
    const closed = fakeRpc({ config: stakeConfigBytes(PRICE), programAccounts: [await position({ pool: POOL_A, shares: 0n })] })
    expect(await readSkrStaked(closed, USER)).toEqual({ raw: 0n, positions: 0 })
  })

  it('ignores accounts with the wrong owner program, user, config or address', async () => {
    const rpc = fakeRpc({
      config: stakeConfigBytes(PRICE),
      programAccounts: [
        await position({ pool: POOL_A, shares: 9n, owner: WRONG }),
        await position({ pool: POOL_A, shares: 9n, user: OTHER_USER }),
        await position({ pool: POOL_A, shares: 9n, config: WRONG }),
        await position({ pool: POOL_A, shares: 9n, key: WRONG }),
      ],
    })
    expect(await readSkrStaked(rpc, USER)).toEqual({ raw: 0n, positions: 0 })
  })

  it('wrong network (no stake config) or a config for another mint is an error, not zero', async () => {
    await expect(readSkrStaked(fakeRpc({ config: null }), USER)).rejects.toThrow(/wrong network/)
    await expect(readSkrStaked(fakeRpc({ config: stakeConfigBytes(PRICE, WRONG) }), USER)).rejects.toThrow(/different mint/)
    await expect(readSkrStaked(fakeRpc({ config: stakeConfigBytes(PRICE), configOwner: WRONG }), USER)).rejects.toThrow(/not owned/)
  })
})

describe('ORE staked (update §29)', () => {
  it('reads the balance of the canonical stake PDA', async () => {
    const pda = await deriveOreStake(USER)
    const rpc = fakeRpc({ accounts: { [pda]: { owner: ORE_STAKE_PROGRAM, bytes: oreStakeBytes(USER, 250_000_000_000n) } } })
    expect(await readOreStaked(rpc, USER)).toBe(250_000_000_000n)
    expect(decodeOreStake(oreStakeBytes(USER, 5n))).toEqual({ authority: USER, balance: 5n })
  })

  it('no stake account means zero', async () => {
    expect(await readOreStaked(fakeRpc({}), USER)).toBe(0n)
  })

  it('wrong owner program or authority is an error', async () => {
    const pda = await deriveOreStake(USER)
    await expect(readOreStaked(fakeRpc({ accounts: { [pda]: { owner: WRONG, bytes: oreStakeBytes(USER, 1n) } } }), USER)).rejects.toThrow(/not owned/)
    await expect(readOreStaked(fakeRpc({ accounts: { [pda]: { owner: ORE_STAKE_PROGRAM, bytes: oreStakeBytes(OTHER_USER, 1n) } } }), USER)).rejects.toThrow(
      /authority mismatch/,
    )
  })
})

import {
  type Address,
  address,
  type Base58EncodedBytes,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  type GetAccountInfoApi,
  type GetProgramAccountsApi,
  getProgramDerivedAddress,
  type GetTokenAccountsByOwnerApi,
  getUtf8Encoder,
  type Rpc,
} from '@solana/kit'

/*
 * Read-only SKR and ORE readers for Verified Quest (D-21, docs/VERIFIER_ARCHITECTURE.md).
 * Every address below was taken from the official source and checked against mainnet on 2026-10-01
 * (docs/DEPENDENCIES.md). Byte layouts come from the official IDL / program source.
 */

// ── SKR (Solana Mobile) ─────────────────────────────────────────────────────────────
export const SKR_MINT = address('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3')
export const SKR_STAKING_PROGRAM = address('SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ')
export const SKR_STAKE_CONFIG = address('4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw')
/** IDL account discriminators (skr-staking/program/idl.json). */
const USER_STAKE_DISCRIMINATOR = Uint8Array.from([102, 53, 163, 107, 9, 138, 87, 153])
const STAKE_CONFIG_DISCRIMINATOR = Uint8Array.from([238, 151, 43, 3, 11, 151, 63, 176])
/** StakeConfig.share_price is scaled by 1e9 (official sample: SHARE_PRICE_SCALE). */
export const SKR_SHARE_PRICE_SCALE = 1_000_000_000n

// ── ORE (Regolith Labs) ─────────────────────────────────────────────────────────────
export const ORE_MINT = address('oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp')
export const ORE_STAKE_PROGRAM = address('stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH')
/** ore-stake `OreAccount::Stake = 108` (api/src/state/mod.rs). */
const ORE_STAKE_DISCRIMINATOR = 108
/**
 * ORE mining program (regolith-labs/ore `api/src/lib.rs` declare_id). Accounts are steel `repr(C)` with an 8-byte
 * discriminator: `OreAccount::Miner = 103`, `OreAccount::Board = 105` (api/src/state/mod.rs).
 * Miner (752 bytes): authority @8 · … · deployed/mass/cumulative [u64;25] @64/264/464 · round_id u64 @664 (the last
 * round the miner deployed in). Board: round_id u64 @8 (the current round).
 * Layout VERIFIED against live mainnet accounts 2026-10-03 (D-33).
 */
export const ORE_PROGRAM = address('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv')
const ORE_MINER_DISCRIMINATOR = 103
const ORE_BOARD_DISCRIMINATOR = 105

export class ProtocolReadError extends Error {
  override name = 'ProtocolReadError'
}

const addrDec = getAddressDecoder()
const addrEnc = getAddressEncoder()

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function u64(bytes: Uint8Array, offset: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]!)
  return v
}

function u128(bytes: Uint8Array, offset: number): bigint {
  return (u64(bytes, offset + 8) << 64n) | u64(bytes, offset)
}

function pubkey(bytes: Uint8Array, offset: number): Address {
  return addrDec.decode(bytes.subarray(offset, offset + 32))
}

/** StakeConfig layout (IDL): disc 8 · bump 1 · authority · mint · stake_vault · min u64 · cooldown u64 · total_shares u128 · share_price u128 … */
export function decodeStakeConfig(bytes: Uint8Array) {
  if (bytes.length < 153 || !bytesEqual(bytes.subarray(0, 8), STAKE_CONFIG_DISCRIMINATOR)) throw new ProtocolReadError('not a StakeConfig account')
  return {
    mint: pubkey(bytes, 41),
    stakeVault: pubkey(bytes, 73),
    minStakeAmount: u64(bytes, 105),
    cooldownSeconds: u64(bytes, 113),
    sharePrice: u128(bytes, 137),
  }
}

/** UserStake layout (IDL): disc 8 · bump 1 · stake_config 9 · user 41 · guardian_pool 73 · shares u128 105 · cost_basis · cumulative · unstaking_amount u64 153 · unstake_timestamp i64 161. */
export function decodeUserStake(bytes: Uint8Array) {
  if (bytes.length < 169 || !bytesEqual(bytes.subarray(0, 8), USER_STAKE_DISCRIMINATOR)) throw new ProtocolReadError('not a UserStake account')
  return {
    bump: bytes[8]!,
    stakeConfig: pubkey(bytes, 9),
    user: pubkey(bytes, 41),
    guardianPool: pubkey(bytes, 73),
    shares: u128(bytes, 105),
    unstakingAmount: u64(bytes, 153),
    unstakeTimestamp: BigInt.asIntN(64, u64(bytes, 161)),
  }
}

/** ore-stake `Stake` (repr(C), steel): discriminator (8 bytes, first = 108) · authority 8 · balance u64 40 … */
export function decodeOreStake(bytes: Uint8Array) {
  if (bytes.length < 48 || bytes[0] !== ORE_STAKE_DISCRIMINATOR) throw new ProtocolReadError('not an ORE Stake account')
  return { authority: pubkey(bytes, 8), balance: u64(bytes, 40) }
}

export function skrStakedRaw(shares: bigint, sharePrice: bigint): bigint {
  return (shares * sharePrice) / SKR_SHARE_PRICE_SCALE
}

export async function deriveUserStake(user: Address, guardianPool: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SKR_STAKING_PROGRAM,
    seeds: [getUtf8Encoder().encode('user_stake'), addrEnc.encode(SKR_STAKE_CONFIG), addrEnc.encode(user), addrEnc.encode(guardianPool)],
  })
  return pda
}

export async function deriveOreStake(authority: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: ORE_STAKE_PROGRAM, seeds: [getUtf8Encoder().encode('stake'), addrEnc.encode(authority)] })
  return pda
}

type ReaderRpc = Rpc<GetAccountInfoApi & GetProgramAccountsApi & GetTokenAccountsByOwnerApi>

async function accountBytes(rpc: ReaderRpc, account: Address, expectedOwner: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()
  if (!value) return null
  if (value.owner !== expectedOwner) throw new ProtocolReadError(`${account} is not owned by ${expectedOwner}`)
  return Uint8Array.from(getBase64Encoder().encode(value.data[0]))
}

/** Liquid balance: the sum of every token account `owner` holds for `mint` (ATA or not). */
export async function readTokenBalance(rpc: ReaderRpc, owner: Address, mint: Address): Promise<bigint> {
  const { value } = await rpc.getTokenAccountsByOwner(owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  let total = 0n
  for (const a of value) {
    const amount = (a.account.data.parsed.info as { tokenAmount?: { amount?: string } }).tokenAmount?.amount
    if (amount && /^\d+$/.test(amount)) total += BigInt(amount)
  }
  return total
}

/**
 * Total staked SKR of `owner` across ALL guardian pools (update §28): every UserStake for (config, owner), each
 * re-derived from its own guardian pool, valued at the current share price. Unstaking amounts are excluded.
 */
export async function readSkrStaked(rpc: ReaderRpc, owner: Address): Promise<{ raw: bigint; positions: number }> {
  const configBytes = await accountBytes(rpc, SKR_STAKE_CONFIG, SKR_STAKING_PROGRAM)
  if (!configBytes) throw new ProtocolReadError('SKR stake config not found (wrong network?)')
  const config = decodeStakeConfig(configBytes)
  if (config.mint !== SKR_MINT) throw new ProtocolReadError('SKR stake config is for a different mint')

  const b58 = getBase58Decoder()
  const accounts = await rpc
    .getProgramAccounts(SKR_STAKING_PROGRAM, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(USER_STAKE_DISCRIMINATOR) as Base58EncodedBytes, encoding: 'base58' } },
        { memcmp: { offset: 9n, bytes: SKR_STAKE_CONFIG as string as Base58EncodedBytes, encoding: 'base58' } },
        { memcmp: { offset: 41n, bytes: owner as string as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send()

  let raw = 0n
  let positions = 0
  for (const { pubkey: key, account } of accounts) {
    if (account.owner !== SKR_STAKING_PROGRAM) continue
    let stake
    try {
      stake = decodeUserStake(Uint8Array.from(getBase64Encoder().encode(account.data[0])))
    } catch {
      continue
    }
    if (stake.user !== owner || stake.stakeConfig !== SKR_STAKE_CONFIG) continue
    if ((await deriveUserStake(owner, stake.guardianPool)) !== key) continue
    if (stake.shares === 0n) continue
    raw += skrStakedRaw(stake.shares, config.sharePrice)
    positions += 1
  }
  return { raw, positions }
}

/** Staked ORE of `owner`: the ore-stake Stake PDA ["stake", owner]; absent = 0. */
export async function readOreStaked(rpc: ReaderRpc, owner: Address): Promise<bigint> {
  const pda = await deriveOreStake(owner)
  const bytes = await accountBytes(rpc, pda, ORE_STAKE_PROGRAM)
  if (!bytes) return 0n
  const stake = decodeOreStake(bytes)
  if (stake.authority !== owner) throw new ProtocolReadError('ORE stake account authority mismatch')
  return stake.balance
}

/** Decimals of a mint read onchain (update §28: canonical decimals come from the mint, not from samples). */
export async function readMintDecimals(rpc: Rpc<GetAccountInfoApi>, mint: Address): Promise<number> {
  const { value } = await rpc.getAccountInfo(mint, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  const decimals = (value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals
  if (typeof decimals !== 'number') throw new ProtocolReadError(`cannot read decimals of ${mint}`)
  return decimals
}

export async function deriveOreMiner(authority: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: ORE_PROGRAM, seeds: [getUtf8Encoder().encode('miner'), addrEnc.encode(authority)] })
  return pda
}

/** The ORE round currently being mined (Board PDA `["board"]`). */
export async function readOreBoardRound(rpc: ReaderRpc): Promise<bigint> {
  const [board] = await getProgramDerivedAddress({ programAddress: ORE_PROGRAM, seeds: [getUtf8Encoder().encode('board')] })
  const bytes = await accountBytes(rpc, board, ORE_PROGRAM)
  if (!bytes || bytes.length < 16 || bytes[0] !== ORE_BOARD_DISCRIMINATOR) throw new ProtocolReadError('ORE board not found (wrong network?)')
  return u64(bytes, 8)
}

/** The last ORE round `owner` mined in (Miner PDA `["miner", owner]`); 0 when the wallet never mined. */
export async function readOreMinerRound(rpc: ReaderRpc, owner: Address): Promise<bigint> {
  const bytes = await accountBytes(rpc, await deriveOreMiner(owner), ORE_PROGRAM)
  if (!bytes) return 0n
  if (bytes.length < 672 || bytes[0] !== ORE_MINER_DISCRIMINATOR) throw new ProtocolReadError('not an ORE Miner account')
  if (pubkey(bytes, 8) !== owner) throw new ProtocolReadError('ORE miner account authority mismatch')
  return u64(bytes, 664)
}

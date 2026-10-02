import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getU128Encoder,
  getU64Encoder,
  getUtf8Encoder,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type Instruction,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'

import {
  decodeStakeConfig,
  decodeUserStake,
  deriveUserStake,
  ProtocolReadError,
  SKR_MINT,
  SKR_SHARE_PRICE_SCALE,
  SKR_STAKE_CONFIG,
  SKR_STAKING_PROGRAM,
  skrStakedRaw,
} from './stake-readers.ts'

/*
 * In-app SKR staking (D-23). Instructions are built by hand from the official IDL
 * (solana-mobile/react-native-samples skr-staking/program/idl.json); every address below is the one the official
 * sample uses and was checked against mainnet (the vault is the one recorded in the StakeConfig account).
 * The user's own wallet is fee payer and only signer; Blink never holds or moves SKR.
 */

export const SKR_STAKE_VAULT = address('8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8')
/** The guardian pool the official Solana Mobile sample delegates to. */
export const SKR_GUARDIAN_POOL = address('DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr')
export const SKR_DECIMALS = 6
export const SPL_TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM_PROGRAM = address('11111111111111111111111111111111')

export type SkrStakeAction = 'stake' | 'unstake' | 'withdraw' | 'cancel_unstake'

const DISCRIMINATOR: Record<SkrStakeAction, number[]> = {
  stake: [206, 176, 202, 18, 200, 209, 179, 108],
  unstake: [90, 95, 107, 42, 205, 124, 50, 225],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  cancel_unstake: [64, 65, 53, 227, 125, 153, 3, 167],
}

const addrEnc = getAddressEncoder()

export async function deriveSkrEventAuthority(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: SKR_STAKING_PROGRAM, seeds: [getUtf8Encoder().encode('__event_authority')] })
  return pda
}

/** Classic SPL associated token account (SKR is an SPL Token mint, not Token-2022). */
export async function deriveSplAta(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [addrEnc.encode(owner), addrEnc.encode(SPL_TOKEN_PROGRAM), addrEnc.encode(mint)],
  })
  return pda
}

function data(action: SkrStakeAction, arg?: Uint8Array): Uint8Array {
  const disc = Uint8Array.from(DISCRIMINATOR[action])
  if (!arg) return disc
  const out = new Uint8Array(disc.length + arg.length)
  out.set(disc)
  out.set(arg, disc.length)
  return out
}

const W = AccountRole.WRITABLE
const R = AccountRole.READONLY
const WS = AccountRole.WRITABLE_SIGNER
const RS = AccountRole.READONLY_SIGNER

export type SkrStakeInput =
  | { action: 'stake'; user: Address; amountRaw: bigint }
  | { action: 'unstake'; user: Address; shares: bigint }
  | { action: 'withdraw'; user: Address }
  | { action: 'cancel_unstake'; user: Address }

/** Instructions for one staking action, in the IDL's exact account order. */
export async function buildSkrStakeInstructions(input: SkrStakeInput): Promise<Instruction[]> {
  const user = input.user
  const [userStake, eventAuthority, ata] = await Promise.all([
    deriveUserStake(user, SKR_GUARDIAN_POOL),
    deriveSkrEventAuthority(),
    deriveSplAta(user, SKR_MINT),
  ])
  const ix = (accounts: [Address, AccountRole][], bytes: Uint8Array): Instruction => ({
    programAddress: SKR_STAKING_PROGRAM,
    accounts: accounts.map(([a, role]) => ({ address: a, role })),
    data: bytes,
  })
  switch (input.action) {
    case 'stake':
      if (input.amountRaw <= 0n) throw new RangeError('stake amount must be positive')
      return [
        ix(
          [
            [userStake, W],
            [SKR_STAKE_CONFIG, W],
            [SKR_GUARDIAN_POOL, W],
            [user, WS],
            [user, R],
            [ata, W],
            [SKR_STAKE_VAULT, W],
            [SKR_MINT, R],
            [SPL_TOKEN_PROGRAM, R],
            [SYSTEM_PROGRAM, R],
            [eventAuthority, R],
            [SKR_STAKING_PROGRAM, R],
          ],
          data('stake', Uint8Array.from(getU64Encoder().encode(input.amountRaw))),
        ),
      ]
    case 'unstake':
      if (input.shares <= 0n) throw new RangeError('shares must be positive')
      return [
        ix(
          [
            [userStake, W],
            [SKR_STAKE_CONFIG, W],
            [SKR_GUARDIAN_POOL, W],
            [user, RS],
            [SKR_STAKE_VAULT, R],
            [SKR_MINT, R],
            [eventAuthority, R],
            [SKR_STAKING_PROGRAM, R],
          ],
          data('unstake', Uint8Array.from(getU128Encoder().encode(input.shares))),
        ),
      ]
    case 'cancel_unstake':
      return [
        ix(
          [
            [userStake, W],
            [SKR_STAKE_CONFIG, W],
            [SKR_GUARDIAN_POOL, W],
            [user, RS],
            [SKR_STAKE_VAULT, R],
            [eventAuthority, R],
            [SKR_STAKING_PROGRAM, R],
          ],
          data('cancel_unstake'),
        ),
      ]
    case 'withdraw':
      return [
        // Idempotent ATA create (official sample): withdraw needs the user's SKR ATA to exist.
        {
          programAddress: ATA_PROGRAM,
          accounts: [
            { address: user, role: WS },
            { address: ata, role: W },
            { address: user, role: R },
            { address: SKR_MINT, role: R },
            { address: SYSTEM_PROGRAM, role: R },
            { address: SPL_TOKEN_PROGRAM, role: R },
          ],
          data: Uint8Array.from([1]),
        },
        ix(
          [
            [userStake, W],
            [SKR_STAKE_CONFIG, W],
            [user, W],
            [SKR_STAKE_VAULT, W],
            [ata, W],
            [SPL_TOKEN_PROGRAM, R],
            [eventAuthority, R],
            [SKR_STAKING_PROGRAM, R],
          ],
          data('withdraw'),
        ),
      ]
  }
}

/** Shares to burn for `amountRaw` SKR at `sharePrice`, never more than the position holds. */
export function skrSharesForAmount(amountRaw: bigint, sharePrice: bigint, maxShares: bigint): bigint {
  if (sharePrice <= 0n) throw new ProtocolReadError('share price is zero')
  const shares = (amountRaw * SKR_SHARE_PRICE_SCALE) / sharePrice
  return shares > maxShares ? maxShares : shares
}

export interface SkrPosition {
  wallet: Address
  /** SKR in the wallet's associated token account (the account staking draws from). */
  walletRaw: bigint
  sharePrice: bigint
  minStakeRaw: bigint
  cooldownSeconds: bigint
  /** Position with Blink's guardian pool. */
  shares: bigint
  stakedRaw: bigint
  unstakingRaw: bigint
  /** Unix seconds when the pending unstake started; 0 when none. */
  unstakeTimestamp: bigint
}

type PositionRpc = Rpc<GetAccountInfoApi>

async function rawAccount(rpc: PositionRpc, account: Address) {
  const { value } = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()
  return value ? { owner: value.owner, bytes: Uint8Array.from(getBase64Encoder().encode(value.data[0])) } : null
}

function u64le(bytes: Uint8Array, offset: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]!)
  return v
}

/** Wallet SKR + the position with Blink's guardian pool, read from mainnet with three account lookups. */
export async function readSkrPosition(rpc: PositionRpc, wallet: Address): Promise<SkrPosition> {
  const [userStakeAddr, ata] = await Promise.all([deriveUserStake(wallet, SKR_GUARDIAN_POOL), deriveSplAta(wallet, SKR_MINT)])
  const [config, stake, token] = await Promise.all([rawAccount(rpc, SKR_STAKE_CONFIG), rawAccount(rpc, userStakeAddr), rawAccount(rpc, ata)])
  if (!config || config.owner !== SKR_STAKING_PROGRAM) throw new ProtocolReadError('SKR stake config not found (wrong network?)')
  const cfg = decodeStakeConfig(config.bytes)
  if (cfg.mint !== SKR_MINT || cfg.stakeVault !== SKR_STAKE_VAULT) throw new ProtocolReadError('SKR stake config does not match the expected mint and vault')

  let walletRaw = 0n
  if (token) {
    if (token.owner !== SPL_TOKEN_PROGRAM || token.bytes.length < 72) throw new ProtocolReadError('unexpected SKR token account')
    walletRaw = u64le(token.bytes, 64)
  }
  let shares = 0n
  let unstakingRaw = 0n
  let unstakeTimestamp = 0n
  if (stake) {
    if (stake.owner !== SKR_STAKING_PROGRAM) throw new ProtocolReadError('unexpected UserStake owner')
    const s = decodeUserStake(stake.bytes)
    if (s.user !== wallet || s.guardianPool !== SKR_GUARDIAN_POOL) throw new ProtocolReadError('UserStake does not belong to this wallet')
    shares = s.shares
    unstakingRaw = s.unstakingAmount
    unstakeTimestamp = s.unstakeTimestamp
  }
  return {
    wallet,
    walletRaw,
    sharePrice: cfg.sharePrice,
    minStakeRaw: cfg.minStakeAmount,
    cooldownSeconds: cfg.cooldownSeconds,
    shares,
    stakedRaw: skrStakedRaw(shares, cfg.sharePrice),
    unstakingRaw,
    unstakeTimestamp,
  }
}

export class SkrStakeError extends Error {
  override name = 'SkrStakeError'
  constructor(
    readonly code: 'INVALID' | 'SIMULATION_FAILED',
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

/** Known program errors (IDL), so the user sees why a simulation failed. */
const PROGRAM_ERRORS: Record<number, string> = {
  6002: 'Below the minimum stake amount.',
  6003: 'This guardian pool is not active.',
  6004: 'The unstake cooldown has not finished yet.',
  6006: 'Not enough staked SKR.',
  6017: 'Withdraw your finished unstake before unstaking more.',
  6018: 'Nothing is unstaking.',
  6019: 'Nothing to withdraw yet.',
  6020: 'Your SKR must be in your wallet’s main token account.',
}

export function describeSkrSimulationError(err: unknown, logs: readonly string[]): string {
  const text = JSON.stringify(err, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  const custom = text.match(/"Custom":"?(\d+)/)
  if (custom) {
    const code = Number(custom[1])
    if (PROGRAM_ERRORS[code]) return PROGRAM_ERRORS[code]
    if (code === 1) return 'Not enough SKR or SOL in this wallet.'
  }
  if (logs.some((l) => /insufficient (funds|lamports)/i.test(l))) return 'Not enough SKR or SOL in this wallet.'
  if (/AccountNotFound/.test(text)) return 'This wallet needs a little SOL on mainnet for the network fee.'
  return 'The staking program rejected this transaction.'
}

export interface PreparedSkrTransaction {
  /** Unsigned v0 transaction (base64 wire). Fee payer and only signer: the user's wallet. */
  transaction: string
  minContextSlot: bigint
  lastValidBlockHeight: bigint
}

/** Builds the action and simulates it on the given (mainnet) RPC; the wallet is never opened for a failing transaction. */
export async function prepareSkrStakeTransaction(
  rpc: Rpc<GetLatestBlockhashApi & SimulateTransactionApi>,
  input: SkrStakeInput,
): Promise<PreparedSkrTransaction> {
  const instructions = await buildSkrStakeInstructions(input)
  const { context, value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.user, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc
    .simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
    .send()
  if (sim.err) {
    const logs = sim.logs ?? []
    throw new SkrStakeError('SIMULATION_FAILED', describeSkrSimulationError(sim.err, logs), logs)
  }
  return { transaction, minContextSlot: context.slot, lastValidBlockHeight: blockhash.lastValidBlockHeight }
}

import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getBase64Encoder,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  getProgramDerivedAddress,
  type GetSlotApi,
  getUtf8Encoder,
  type Instruction,
  type Rpc,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'

import { ORE_PROGRAM, ProtocolReadError } from './stake-readers.ts'

/*
 * ORE live-grid mining (regolith-labs/ore, master 48c203b, 2026-10-02). Every constant, seed, byte offset and
 * instruction layout below is taken from the official source and re-checked against live mainnet accounts by
 * `scripts/ore-inspect.ts` (docs/ORE_PROTOCOL_VERIFICATION.md):
 *  - api/src/consts.rs (addresses, seeds, CHECKPOINT_FEE, TOKEN_DECIMALS = 11)
 *  - api/src/state/{board,round,miner,config}.rs (repr(C) steel accounts, 8-byte discriminator, first byte = OreAccount)
 *  - api/src/instruction.rs + sdk.rs (Deploy = 6: amount u64 per square + squares u32 mask; Checkpoint = 2; Log = 8)
 *  - program/src/deploy.rs (account order, checkpoint precondition, DeployEvent emitted through a Log self-CPI that
 *    only the Board PDA can sign — so the event cannot be produced by any other program)
 *  - entropy-api 0.1.4 (pinned in ore Cargo.toml): program id + var PDA ["var", authority, id u64 LE]
 */

export const ORE_DECIMALS = 11
export const ENTROPY_PROGRAM = address('3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X')
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111')
/** consts.rs: BOARD_ADDRESS / CONFIG_ADDRESS / TREASURY_ADDRESS / VAR_ADDRESS (re-derived in ore-inspect). */
export const ORE_BOARD_ADDRESS = address('BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi')
export const ORE_CONFIG_ADDRESS = address('9c9X7aDRAF41faiDs94ELjT19UrGnn72wBW9hPsS4Awy')
export const ORE_TREASURY_ADDRESS = address('45db2FSR4mcXdSVVZbKbwojU6uYDpMyhpEi7cC8nHaWG')
export const ORE_VAR_ADDRESS = address('BWCaDY96Xe4WkFq1M7UiCCRcChsJ3p51L5KrGzhxgm2E')
/** Lamports the program collects once from a new miner to pay a bot for checkpointing (consts.rs). */
export const ORE_CHECKPOINT_FEE = 10_000n
export const ORE_SQUARES = 25
/** Manual (non-automation) deploys log strategy = u64::MAX. */
export const ORE_MANUAL_STRATEGY = 0xffff_ffff_ffff_ffffn

const OreAccount = { Config: 101, Miner: 103, Board: 105, Round: 109 } as const
const OreIx = { Checkpoint: 2, Deploy: 6, Log: 8 } as const
const DEPLOY_EVENT_DISC = 2n
const utf8 = getUtf8Encoder()
const addrEnc = getAddressEncoder()
const addrDec = getAddressDecoder()

function u64(b: Uint8Array, o: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]!)
  return v
}
function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let x = v
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}
const pk = (b: Uint8Array, o: number) => addrDec.decode(b.subarray(o, o + 32))
const u64s = (b: Uint8Array, o: number, n: number) => Array.from({ length: n }, (_, i) => u64(b, o + i * 8))

function expect(bytes: Uint8Array, disc: number, minLen: number, what: string) {
  if (bytes.length < minLen || bytes[0] !== disc) throw new ProtocolReadError(`not an ORE ${what} account`)
}

// ── PDAs ─────────────────────────────────────────────────────────────────────────────
const pda = async (program: Address, seeds: Parameters<typeof getProgramDerivedAddress>[0]['seeds']) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0]
export const deriveOreBoard = () => pda(ORE_PROGRAM, [utf8.encode('board')])
export const deriveOreConfig = () => pda(ORE_PROGRAM, [utf8.encode('config')])
export const deriveOreTreasury = () => pda(ORE_PROGRAM, [utf8.encode('treasury')])
export const deriveOreRound = (roundId: bigint) => pda(ORE_PROGRAM, [utf8.encode('round'), u64le(roundId)])
export const deriveOreMinerAccount = (authority: Address) => pda(ORE_PROGRAM, [utf8.encode('miner'), addrEnc.encode(authority)])
export const deriveOreAutomation = (authority: Address) => pda(ORE_PROGRAM, [utf8.encode('automation'), addrEnc.encode(authority)])
export const deriveEntropyVar = (authority: Address, id: bigint) => pda(ENTROPY_PROGRAM, [utf8.encode('var'), addrEnc.encode(authority), u64le(id)])

// ── Accounts ─────────────────────────────────────────────────────────────────────────
/** Board (board.rs): round_id · start_slot · end_slot · production_cost_ema. end_slot = u64::MAX until the first deploy. */
export function decodeOreBoard(b: Uint8Array) {
  expect(b, OreAccount.Board, 40, 'Board')
  return { roundId: u64(b, 8), startSlot: u64(b, 16), endSlot: u64(b, 24) }
}

/** Round (round.rs): id @8 · deployed [u64;25] @16 · mass @216 · count @416 · slot_hash @616 · expires_at @648 · … · total_miners @912. */
export function decodeOreRound(b: Uint8Array) {
  expect(b, OreAccount.Round, 920, 'Round')
  return { id: u64(b, 8), deployed: u64s(b, 16, ORE_SQUARES), count: u64s(b, 416, ORE_SQUARES), expiresAt: u64(b, 648), totalMiners: u64(b, 912) }
}

/** Miner (miner.rs): authority @8 · auto_return @40 · checkpoint_id @48 · checkpoint_fee @56 · deployed [u64;25] @64 · … · round_id @664. */
export function decodeOreMiner(b: Uint8Array) {
  expect(b, OreAccount.Miner, 672, 'Miner')
  return { authority: pk(b, 8), checkpointId: u64(b, 48), checkpointFee: u64(b, 56), deployed: u64s(b, 64, ORE_SQUARES), roundId: u64(b, 664) }
}

/**
 * Config (config.rs): AdminConfig (authority, fee_collector, fee_rate) then ProtocolConfig (authority, fee_collector,
 * fee_rate, intermission_slots @152, round_slots @160, …). Only the two slot counts are decoded: they match the live
 * board (end − start = round_slots), whereas the fields after them on mainnet do not match master's entropy fields
 * (the deployed build differs there), so they are not read. Deploys use the compile-time VAR_ADDRESS, as sdk.rs does.
 */
export function decodeOreConfig(b: Uint8Array) {
  expect(b, OreAccount.Config, 168, 'Config')
  return { intermissionSlots: u64(b, 152), roundSlots: u64(b, 160) }
}

export type OreBoard = ReturnType<typeof decodeOreBoard>
export type OreRound = ReturnType<typeof decodeOreRound>
export type OreMiner = ReturnType<typeof decodeOreMiner>

type OreRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi>

async function rawAccounts(rpc: OreRpc, keys: Address[]) {
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: 'confirmed' }).send()
  return value.map((v, i) => {
    if (!v) return null
    if (v.owner !== ORE_PROGRAM) throw new ProtocolReadError(`${keys[i]} is not owned by the ORE program`)
    return Uint8Array.from(getBase64Encoder().encode(v.data[0]))
  })
}

/**
 * The live board: current round, its per-square SOL and miner counts, and (optionally) one wallet's Miner. Read-only.
 * `phase`: MINING while slot ∈ [start, end); WAITING before the first deploy of a round (end = u64::MAX, a deploy
 * starts it); BETWEEN after end_slot until the reset opens the next round (deploys fail then).
 */
export async function readOreLiveBoard(rpc: OreRpc & Rpc<GetSlotApi>, wallet?: Address) {
  const [boardBytes] = await rawAccounts(rpc, [ORE_BOARD_ADDRESS])
  if (!boardBytes) throw new ProtocolReadError('ORE board not found (wrong network?)')
  const board = decodeOreBoard(boardBytes)
  const keys = [await deriveOreRound(board.roundId), ...(wallet ? [await deriveOreMinerAccount(wallet)] : [])]
  const [roundBytes, minerBytes] = await rawAccounts(rpc, keys)
  if (!roundBytes) throw new ProtocolReadError('current ORE round account not found')
  const round = decodeOreRound(roundBytes)
  if (round.id !== board.roundId) throw new ProtocolReadError('ORE round does not match the board')
  const miner = minerBytes ? decodeOreMiner(minerBytes) : null
  if (miner && wallet && miner.authority !== wallet) throw new ProtocolReadError('ORE miner authority mismatch')
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send()
  const waiting = board.endSlot === ORE_MANUAL_STRATEGY
  const phase: 'WAITING' | 'MINING' | 'BETWEEN' = waiting ? 'WAITING' : slot >= board.startSlot && slot < board.endSlot ? 'MINING' : 'BETWEEN'
  return { board, round, miner, slot, phase }
}

// ── Instructions ─────────────────────────────────────────────────────────────────────
export function squaresToMask(squares: number[]): number {
  let mask = 0
  for (const s of squares) {
    if (!Number.isInteger(s) || s < 0 || s >= ORE_SQUARES) throw new RangeError('square out of range')
    mask |= 1 << s
  }
  return mask >>> 0
}
export function maskToSquares(mask: bigint | number): number[] {
  const m = BigInt(mask)
  return Array.from({ length: ORE_SQUARES }, (_, i) => i).filter((i) => (m >> BigInt(i)) & 1n)
}

/** sdk.rs `deploy`: manual deploy by `authority` (signer = authority), `amountLamports` per selected square. */
export async function buildOreDeployInstruction(p: { authority: Address; amountLamports: bigint; roundId: bigint; squares: number[] }): Promise<Instruction> {
  if (p.amountLamports <= 0n) throw new RangeError('amount must be positive')
  const mask = squaresToMask(p.squares)
  if (mask === 0) throw new RangeError('select at least one square')
  const data = new Uint8Array(13)
  data[0] = OreIx.Deploy
  data.set(u64le(p.amountLamports), 1)
  data.set(u64le(BigInt(mask)).subarray(0, 4), 9)
  const board = await deriveOreBoard()
  return {
    programAddress: ORE_PROGRAM,
    accounts: [
      { address: p.authority, role: AccountRole.WRITABLE_SIGNER },
      { address: p.authority, role: AccountRole.WRITABLE },
      { address: await deriveOreAutomation(p.authority), role: AccountRole.WRITABLE },
      { address: board, role: AccountRole.WRITABLE },
      { address: await deriveOreConfig(), role: AccountRole.WRITABLE },
      { address: await deriveOreMinerAccount(p.authority), role: AccountRole.WRITABLE },
      { address: await deriveOreRound(p.roundId), role: AccountRole.WRITABLE },
      { address: await deriveOreTreasury(), role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: ORE_PROGRAM, role: AccountRole.READONLY },
      { address: await deriveEntropyVar(board, 0n), role: AccountRole.WRITABLE },
      { address: ENTROPY_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  }
}

/** sdk.rs `checkpoint`: settles the miner's previous round; required before deploying in a new round. */
export async function buildOreCheckpointInstruction(p: { authority: Address; roundId: bigint }): Promise<Instruction> {
  return {
    programAddress: ORE_PROGRAM,
    accounts: [
      { address: p.authority, role: AccountRole.WRITABLE_SIGNER },
      { address: p.authority, role: AccountRole.WRITABLE },
      { address: await deriveOreAutomation(p.authority), role: AccountRole.WRITABLE },
      { address: await deriveOreBoard(), role: AccountRole.WRITABLE },
      { address: await deriveOreMinerAccount(p.authority), role: AccountRole.WRITABLE },
      { address: await deriveOreRound(p.roundId), role: AccountRole.WRITABLE },
      { address: await deriveOreTreasury(), role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(OreIx.Checkpoint),
  }
}

/** deploy.rs: a miner that played an earlier round must have checkpointed it, or the deploy aborts. */
export function oreNeedsCheckpoint(miner: OreMiner | null, currentRound: bigint): boolean {
  return Boolean(miner && miner.roundId !== currentRound && miner.checkpointId !== miner.roundId)
}

/**
 * Upper bound of what one manual deploy takes from the wallet, in lamports (excluding the network fee):
 * amount × squares to the round, CHECKPOINT_FEE if the miner has none, and Miner-account rent when it does not exist.
 */
export function oreDeployCost(p: { amountLamports: bigint; squares: number; miner: OreMiner | null; minerRentLamports: bigint }) {
  const stake = p.amountLamports * BigInt(p.squares)
  const checkpointFee = !p.miner || p.miner.checkpointFee === 0n ? ORE_CHECKPOINT_FEE : 0n
  const minerRent = p.miner ? 0n : p.minerRentLamports
  return { stake, checkpointFee, minerRent, total: stake + checkpointFee + minerRent }
}

// ── Verification ─────────────────────────────────────────────────────────────────────
export interface DeployEvent {
  authority: Address
  amountPerSquare: bigint
  mask: bigint
  roundId: bigint
  signer: Address
  strategy: bigint
  totalSquares: bigint
  ts: bigint
}

/** event.rs DeployEvent (120 bytes): disc u64 · authority · amount · mask · round_id · signer · strategy · total_squares · ts. */
export function decodeDeployEvent(b: Uint8Array): DeployEvent | null {
  if (b.length < 120 || u64(b, 0) !== DEPLOY_EVENT_DISC) return null
  return {
    authority: pk(b, 8),
    amountPerSquare: u64(b, 40),
    mask: u64(b, 48),
    roundId: u64(b, 56),
    signer: pk(b, 64),
    strategy: u64(b, 96),
    totalSquares: u64(b, 104),
    ts: BigInt.asIntN(64, u64(b, 112)),
  }
}

/** A transaction normalised from getTransaction (any encoding): keys include loaded addresses, data is raw bytes. */
export interface NormalizedTx {
  slot: bigint
  err: unknown
  accountKeys: Address[]
  signers: Address[]
  instructions: { programIdIndex: number; accounts: number[]; data: Uint8Array }[]
  inner: { programIdIndex: number; accounts: number[]; data: Uint8Array }[]
}

export type OreDeployVerdict =
  | { ok: true; event: DeployEvent; slot: bigint; squares: number[]; totalLamports: bigint }
  | { ok: false; reason: 'FAILED' | 'NO_DEPLOY' | 'NOT_MANUAL' | 'WRONG_AUTHORITY' | 'ZERO_EFFECT' | 'MULTIPLE' }

/**
 * Server-side proof of one real ORE deploy by `authority`. Trusts only the chain: the transaction succeeded, a
 * top-level ORE Deploy instruction is present, and exactly one DeployEvent was logged through the ORE Log
 * self-CPI signed by the Board PDA (unforgeable by other programs). Automation deploys (strategy ≠ u64::MAX) and
 * zero-effect deploys (no new square, e.g. squares already taken by this miner) do not count.
 */
export function verifyOreDeployTx(tx: NormalizedTx, authority: Address): OreDeployVerdict {
  if (tx.err) return { ok: false, reason: 'FAILED' }
  const key = (i: number) => tx.accountKeys[i]
  const hasDeploy = tx.instructions.some((ix) => key(ix.programIdIndex) === ORE_PROGRAM && ix.data[0] === OreIx.Deploy)
  if (!hasDeploy) return { ok: false, reason: 'NO_DEPLOY' }
  const events = tx.inner
    .filter((ix) => key(ix.programIdIndex) === ORE_PROGRAM && ix.data[0] === OreIx.Log && key(ix.accounts[0]!) === ORE_BOARD_ADDRESS)
    .map((ix) => decodeDeployEvent(ix.data.subarray(1)))
    .filter((e): e is DeployEvent => e !== null)
  if (events.length === 0) return { ok: false, reason: 'NO_DEPLOY' }
  if (events.length > 1) return { ok: false, reason: 'MULTIPLE' }
  const event = events[0]!
  if (event.authority !== authority || event.signer !== authority || !tx.signers.includes(authority)) return { ok: false, reason: 'WRONG_AUTHORITY' }
  if (event.strategy !== ORE_MANUAL_STRATEGY) return { ok: false, reason: 'NOT_MANUAL' }
  const squares = maskToSquares(event.mask)
  if (event.totalSquares === 0n || event.amountPerSquare === 0n || squares.length !== Number(event.totalSquares)) return { ok: false, reason: 'ZERO_EFFECT' }
  return { ok: true, event, slot: tx.slot, squares, totalLamports: event.amountPerSquare * event.totalSquares }
}

interface RpcJsonIx {
  programIdIndex: number
  accounts: readonly number[]
  data: string
}
/** The parts of a `getTransaction(sig, { encoding: 'json', maxSupportedTransactionVersion: 0 })` result used here. */
export interface RpcJsonTransaction {
  slot: bigint | number
  meta: {
    err: unknown
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null
    innerInstructions?: readonly { index: number; instructions: readonly RpcJsonIx[] }[] | null
  } | null
  transaction: { message: { accountKeys: readonly string[]; header: { numRequiredSignatures: number }; instructions: readonly RpcJsonIx[] } }
}

/** Normalises a json-encoded transaction: static keys, then loaded writable, then loaded readonly (v0 order). */
export function normalizeJsonTransaction(tx: RpcJsonTransaction): NormalizedTx {
  const b58 = getBase58Encoder()
  const msg = tx.transaction.message
  const loaded = tx.meta?.loadedAddresses
  const accountKeys = [...msg.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])].map((k) => address(k))
  const conv = (ix: RpcJsonIx) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: Uint8Array.from(b58.encode(ix.data)) })
  return {
    slot: BigInt(tx.slot),
    err: tx.meta ? tx.meta.err : 'NO_META',
    accountKeys,
    signers: accountKeys.slice(0, msg.header.numRequiredSignatures),
    instructions: msg.instructions.map(conv),
    inner: (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.map(conv)),
  }
}

// ── Transaction (D-51) ───────────────────────────────────────────────────────────────
export type OreDeployErrorCode =
  | 'ROUND_CLOSED'
  | 'ROUND_ENDING'
  | 'SQUARE_TAKEN'
  | 'INSUFFICIENT_SOL'
  | 'WALLET_CANNOT_PAY'
  | 'PREVIOUS_ROUND_UNSETTLED'
  | 'SIMULATION_FAILED'

export class OreDeployError extends Error {
  override name = 'OreDeployError'
  constructor(
    readonly code: OreDeployErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

/** Miner account size on mainnet (752 bytes, read 2026-10-09); its rent is charged once, on the first deploy. */
export const ORE_MINER_ACCOUNT_SPACE = 752n
/** One signature (the user) at the base fee; wallets may add a priority fee on top. */
export const ORE_BASE_FEE_LAMPORTS = 5_000n
/** Minimum slots left in the round when preparing (~20 s at 400 ms/slot), so the user has time to approve. */
export const ORE_MIN_SLOTS_TO_SIGN = 50n

export interface OreDeployPlan {
  transaction: string
  lastValidBlockHeight: bigint
  roundId: bigint
  endSlot: bigint
  slot: bigint
  squares: number[]
  amountLamports: bigint
  needsCheckpoint: boolean
  cost: { stake: bigint; checkpointFee: bigint; minerRent: bigint; networkFee: bigint; total: bigint }
}

type OrePlanRpc = OreRpc & Rpc<GetSlotApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi & SimulateTransactionApi>

/**
 * A manual deploy of `amountLamports` on each of `squares` in the CURRENT round, signed and paid by `authority`
 * (checkpointing its previous round first when the program requires it). Simulated before return; never signed.
 */
export async function buildOreDeployTransaction(rpc: OrePlanRpc, input: { authority: Address; amountLamports: bigint; squares: number[] }): Promise<OreDeployPlan> {
  const squares = [...new Set(input.squares)].sort((a, b) => a - b)
  squaresToMask(squares)
  if (input.amountLamports <= 0n) throw new RangeError('amount must be positive')
  const live = await readOreLiveBoard(rpc, input.authority)
  if (live.phase === 'BETWEEN') throw new OreDeployError('ROUND_CLOSED', 'This round just closed. The next one opens in a few seconds.')
  if (live.phase === 'MINING' && live.board.endSlot - live.slot < ORE_MIN_SLOTS_TO_SIGN) {
    throw new OreDeployError('ROUND_ENDING', 'This round ends in a few seconds — wait for the next one.')
  }
  const sameRound = live.miner?.roundId === live.board.roundId
  if (sameRound && squares.some((s) => (live.miner?.deployed[s] ?? 0n) > 0n)) {
    throw new OreDeployError('SQUARE_TAKEN', 'You already deployed on that square this round.')
  }
  const needsCheckpoint = oreNeedsCheckpoint(live.miner, live.board.roundId)

  const { value: payer } = await rpc.getAccountInfo(input.authority, { encoding: 'base64', commitment: 'confirmed' }).send()
  if (payer && payer.owner !== SYSTEM_PROGRAM) throw new OreDeployError('WALLET_CANNOT_PAY', 'This wallet can’t pay Solana network fees. Use a regular wallet.')
  const minerRentLamports = live.miner ? 0n : await rpc.getMinimumBalanceForRentExemption(ORE_MINER_ACCOUNT_SPACE, { commitment: 'confirmed' }).send()
  const base = oreDeployCost({ amountLamports: input.amountLamports, squares: squares.length, miner: live.miner, minerRentLamports })
  const cost = { ...base, networkFee: ORE_BASE_FEE_LAMPORTS, total: base.total + ORE_BASE_FEE_LAMPORTS }
  if ((payer?.lamports ?? 0n) < cost.total) throw new OreDeployError('INSUFFICIENT_SOL', 'This wallet doesn’t have enough SOL for this deploy.')

  const instructions = [
    ...(needsCheckpoint && live.miner ? [await buildOreCheckpointInstruction({ authority: input.authority, roundId: live.miner.roundId })] : []),
    await buildOreDeployInstruction({ authority: input.authority, amountLamports: input.amountLamports, roundId: live.board.roundId, squares }),
  ]
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.authority, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc.simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }).send()
  if (sim.err) {
    const logs = [...(sim.logs ?? []), `error: ${JSON.stringify(sim.err, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`]
    if (logs.some((l) => l.includes('Miner has not checkpointed'))) {
      throw new OreDeployError('PREVIOUS_ROUND_UNSETTLED', 'Your previous ORE round is still being settled. Try again in a few seconds.', logs)
    }
    throw new OreDeployError('SIMULATION_FAILED', 'The network would reject this deploy.', logs)
  }
  return {
    transaction,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    roundId: live.board.roundId,
    endSlot: live.board.endSlot,
    slot: live.slot,
    squares,
    amountLamports: input.amountLamports,
    needsCheckpoint,
    cost,
  }
}

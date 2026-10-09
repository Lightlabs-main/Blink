import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetTokenAccountsByOwnerApi,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token-2022'

import { SKR_MINT } from './stake-readers.ts'

/*
 * SKR transfers paid by the sender's own wallet (tips, D-49; boosts, D-50). SKR is a classic SPL Token mint
 * (owner TokenkegQ…, 6 decimals, no freeze authority, no extensions — read from mainnet 2026-10-09). The
 * Token-2022 client builds the instructions with the classic program address: TransferChecked and the ATA
 * program's CreateIdempotent have the same layout for both programs.
 */
export const TOKEN_PROGRAM_ADDRESS = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const SKR_TOKEN_DECIMALS = 6
const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111')
/** An SPL Token account (no extensions) is 165 bytes. */
const TOKEN_ACCOUNT_SPACE = 165n
/** One signature (the sender) at the base fee. Wallets may add a priority fee on top. */
export const SKR_TRANSFER_BASE_FEE_LAMPORTS = 5_000n

type SkrRpc = Rpc<
  GetAccountInfoApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi & GetTokenAccountsByOwnerApi & SimulateTransactionApi
>

export type SkrTransferErrorCode = 'SAME_WALLET' | 'BAD_AMOUNT' | 'WRONG_MINT' | 'INSUFFICIENT_SKR' | 'INSUFFICIENT_SOL' | 'WALLET_CANNOT_PAY' | 'SIMULATION_FAILED'

export class SkrTransferError extends Error {
  override name = 'SkrTransferError'
  constructor(
    readonly code: SkrTransferErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

export interface SkrTransferPlan {
  /** Unsigned v0 transaction, base64 wire; the sender is the only signer and fee payer. */
  transaction: string
  lastValidBlockHeight: bigint
  source: Address
  destination: Address
  createsRecipientAccount: boolean
  /** Paid by the sender: token-account rent when the recipient has none yet, plus the base network fee. */
  rentLamports: bigint
  feeLamports: bigint
}

/** Verifies the SKR mint is what it was reviewed as (classic SPL Token, 6 decimals). */
async function assertSkrMint(rpc: SkrRpc) {
  const { value } = await rpc.getAccountInfo(SKR_MINT, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  const decimals = (value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals
  if (!value || value.owner !== TOKEN_PROGRAM_ADDRESS || decimals !== SKR_TOKEN_DECIMALS) {
    throw new SkrTransferError('WRONG_MINT', 'SKR could not be verified on this network.')
  }
}

/** Raw SKR held by `owner` in its associated token account (the only account a transfer here debits). */
async function ataBalance(rpc: SkrRpc, ata: Address): Promise<bigint | null> {
  const { value } = await rpc.getAccountInfo(ata, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()
  if (!value) return null
  if (value.owner !== TOKEN_PROGRAM_ADDRESS) throw new SkrTransferError('WRONG_MINT', 'Unexpected SKR token account.')
  const info = (value.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info
  if (info?.mint !== SKR_MINT) throw new SkrTransferError('WRONG_MINT', 'Unexpected SKR token account.')
  return BigInt(info.tokenAmount?.amount ?? '0')
}

/**
 * Exactly `amountRaw` SKR from `from`'s associated account to `to`'s (created idempotently when missing, paid by
 * the sender). No approval, no delegate: the sender signs only this transfer. Simulated before return.
 */
export async function buildSkrTransferTransaction(rpc: SkrRpc, input: { from: Address; to: Address; amountRaw: bigint }): Promise<SkrTransferPlan> {
  if (input.from === input.to) throw new SkrTransferError('SAME_WALLET', 'That’s your own wallet.')
  if (input.amountRaw <= 0n) throw new SkrTransferError('BAD_AMOUNT', 'Enter an amount of SKR.')
  await assertSkrMint(rpc)

  const [source] = await findAssociatedTokenPda({ owner: input.from, mint: SKR_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const [destination] = await findAssociatedTokenPda({ owner: input.to, mint: SKR_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  const held = await ataBalance(rpc, source)
  if (held === null || held < input.amountRaw) throw new SkrTransferError('INSUFFICIENT_SKR', 'This wallet doesn’t hold that much SKR.')
  const existing = await ataBalance(rpc, destination)
  const createsRecipientAccount = existing === null
  const rentLamports = createsRecipientAccount ? await rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE, { commitment: 'confirmed' }).send() : 0n
  // The sender pays the fee, so it must be an ordinary (System-owned) wallet with a little SOL.
  const { value: payer } = await rpc.getAccountInfo(input.from, { encoding: 'base64', commitment: 'confirmed' }).send()
  if (payer && payer.owner !== SYSTEM_PROGRAM_ADDRESS) throw new SkrTransferError('WALLET_CANNOT_PAY', 'This wallet can’t pay Solana network fees. Use a regular wallet.')
  const sol = payer?.lamports ?? 0n
  if (sol < rentLamports + SKR_TRANSFER_BASE_FEE_LAMPORTS) throw new SkrTransferError('INSUFFICIENT_SOL', 'This wallet needs a little SOL for the network fee.')

  const sender = createNoopSigner(input.from)
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({ payer: sender, ata: destination, owner: input.to, mint: SKR_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    getTransferCheckedInstruction(
      { source, mint: SKR_MINT, destination, authority: sender, amount: input.amountRaw, decimals: SKR_TOKEN_DECIMALS },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    ),
  ]
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.from, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc.simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }).send()
  if (sim.err) {
    const detail = JSON.stringify(sim.err, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
    throw new SkrTransferError('SIMULATION_FAILED', 'The network would reject this transfer.', [...(sim.logs ?? []), `error: ${detail}`])
  }
  return { transaction, lastValidBlockHeight: blockhash.lastValidBlockHeight, source, destination, createsRecipientAccount, rentLamports, feeLamports: SKR_TRANSFER_BASE_FEE_LAMPORTS }
}

interface TokenBalanceRow {
  accountIndex: number
  mint: string
  owner?: string
  programId?: string
  uiTokenAmount: { amount: string }
}
/** The token-balance parts of a json-encoded confirmed transaction. */
export interface TokenBalanceTx {
  meta: { err: unknown; preTokenBalances?: readonly TokenBalanceRow[] | null; postTokenBalances?: readonly TokenBalanceRow[] | null } | null
}

/** Net raw change of `mint` held by `owner` across every token account in the transaction. */
export function tokenDelta(tx: TokenBalanceTx, owner: string, mint: string): bigint {
  const sum = (rows: readonly TokenBalanceRow[] | null | undefined) =>
    (rows ?? []).filter((r) => r.mint === mint && r.owner === owner && (!r.programId || r.programId === TOKEN_PROGRAM_ADDRESS)).reduce((a, r) => a + BigInt(r.uiTokenAmount.amount), 0n)
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances)
}

/**
 * Independent check of a confirmed SKR transfer: the transaction succeeded, `from` lost exactly `amountRaw` SKR and
 * `to` gained exactly `amountRaw` SKR (balances as recorded by the validator, so a look-alike mint never counts).
 */
export function verifySkrTransfer(tx: TokenBalanceTx, expected: { from: string; to: string; amountRaw: bigint }): { ok: true } | { ok: false; reason: 'FAILED' | 'WRONG_AMOUNT' | 'WRONG_RECIPIENT' } {
  if (!tx.meta || tx.meta.err) return { ok: false, reason: 'FAILED' }
  const received = tokenDelta(tx, expected.to, SKR_MINT)
  const sent = tokenDelta(tx, expected.from, SKR_MINT)
  if (received === 0n) return { ok: false, reason: 'WRONG_RECIPIENT' }
  if (received !== expected.amountRaw || sent !== -expected.amountRaw) return { ok: false, reason: 'WRONG_AMOUNT' }
  return { ok: true }
}

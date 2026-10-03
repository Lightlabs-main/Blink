import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type Instruction,
  lamports,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  AccountState,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import { inspectMint, mintTransferBlockers } from './mint.ts'
import { estimateCampaignAccountRent } from './rent.ts'

type SendRpc = Rpc<GetAccountInfoApi & GetBalanceApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi & SimulateTransactionApi>

export type SendErrorCode = 'SAME_WALLET' | 'INSUFFICIENT_BALANCE' | 'MINT_BLOCKED' | 'MINT_DECIMALS_MISMATCH' | 'ACCOUNT_FROZEN' | 'LEAVES_DUST' | 'SIMULATION_FAILED'

export class SendError extends Error {
  override name = 'SendError'
  constructor(
    readonly code: SendErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

/** Two signatures (Blink fee payer + the sender) at the base fee of 5,000 lamports each. */
export const SEND_SIGNATURE_FEES_LAMPORTS = 10_000n
/** An associated token account carries the ImmutableOwner extension: 2-byte type + 2-byte length, no data. */
const IMMUTABLE_OWNER_EXTENSION_BYTES = 4n
/** Rent-exempt minimum of an empty system account; a SOL balance must end at 0 or at least this. */
const SYSTEM_ACCOUNT_RENT_EXEMPT = 890_880n

export type SendAsset = { kind: 'SOL' } | { kind: 'TOKEN'; mint: Address; decimals: number }

export interface SendPlan {
  /** Unsigned v0 transaction, base64 wire. Signers: Blink's fee payer, then the sender. */
  transaction: string
  lastValidBlockHeight: bigint
  createsRecipientAccount: boolean
  /** ESTIMATE of Blink-funded lamports: signature fees + recipient token-account rent when created. */
  estimatedLamports: bigint
}

/**
 * D-32: a transfer from a user's Blink stock wallet, with Blink's fee payer paying the network fee (and the
 * recipient's token-account rent when it does not exist yet). The sender only authorises its own transfer.
 * Simulated before return; nothing is signed here.
 */
export async function buildSendTransaction(
  rpc: SendRpc,
  input: { from: Address; to: Address; feePayer: Address; asset: SendAsset; amountRaw: bigint },
): Promise<SendPlan> {
  if (input.from === input.to) throw new SendError('SAME_WALLET', 'You can’t send to your own stock wallet.')
  if (input.amountRaw <= 0n) throw new SendError('INSUFFICIENT_BALANCE', 'Enter an amount to send.')
  const feePayer = createNoopSigner(input.feePayer)
  const sender = createNoopSigner(input.from)
  const instructions: Instruction[] = []
  let rentLamports = 0n
  let createsRecipientAccount = false

  if (input.asset.kind === 'SOL') {
    const { value: balance } = await rpc.getBalance(input.from, { commitment: 'confirmed' }).send()
    if (input.amountRaw > balance) throw new SendError('INSUFFICIENT_BALANCE', 'That is more SOL than this wallet holds.')
    const left = balance - input.amountRaw
    if (left > 0n && left < SYSTEM_ACCOUNT_RENT_EXEMPT) {
      throw new SendError('LEAVES_DUST', 'Send all of it, or leave at least 0.00089 SOL (Solana’s minimum balance).')
    }
    instructions.push(getTransferSolInstruction({ source: sender, destination: input.to, amount: lamports(input.amountRaw) }))
  } else {
    const mint = await inspectMint(rpc, input.asset.mint)
    if (mint.decimals !== input.asset.decimals) throw new SendError('MINT_DECIMALS_MISMATCH', 'This stock’s details changed; please try later.')
    const blockers = mintTransferBlockers(mint)
    if (blockers.length) throw new SendError('MINT_BLOCKED', 'This stock can’t be transferred right now.')

    const [source] = await findAssociatedTokenPda({ owner: input.from, mint: input.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const held = await fetchMaybeToken(rpc, source, { commitment: 'confirmed' })
    if (!held.exists || held.data.amount < input.amountRaw) throw new SendError('INSUFFICIENT_BALANCE', 'That is more than this wallet holds.')
    if (held.data.state === AccountState.Frozen) throw new SendError('ACCOUNT_FROZEN', 'Your stock account is frozen by the issuer.')

    const [destination] = await findAssociatedTokenPda({ owner: input.to, mint: input.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const existing = await fetchMaybeToken(rpc, destination, { commitment: 'confirmed' })
    if (existing.exists && existing.data.state === AccountState.Frozen) throw new SendError('ACCOUNT_FROZEN', 'The recipient’s stock account is frozen.')
    if (!existing.exists) {
      createsRecipientAccount = true
      const sized = await estimateCampaignAccountRent(rpc, { mint: input.asset.mint, simulationFeePayer: input.feePayer })
      rentLamports = await rpc.getMinimumBalanceForRentExemption(sized.accountSpace + IMMUTABLE_OWNER_EXTENSION_BYTES, { commitment: 'confirmed' }).send()
    }
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({ payer: feePayer, ata: destination, owner: input.to, mint: input.asset.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source, mint: input.asset.mint, destination, authority: sender, amount: input.amountRaw, decimals: input.asset.decimals }),
    )
  }

  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc
    .simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
    .send()
  if (sim.err) {
    throw new SendError('SIMULATION_FAILED', 'The network would reject this transfer.', sim.logs ?? [])
  }
  return {
    transaction,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    createsRecipientAccount,
    estimatedLamports: SEND_SIGNATURE_FEES_LAMPORTS + rentLamports,
  }
}

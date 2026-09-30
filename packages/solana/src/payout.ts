import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'
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

type PayoutRpc = Rpc<GetAccountInfoApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi & SimulateTransactionApi>

export type PayoutErrorCode = 'MINT_BLOCKED' | 'MINT_DECIMALS_MISMATCH' | 'RECIPIENT_ACCOUNT_FROZEN' | 'SIMULATION_FAILED'

export class PayoutError extends Error {
  override name = 'PayoutError'
  constructor(
    readonly code: PayoutErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

/** Two signatures (fee payer + delegate) at the base fee of 5,000 lamports each. No priority fee (§8). */
export const PAYOUT_SIGNATURE_FEES_LAMPORTS = 10_000n

/** An associated token account carries the ImmutableOwner extension: 2-byte type + 2-byte length, no data. */
const IMMUTABLE_OWNER_EXTENSION_BYTES = 4n

export interface PayoutPlan {
  /** Unsigned v0 transaction, base64 wire. Signers: feePayer, then delegate. */
  transaction: string
  lastValidBlockHeight: bigint
  recipientTokenAccount: Address
  /** True when the transaction creates the recipient's token account (Blink pays its rent, §8). */
  createsRecipientAccount: boolean
  /** ESTIMATE of Blink-funded lamports: signature fees + recipient account rent when created. */
  estimatedLamports: bigint
}

/**
 * Reward payout (MASTER_PROMPT §8, §9; DECISIONS D-13):
 *  1. CreateAssociatedTokenIdempotent for the recipient (payer = Blink fee payer),
 *  2. TransferChecked campaign account → recipient, authority = the campaign's delegate (exact allowance).
 * The fee payer never holds stock or delegate authority (§16). Simulated before return; nothing is signed here.
 */
export async function buildPayoutTransaction(
  rpc: PayoutRpc,
  input: {
    campaignAccount: Address
    mint: Address
    expectedDecimals: number
    delegate: Address
    recipient: Address
    feePayer: Address
    amountRaw: bigint
  },
): Promise<PayoutPlan> {
  const mint = await inspectMint(rpc, input.mint)
  if (mint.decimals !== input.expectedDecimals) {
    throw new PayoutError('MINT_DECIMALS_MISMATCH', `mint decimals ${mint.decimals} != expected ${input.expectedDecimals}`)
  }
  const blockers = mintTransferBlockers(mint)
  if (blockers.length) throw new PayoutError('MINT_BLOCKED', `stock cannot be transferred right now: ${blockers.join(', ')}`)

  const [recipientAta] = await findAssociatedTokenPda({ owner: input.recipient, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const existing = await fetchMaybeToken(rpc, recipientAta, { commitment: 'confirmed' })
  if (existing.exists && existing.data.state === AccountState.Frozen) {
    throw new PayoutError('RECIPIENT_ACCOUNT_FROZEN', 'the recipient token account is frozen')
  }

  let rentLamports = 0n
  if (!existing.exists) {
    const campaignSized = await estimateCampaignAccountRent(rpc, { mint: input.mint, simulationFeePayer: input.feePayer })
    rentLamports = await rpc
      .getMinimumBalanceForRentExemption(campaignSized.accountSpace + IMMUTABLE_OWNER_EXTENSION_BYTES, { commitment: 'confirmed' })
      .send()
  }

  const feePayer = createNoopSigner(input.feePayer)
  const instructions = [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: feePayer,
      ata: recipientAta,
      owner: input.recipient,
      mint: input.mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getTransferCheckedInstruction({
      source: input.campaignAccount,
      mint: input.mint,
      destination: recipientAta,
      authority: createNoopSigner(input.delegate),
      amount: input.amountRaw,
      decimals: input.expectedDecimals,
    }),
  ]

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
    throw new PayoutError('SIMULATION_FAILED', `payout simulation failed: ${JSON.stringify(sim.err, bigintReplacer)}`, sim.logs ?? [])
  }

  return {
    transaction,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    recipientTokenAccount: recipientAta,
    createsRecipientAccount: !existing.exists,
    estimatedLamports: PAYOUT_SIGNATURE_FEES_LAMPORTS + rentLamports,
  }
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

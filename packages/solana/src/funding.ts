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
import { getCreateAccountWithSeedInstruction } from '@solana-program/system'
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getInitializeAccount3Instruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import { assertStoredCampaignAccount, checkCampaignAccountBeforeCreation } from './campaign-account.ts'
import { inspectMint, mintTransferBlockers } from './mint.ts'
import { estimateCampaignAccountRent } from './rent.ts'

type FundingRpc = Rpc<GetAccountInfoApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi & SimulateTransactionApi>

export type FundingErrorCode =
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'MINT_BLOCKED'
  | 'MINT_DECIMALS_MISMATCH'
  | 'NO_CREATOR_TOKEN_ACCOUNT'
  | 'INSUFFICIENT_STOCK'
  | 'SIMULATION_FAILED'

export class FundingError extends Error {
  override name = 'FundingError'
  constructor(
    readonly code: FundingErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

export interface FundingPlan {
  /** Unsigned v0 transaction, base64 wire format. Fee payer and only signer: the creator. */
  transaction: string
  /** Slot of the blockhash context; pass to the wallet as minContextSlot. */
  minContextSlot: bigint
  lastValidBlockHeight: bigint
  campaignAccount: Address
  creatorTokenAccount: Address
  rentLamports: bigint
  accountSpace: bigint
  amountRaw: bigint
  delegate: Address
}

/**
 * MASTER_PROMPT §8–§13: ONE creator-signed transaction that
 *  1. CreateAccountWithSeed (base = creator, seed = campaign seed, owner = Token-2022, space from the program),
 *  2. InitializeAccount3 (mint, token authority = creator),
 *  3. TransferChecked creator ATA → campaign account (exactly the campaign amount),
 *  4. ApproveChecked the campaign's delegate for exactly that amount.
 * The creator pays rent and fees (§8). Nothing is signed here; the transaction is simulated before return.
 */
export async function buildFundingTransaction(
  rpc: FundingRpc,
  input: {
    creator: Address
    campaignSeed: string
    storedCampaignAccount: string
    mint: Address
    expectedDecimals: number
    amountRaw: bigint
    delegate: Address
  },
): Promise<FundingPlan> {
  const account = await assertStoredCampaignAccount({
    creator: input.creator,
    campaignSeed: input.campaignSeed,
    storedAccount: input.storedCampaignAccount,
  })

  // §11: the derived account must not exist yet — never silently pick another address.
  const pre = await checkCampaignAccountBeforeCreation(rpc, account)
  if (pre.status === 'exists') throw new FundingError('ACCOUNT_ALREADY_EXISTS', `campaign account ${account} already exists`)

  const mint = await inspectMint(rpc, input.mint)
  if (mint.decimals !== input.expectedDecimals) {
    throw new FundingError('MINT_DECIMALS_MISMATCH', `mint decimals ${mint.decimals} != expected ${input.expectedDecimals}`)
  }
  const blockers = mintTransferBlockers(mint)
  if (blockers.length) throw new FundingError('MINT_BLOCKED', `stock cannot be transferred right now: ${blockers.join(', ')}`)

  const [creatorAta] = await findAssociatedTokenPda({
    owner: input.creator,
    mint: input.mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  })
  const ata = await fetchMaybeToken(rpc, creatorAta, { commitment: 'confirmed' })
  if (!ata.exists) throw new FundingError('NO_CREATOR_TOKEN_ACCOUNT', 'your wallet holds none of this stock')
  if (ata.data.amount < input.amountRaw) {
    throw new FundingError('INSUFFICIENT_STOCK', `wallet holds ${ata.data.amount} raw, campaign needs ${input.amountRaw}`)
  }

  const rent = await estimateCampaignAccountRent(rpc, { mint: input.mint, simulationFeePayer: input.creator })
  const creatorSigner = createNoopSigner(input.creator)

  const instructions = [
    getCreateAccountWithSeedInstruction({
      payer: creatorSigner,
      newAccount: account,
      base: input.creator,
      seed: input.campaignSeed,
      amount: rent.rentExemptLamports,
      space: rent.accountSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction({ account, mint: input.mint, owner: input.creator }),
    getTransferCheckedInstruction({
      source: creatorAta,
      mint: input.mint,
      destination: account,
      authority: creatorSigner,
      amount: input.amountRaw,
      decimals: input.expectedDecimals,
    }),
    getApproveCheckedInstruction({
      source: account,
      mint: input.mint,
      delegate: input.delegate,
      owner: creatorSigner,
      amount: input.amountRaw,
      decimals: input.expectedDecimals,
    }),
  ]

  const { context, value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.creator, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))

  // DECISIONS D-12: must simulate cleanly before the wallet is ever opened.
  const { value: sim } = await rpc
    .simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
    .send()
  if (sim.err) {
    throw new FundingError('SIMULATION_FAILED', `funding simulation failed: ${stringify(sim.err)}`, sim.logs ?? [])
  }

  return {
    transaction,
    minContextSlot: context.slot,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    campaignAccount: account,
    creatorTokenAccount: creatorAta,
    rentLamports: rent.rentExemptLamports,
    accountSpace: rent.accountSpace,
    amountRaw: input.amountRaw,
    delegate: input.delegate,
  }
}

function stringify(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
}

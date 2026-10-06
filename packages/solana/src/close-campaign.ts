import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type Instruction,
  isSome,
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
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getRevokeInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import { assertStoredCampaignAccount } from './campaign-account.ts'
import { inspectMint, mintTransferBlockers } from './mint.ts'

type CloseRpc = Rpc<GetAccountInfoApi & GetLatestBlockhashApi & SimulateTransactionApi>

export type CloseErrorCode = 'ACCOUNT_MISSING' | 'WRONG_OWNER' | 'WRONG_MINT' | 'FROZEN' | 'MINT_BLOCKED' | 'SIMULATION_FAILED'

export class CloseCampaignError extends Error {
  override name = 'CloseCampaignError'
  constructor(
    readonly code: CloseErrorCode,
    message: string,
    readonly logs: readonly string[] = [],
  ) {
    super(message)
  }
}

export interface ClosePlan {
  /** Unsigned v0 transaction, base64. Fee payer and only signer: the creator. */
  transaction: string
  minContextSlot: bigint
  lastValidBlockHeight: bigint
  campaignAccount: Address
  creatorTokenAccount: Address
  /** Stock moved back to the creator's own token account (raw units). */
  returnRaw: bigint
  /** Rent the closed account returns to the creator. */
  rentLamports: bigint
  revokedDelegate: Address | null
}

/**
 * Creator wind-down (pre-mainnet gate W-1): ONE creator-signed transaction that
 *  1. Revokes the campaign delegate (Blink can no longer move anything),
 *  2. creates the creator's token account if it no longer exists (idempotent, creator pays),
 *  3. TransferChecked the whole remaining balance campaign account → creator's token account,
 *  4. CloseAccount: the campaign account's rent goes back to the creator.
 * Re-derives the campaign account from the creator and seed (never trusts a stored or client address) and checks
 * owner and mint before building. Nothing is signed here; the transaction is simulated before return.
 */
export async function buildCloseCampaignTransaction(
  rpc: CloseRpc,
  input: { creator: Address; campaignSeed: string; storedCampaignAccount: string; mint: Address; expectedDecimals: number },
): Promise<ClosePlan> {
  const account = await assertStoredCampaignAccount({ creator: input.creator, campaignSeed: input.campaignSeed, storedAccount: input.storedCampaignAccount })
  const maybe = await fetchMaybeToken(rpc, account, { commitment: 'confirmed' })
  if (!maybe.exists) throw new CloseCampaignError('ACCOUNT_MISSING', 'this drop’s campaign account no longer exists (already closed?)')
  const t = maybe.data
  if (t.owner !== input.creator) throw new CloseCampaignError('WRONG_OWNER', 'the campaign account is not owned by the creator wallet')
  if (t.mint !== input.mint) throw new CloseCampaignError('WRONG_MINT', 'the campaign account holds a different stock')
  if (t.state === AccountState.Frozen) throw new CloseCampaignError('FROZEN', 'the issuer has frozen this account; it cannot be closed right now')

  const creatorSigner = createNoopSigner(input.creator)
  const [creatorAta] = await findAssociatedTokenPda({ owner: input.creator, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const delegate = isSome(t.delegate) ? t.delegate.value : null

  const instructions: Instruction[] = []
  if (delegate) instructions.push(getRevokeInstruction({ source: account, owner: creatorSigner }))
  if (t.amount > 0n) {
    const mint = await inspectMint(rpc, input.mint)
    if (mint.decimals !== input.expectedDecimals) throw new CloseCampaignError('WRONG_MINT', `mint decimals ${mint.decimals} != expected ${input.expectedDecimals}`)
    const blockers = mintTransferBlockers(mint)
    if (blockers.length) throw new CloseCampaignError('MINT_BLOCKED', `stock cannot be moved right now: ${blockers.join(', ')}`)
    instructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: creatorSigner, owner: input.creator, mint: input.mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source: account, mint: input.mint, destination: creatorAta, authority: creatorSigner, amount: t.amount, decimals: input.expectedDecimals }),
    )
  }
  instructions.push(getCloseAccountInstruction({ account, destination: input.creator, owner: creatorSigner }))

  const info = await rpc.getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' }).send()
  const rentLamports = info.value ? BigInt(info.value.lamports) : 0n

  const { context, value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.creator, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc.simulateTransaction(transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }).send()
  if (sim.err) throw new CloseCampaignError('SIMULATION_FAILED', `close simulation failed: ${JSON.stringify(sim.err, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`, sim.logs ?? [])

  return {
    transaction,
    minContextSlot: context.slot,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    campaignAccount: account,
    creatorTokenAccount: creatorAta,
    returnRaw: t.amount,
    rentLamports,
    revokedDelegate: delegate,
  }
}

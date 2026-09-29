import {
  type Address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  getU64Decoder,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SimulateTransactionApi,
} from '@solana/kit'
import { getGetAccountDataSizeInstruction } from '@solana-program/token-2022'

export class RentEstimateError extends Error {
  override name = 'RentEstimateError'
}

type RentRpc = Rpc<SimulateTransactionApi & GetLatestBlockhashApi & GetMinimumBalanceForRentExemptionApi>

export interface CampaignAccountRentEstimate {
  mint: Address
  /** Bytes required for a Token-2022 account of this mint, as reported by the Token-2022 program itself. */
  accountSpace: bigint
  rentExemptLamports: bigint
  source: 'token-2022 GetAccountDataSize simulation'
}

/**
 * MASTER_PROMPT §13: never assume 165 bytes. Ask the Token-2022 program for the required account size
 * (GetAccountDataSize returns it as u64 LE return data), then query the rent-exempt minimum.
 *
 * Read-only: simulation with sigVerify=false and replaceRecentBlockhash=true; nothing is signed or sent.
 * `simulationFeePayer` must be an existing system account on the cluster (e.g. the creator's wallet).
 */
export async function estimateCampaignAccountRent(
  rpc: RentRpc,
  input: { mint: Address; simulationFeePayer: Address },
): Promise<CampaignAccountRentEstimate> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.simulationFeePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(getGetAccountDataSizeInstruction({ mint: input.mint }), m),
  )
  const wire = getBase64EncodedWireTransaction(compileTransaction(message))
  const { value: sim } = await rpc
    .simulateTransaction(wire, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })
    .send()
  if (sim.err) {
    throw new RentEstimateError(`GetAccountDataSize simulation failed: ${JSON.stringify(sim.err, bigintReplacer)}`)
  }
  const accountSpace = decodeAccountSizeReturnData(sim.returnData?.data?.[0])
  const rentExemptLamports = await rpc.getMinimumBalanceForRentExemption(accountSpace, { commitment: 'confirmed' }).send()
  return {
    mint: input.mint,
    accountSpace,
    rentExemptLamports,
    source: 'token-2022 GetAccountDataSize simulation',
  }
}

export function decodeAccountSizeReturnData(base64Data: string | undefined): bigint {
  if (!base64Data) throw new RentEstimateError('GetAccountDataSize returned no data')
  const bytes = getBase64Encoder().encode(base64Data)
  if (bytes.length !== 8) throw new RentEstimateError(`expected 8-byte u64 return data, got ${bytes.length} bytes`)
  return getU64Decoder().decode(bytes)
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

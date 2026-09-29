import { type Address, createAddressWithSeed, fetchEncodedAccount, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

import { assertSeedLength } from './campaign-seed.ts'

/**
 * MASTER_PROMPT §11: base = authenticated creator wallet, seed = campaign seed, owner program = Token-2022.
 * Always derive server-side; never accept a campaign-account address from the client.
 */
export async function deriveCampaignTokenAccount(input: { creator: Address; campaignSeed: string }): Promise<Address> {
  assertSeedLength(input.campaignSeed)
  return createAddressWithSeed({
    baseAddress: input.creator,
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    seed: input.campaignSeed,
  })
}

export class CampaignAccountMismatchError extends Error {
  override name = 'CampaignAccountMismatchError'
}

/** Re-derive and compare with the stored value before every operation. */
export async function assertStoredCampaignAccount(input: {
  creator: Address
  campaignSeed: string
  storedAccount: string
}): Promise<Address> {
  const derived = await deriveCampaignTokenAccount(input)
  if (derived !== input.storedAccount) {
    throw new CampaignAccountMismatchError(
      `stored campaign account ${input.storedAccount} does not match derived ${derived}`,
    )
  }
  return derived
}

export type PreCreationCheck = { status: 'absent' } | { status: 'exists'; owner: Address; lamports: bigint }

/**
 * MASTER_PROMPT §11: if the derived address unexpectedly already exists → STOP AND INVESTIGATE.
 * Callers must treat `exists` as a hard stop before creation, never pick another address.
 */
export async function checkCampaignAccountBeforeCreation(
  rpc: Rpc<GetAccountInfoApi>,
  account: Address,
): Promise<PreCreationCheck> {
  const maybe = await fetchEncodedAccount(rpc, account, { commitment: 'confirmed' })
  if (!maybe.exists) return { status: 'absent' }
  return { status: 'exists', owner: maybe.programAddress, lamports: maybe.lamports }
}

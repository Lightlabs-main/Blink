import {
  type Address,
  address,
  fetchEncodedAccounts,
  type GetMultipleAccountsApi,
  type GetTokenAccountsByOwnerApi,
  isSome,
  type Rpc,
} from '@solana/kit'
import { decodeMint, type Extension, type Mint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

/**
 * Seeker Genesis Token (SGT) constants — VERIFIED 2026-10-01 against Solana Mobile's official sources:
 *  - docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token (metadata + group address, extension checks)
 *  - github.com/solana-mobile/solana-mobile-dev-skill, skills/seeker-genesis-token/references/sgt-verification.md
 *    (mint authority, the four mint checks, "skip empty token accounts").
 * SGTs exist on mainnet-beta only.
 */
export const SGT_MINT_AUTHORITY = address('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4')
export const SGT_METADATA_ADDRESS = address('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te')
export const SGT_GROUP_MINT_ADDRESS = address('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te')

/**
 * The official checks on a decoded Token-2022 mint: mint authority, MetadataPointer authority + address, and
 * TokenGroupMember group. Additionally the member record must name this mint (anti-spoofing).
 */
export function isSeekerGenesisMint(mintAddress: Address, mint: Pick<Mint, 'mintAuthority' | 'extensions'>): boolean {
  const extensions: Extension[] = isSome(mint.extensions) ? mint.extensions.value : []
  const pointer = extensions.find((e) => e.__kind === 'MetadataPointer')
  const member = extensions.find((e) => e.__kind === 'TokenGroupMember')
  return (
    isSome(mint.mintAuthority) &&
    mint.mintAuthority.value === SGT_MINT_AUTHORITY &&
    pointer !== undefined &&
    isSome(pointer.authority) &&
    pointer.authority.value === SGT_MINT_AUTHORITY &&
    isSome(pointer.metadataAddress) &&
    pointer.metadataAddress.value === SGT_METADATA_ADDRESS &&
    member !== undefined &&
    member.group === SGT_GROUP_MINT_ADDRESS &&
    member.mint === mintAddress
  )
}

type SeekerRpc = Rpc<GetTokenAccountsByOwnerApi & GetMultipleAccountsApi>

/**
 * The SGT mint held (non-zero balance) by `owner`, or null. Uses standard RPC (MASTER_PROMPT §20 option A); the
 * official guide notes standard getTokenAccountsByOwner works when holdings are modest. Mainnet RPC only.
 */
export async function findSeekerGenesisToken(rpc: SeekerRpc, owner: Address): Promise<Address | null> {
  const { value } = await rpc
    .getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'jsonParsed', commitment: 'confirmed' })
    .send()
  // Skip empty token accounts: a transferred SGT leaves a zero-balance account behind.
  const mints = [
    ...new Set(
      value
        .map((a) => a.account.data.parsed.info as { mint?: string; tokenAmount?: { amount?: string } })
        .filter((info) => info.mint && info.tokenAmount?.amount && info.tokenAmount.amount !== '0')
        .map((info) => info.mint!),
    ),
  ].map((m) => address(m))

  for (let i = 0; i < mints.length; i += 100) {
    const accounts = await fetchEncodedAccounts(rpc, mints.slice(i, i + 100), { commitment: 'confirmed' })
    for (const account of accounts) {
      if (!account.exists || account.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) continue
      let decoded
      try {
        decoded = decodeMint(account)
      } catch {
        continue
      }
      if (isSeekerGenesisMint(account.address, decoded.data)) return account.address
    }
  }
  return null
}

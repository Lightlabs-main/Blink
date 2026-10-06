import { type Address, fetchEncodedAccount, type GetAccountInfoApi, isSome, type Rpc } from '@solana/kit'
import { decodeMint, type Extension, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

export interface ScaledUiConfig {
  multiplier: number
  newMultiplier: number
  newMultiplierEffectiveTimestamp: bigint
}

export interface MintInspection {
  mint: Address
  ownerProgram: Address
  isToken2022: boolean
  decimals: number
  supply: bigint
  mintAuthority: Address | null
  freezeAuthority: Address | null
  extensionKinds: string[]
  scaledUi: ScaledUiConfig | null
  pausable: { paused: boolean } | null
  /** TransferHook program if one is set; null when absent or the all-zero "none" value. */
  transferHookProgramId: Address | null
  /** DefaultAccountState for new token accounts; null when the extension is absent (= Initialized). */
  defaultAccountState: number | null
  /** Extensions that can block or alter transfers; campaign creation must review these. */
  transferAffectingExtensions: string[]
}

/** All-zero pubkey: the "none" value of OptionalNonZeroPubkey fields (observed on xStocks' TransferHook). */
const ZERO_PUBKEY = '11111111111111111111111111111111'

export type MintTransferBlocker = 'PAUSED' | 'TRANSFER_HOOK_ACTIVE' | 'DEFAULT_FROZEN'

/**
 * Reasons a campaign must not be funded or paid out right now (MASTER_PROMPT §9: pause if invalid).
 * Re-check before every funding and payout; the issuer can change these at any time.
 */
export function mintTransferBlockers(m: MintInspection): MintTransferBlocker[] {
  const out: MintTransferBlocker[] = []
  if (m.pausable?.paused) out.push('PAUSED')
  if (m.transferHookProgramId) out.push('TRANSFER_HOOK_ACTIVE')
  if (m.defaultAccountState !== null && m.defaultAccountState !== 1) out.push('DEFAULT_FROZEN')
  return out
}

export class MintInspectionError extends Error {
  override name = 'MintInspectionError'
}

/** Mint extensions that can make a plain TransferChecked fail or behave differently. */
const TRANSFER_AFFECTING = new Set([
  'TransferFeeConfig',
  'TransferHook',
  'NonTransferable',
  'PausableConfig',
  'ConfidentialTransferMint',
  'DefaultAccountState',
  'PermanentDelegate',
])

export async function inspectMint(rpc: Rpc<GetAccountInfoApi>, mint: Address): Promise<MintInspection> {
  const encoded = await fetchEncodedAccount(rpc, mint, { commitment: 'confirmed' })
  if (!encoded.exists) throw new MintInspectionError(`mint ${mint} does not exist on this cluster`)
  const isToken2022 = encoded.programAddress === TOKEN_2022_PROGRAM_ADDRESS
  if (!isToken2022) {
    throw new MintInspectionError(`mint ${mint} is owned by ${encoded.programAddress}, not Token-2022`)
  }
  const { data } = decodeMint(encoded)
  if (!data.isInitialized) throw new MintInspectionError(`mint ${mint} is not initialized`)
  const extensions: Extension[] = isSome(data.extensions) ? data.extensions.value : []
  const scaled = extensions.find((e) => e.__kind === 'ScaledUiAmountConfig')
  const pausable = extensions.find((e) => e.__kind === 'PausableConfig')
  const hook = extensions.find((e) => e.__kind === 'TransferHook')
  const defaultState = extensions.find((e) => e.__kind === 'DefaultAccountState')
  const kinds = extensions.map((e) => e.__kind)
  return {
    mint,
    ownerProgram: encoded.programAddress,
    isToken2022,
    decimals: data.decimals,
    supply: data.supply,
    mintAuthority: isSome(data.mintAuthority) ? data.mintAuthority.value : null,
    freezeAuthority: isSome(data.freezeAuthority) ? data.freezeAuthority.value : null,
    extensionKinds: kinds,
    scaledUi: scaled
      ? {
          multiplier: scaled.multiplier,
          newMultiplier: scaled.newMultiplier,
          newMultiplierEffectiveTimestamp: scaled.newMultiplierEffectiveTimestamp,
        }
      : null,
    pausable: pausable ? { paused: pausable.paused } : null,
    transferHookProgramId: hook && hook.programId !== ZERO_PUBKEY ? hook.programId : null,
    defaultAccountState: defaultState ? Number(defaultState.state) : null,
    transferAffectingExtensions: kinds.filter((k) => TRANSFER_AFFECTING.has(k)),
  }
}

/**
 * Effective Scaled UI multiplier at a given unix timestamp (seconds).
 * VERIFIED 2026-09-29 against @solana-program/token-2022@0.19.0 src (amountToUiAmountForMintWithoutSimulation):
 * `if (timestamp >= newMultiplierEffectiveTimestamp) multiplier = newMultiplier`.
 * Callers must pass the cluster Clock timestamp, not the device clock.
 */
/**
 * Pre-mainnet gate W-2 (xStocks guidance, docs.xstocks.fi/developers/multipliers): pause interactions for a brief window
 * (15 min) before and after each multiplier activation. True when `nowUnix` is within `windowSeconds` of a set
 * activation timestamp. Raw transfer amounts are unaffected; this avoids moving stock while displays and books update.
 */
export const MULTIPLIER_UPDATE_WINDOW_SECONDS = 900n
export function multiplierUpdateInProgress(config: ScaledUiConfig | null, nowUnix: bigint, windowSeconds = MULTIPLIER_UPDATE_WINDOW_SECONDS): boolean {
  if (!config || config.newMultiplierEffectiveTimestamp <= 0n) return false
  const d = nowUnix - config.newMultiplierEffectiveTimestamp
  return d >= -windowSeconds && d <= windowSeconds
}

export function effectiveScaledUiMultiplier(config: ScaledUiConfig, clusterUnixTimestamp: bigint): number {
  return clusterUnixTimestamp >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier
}

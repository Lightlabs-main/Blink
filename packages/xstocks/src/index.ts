/**
 * Supported xStocks for campaigns.
 *
 * Every mint here was verified two ways on 2026-09-29 (MASTER_PROMPT §5.2):
 *  1. Official Backed API: GET https://api.backed.fi/api/v2/public/assets (deployments[network=Solana].address)
 *  2. Onchain (mainnet): owner = Token-2022, decimals = 8, ScaledUiAmountConfig present, not paused
 *     via `tsx scripts/inspect-xstock.ts`.
 *
 * Do not add entries from memory. Re-run both checks and update `verifiedAt`.
 */
export interface SupportedXStock {
  symbol: string
  name: string
  mint: string
  decimals: number
  verifiedAt: string
}

export const SUPPORTED_XSTOCKS: readonly SupportedXStock[] = [
  { symbol: 'NVDAx', name: 'NVIDIA xStock', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8, verifiedAt: '2026-09-29' },
  { symbol: 'TSLAx', name: 'Tesla xStock', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, verifiedAt: '2026-09-29' },
  { symbol: 'AAPLx', name: 'Apple xStock', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8, verifiedAt: '2026-09-29' },
  { symbol: 'SPYx', name: 'SP500 xStock', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', decimals: 8, verifiedAt: '2026-09-29' },
]

export function findXStockByMint(mint: string): SupportedXStock | undefined {
  return SUPPORTED_XSTOCKS.find((x) => x.mint === mint)
}

/**
 * Extensions observed on every supported xStock mint (2026-09-29). A payout must re-inspect the mint and
 * pause the campaign if the live state diverges from what was reviewed:
 *  - TransferHook.programId must still be unset (all-zero pubkey '11111111111111111111111111111111').
 *  - PausableConfig.paused must be false.
 *  - DefaultAccountState must be Initialized (1), otherwise new accounts are frozen.
 * PermanentDelegate is set to the issuer: the issuer can move tokens from any holder account. Disclose it.
 */
export const REVIEWED_XSTOCK_EXTENSIONS = [
  'MetadataPointer',
  'PermanentDelegate',
  'DefaultAccountState',
  'ScaledUiAmountConfig',
  'PausableConfig',
  'ConfidentialTransferMint',
  'TransferHook',
  'TokenMetadata',
] as const

export class ScaledUiError extends Error {
  override name = 'ScaledUiError'
}

/**
 * Multiplier as an exact fraction (numerator / 10^scale) from its shortest round-trip decimal form,
 * so bigint math uses the same value the f64 holds without extra rounding.
 */
export function multiplierToFraction(multiplier: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new ScaledUiError('multiplier must be a positive finite number')
  const text = multiplier.toString()
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ScaledUiError(`unsupported multiplier representation '${text}'`)
  const [i = '0', f = ''] = text.split('.')
  return { numerator: BigInt(i + f), denominator: 10n ** BigInt(f.length) }
}

/**
 * Display-only: raw base units → UI shares (raw / 10^decimals * multiplier), floored to displayDecimals.
 * Payouts are ALWAYS computed and sent in raw base units; this never feeds a transaction.
 * Pass the effective multiplier from the cluster clock (see effectiveScaledUiMultiplier in @blink/solana).
 */
export function rawToUiShares(raw: bigint, decimals: number, multiplier: number, displayDecimals = 6): string {
  if (raw < 0n) throw new ScaledUiError('raw amount must be non-negative')
  const m = multiplierToFraction(multiplier)
  const unit = 10n ** BigInt(displayDecimals)
  const scaled = (raw * m.numerator * unit) / (10n ** BigInt(decimals) * m.denominator)
  const whole = scaled / unit
  const frac = (scaled % unit).toString().padStart(displayDecimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/**
 * UI shares (decimal string, e.g. '0.01') → raw base units, rounded DOWN:
 * floor(shares * 10^decimals / multiplier). A campaign never promises more than it can pay.
 */
export function uiSharesToRawFloor(uiShares: string, decimals: number, multiplier: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(uiShares)) throw new ScaledUiError(`invalid share amount '${uiShares}'`)
  const m = multiplierToFraction(multiplier)
  const [i = '0', f = ''] = uiShares.split('.')
  const shares = BigInt(i + f)
  const sharesScale = 10n ** BigInt(f.length)
  return (shares * 10n ** BigInt(decimals) * m.denominator) / (sharesScale * m.numerator)
}

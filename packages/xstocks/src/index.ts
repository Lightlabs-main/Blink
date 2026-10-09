/**
 * Supported xStocks for campaigns.
 *
 * Every mint here was verified two ways on 2026-09-29 (MASTER_PROMPT §5.2):
 *  1. Official Backed API: GET https://api.backed.fi/api/v2/public/assets (deployments[network=Solana].address)
 *  2. Onchain (mainnet): owner = Token-2022, decimals = 8, ScaledUiAmountConfig present, not paused
 * Logos are the official Backed API `logo` values (HTTP 200 checked 2026-09-29).
 *     via `tsx scripts/inspect-xstock.ts`.
 *
 * Do not add entries from memory. Re-run both checks and update `verifiedAt`.
 */
export interface SupportedXStock {
  symbol: string
  name: string
  mint: string
  decimals: number
  logo: string
  verifiedAt: string
}

export const SUPPORTED_XSTOCKS: readonly SupportedXStock[] = [
  { symbol: 'NVDAx', name: 'NVIDIA xStock', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png', verifiedAt: '2026-09-29' },
  { symbol: 'TSLAx', name: 'Tesla xStock', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png', verifiedAt: '2026-09-29' },
  { symbol: 'AAPLx', name: 'Apple xStock', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/AAPLx.png', verifiedAt: '2026-09-29' },
  { symbol: 'SPYx', name: 'SP500 xStock', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/SPYx.png', verifiedAt: '2026-09-29' },
  // 2026-10-09: official API api.xstocks.fi/api/v2/public/assets/{SYMBOL} (Solana deployment) + onchain: Token-2022,
  // 8 decimals, only REVIEWED_XSTOCK_EXTENSIONS, not paused, no transfer hook, DefaultAccountState initialized, no
  // multiplier change pending. NFLXx carries a 10x multiplier (stock split); payouts use raw units.
  { symbol: 'QQQx', name: 'Nasdaq xStock', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/QQQx.png', verifiedAt: '2026-10-09' },
  { symbol: 'MSFTx', name: 'Microsoft xStock', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/MSFTx.png', verifiedAt: '2026-10-09' },
  { symbol: 'GOOGLx', name: 'Alphabet xStock', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/GOOGLx.png', verifiedAt: '2026-10-09' },
  { symbol: 'AMZNx', name: 'Amazon.com xStock', mint: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/AMZNx.png', verifiedAt: '2026-10-09' },
  { symbol: 'METAx', name: 'Meta xStock', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/METAx.png', verifiedAt: '2026-10-09' },
  { symbol: 'COINx', name: 'Coinbase xStock', mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/COINx.png', verifiedAt: '2026-10-09' },
  { symbol: 'MSTRx', name: 'MicroStrategy xStock', mint: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/MSTRx.png', verifiedAt: '2026-10-09' },
  { symbol: 'HOODx', name: 'Robinhood xStock', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/HOODx.png', verifiedAt: '2026-10-09' },
  { symbol: 'CRCLx', name: 'Circle xStock', mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/CRCLx.png', verifiedAt: '2026-10-09' },
  { symbol: 'PLTRx', name: 'Palantir xStock', mint: 'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/PLTRx.png', verifiedAt: '2026-10-09' },
  { symbol: 'NFLXx', name: 'Netflix xStock', mint: 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL', decimals: 8, logo: 'https://xstocks-metadata.backed.fi/logos/tokens/NFLXx.png', verifiedAt: '2026-10-09' },
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

/** 10^n as bigint without the ** operator (portable to Hermes/Babel targets on mobile). */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 38) throw new ScaledUiError('exponent out of range')
  let r = 1n
  for (let i = 0; i < n; i++) r *= 10n
  return r
}

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
  return { numerator: BigInt(i + f), denominator: pow10(f.length) }
}

/**
 * Display-only: raw base units → UI shares (raw / 10^decimals * multiplier), floored to displayDecimals.
 * Payouts are ALWAYS computed and sent in raw base units; this never feeds a transaction.
 * Pass the effective multiplier from the cluster clock (see effectiveScaledUiMultiplier in @blink/solana).
 */
export function rawToUiShares(raw: bigint, decimals: number, multiplier: number, displayDecimals = 6): string {
  if (raw < 0n) throw new ScaledUiError('raw amount must be non-negative')
  const m = multiplierToFraction(multiplier)
  const unit = pow10(displayDecimals)
  const scaled = (raw * m.numerator * unit) / (pow10(decimals) * m.denominator)
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
  const sharesScale = pow10(f.length)
  return (shares * pow10(decimals) * m.denominator) / (sharesScale * m.numerator)
}

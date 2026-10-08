/**
 * Build-time feature flags. Flags that are false are off in the submitted build; their code is kept for later.
 *
 * - `inAppSkrStaking` (D-23, disabled by D-48): Blink's own SKR stake / unstake screen (`/skr`). Off: SKR staking
 *   happens on Solana Mobile's official surfaces (stake.solanamobile.com, Seed Vault Wallet). Blink keeps its
 *   read-only SKR checks (balances, stakes, club and quest rules, the SKR OG mark). The API route is gated
 *   separately by `SKR_IN_APP_STAKING`.
 */
export const FEATURES = {
  inAppSkrStaking: false,
} as const

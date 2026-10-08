import { z } from 'zod'

/** MASTER_PROMPT §7 — hard ceiling for Blink-funded mainnet spend (0.10 SOL). */
export const LAMPORTS_PER_SOL = 1_000_000_000n
export const MAINNET_HARD_CEILING_LAMPORTS = 100_000_000n
export const MAINNET_TARGET_LAMPORTS = 20_000_000n
export const MAINNET_SOFT_FALLBACK_LAMPORTS = 50_000_000n

const boolFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true')

const lamports = z
  .string()
  .regex(/^\d+$/, 'must be an integer number of lamports')
  .transform((v) => BigInt(v))

export const envSchema = z.object({
  /** MASTER_PROMPT §22 — explicit environments. */
  BLINK_ENV: z.enum(['local', 'test', 'mainnet']).default('local'),
  SOLANA_CLUSTER: z.enum(['localnet', 'devnet', 'mainnet-beta']).default('devnet'),
  SOLANA_RPC_URL: z.url(),
  /** Read-only RPC for mainnet xStock mint data (multiplier, paused). Never used to send transactions. */
  XSTOCK_READ_RPC_URL: z.url().optional(),
  /** D-17: mainnet RPC for Seeker Genesis Token checks (falls back to XSTOCK_READ_RPC_URL, then the public endpoint). */
  SEEKER_RPC_URL: z.url().optional(),
  /** Devnet-only test mint from scripts/devnet-test-mint.ts (no real value). Ignored on other clusters. */
  DEVNET_TEST_MINT: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  MAINNET_ENABLED: boolFlag,
  MAINNET_GO_APPROVED: boolFlag,
  MAINNET_BUDGET_LAMPORTS: lamports.default(MAINNET_TARGET_LAMPORTS),
  DEMO_MODE: boolFlag,
  /** Global payout kill switch (SECURITY.md §2). false = no new reservations and nothing sent. */
  PAYOUTS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** D-48: Blink's own SKR stake/unstake builder (D-23). Off by default: SKR is staked on Solana Mobile's official surfaces. */
  SKR_IN_APP_STAKING: boolFlag,
  /** D-24: optional Expo access token for push sends ("enhanced push security"). Backend .env only. */
  EXPO_ACCESS_TOKEN: z.string().min(10).optional(),
  /** D-20: xStocks eligibility gate. 'off' is refused on mainnet. */
  XSTOCK_COMPLIANCE: z.enum(['enforce', 'off']).default('enforce'),
  /**
   * D-16 anti-sybil: successful claims allowed per client IP per drop within 24 h. 0 = off (default; a demo room
   * shares one Wi-Fi IP). Consider 3–5 on mainnet.
   */
  CLAIMS_PER_IP_PER_CAMPAIGN: z.coerce.number().int().min(0).default(0),
  /** §16: warn when the payout fee payer's balance drops below this (default 0.01 SOL). */
  FEE_PAYER_LOW_LAMPORTS: lamports.default(10_000_000n),

  API_HOST: z.string().default('127.0.0.1'),
  /** VPS isolation: Blink-specific, configurable port. 4310 is only a default — check the host first. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4310),
  DATABASE_URL: z.string().min(1).optional(),
  /** Expected database name; migrations refuse to run if DATABASE_URL points elsewhere. */
  BLINK_DATABASE_NAME: z.string().default('blink_to_stock'),

  PRIVY_APP_ID: z.string().min(1).optional(),
  PRIVY_APP_SECRET: z.string().min(1).optional(),
  PUBLIC_WEB_ORIGIN: z.url().optional(),
  HELIUS_API_KEY: z.string().min(1).optional(),
})

export type BlinkEnv = z.infer<typeof envSchema>

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export function loadEnv(source: Record<string, string | undefined> = process.env): BlinkEnv {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigError(`Invalid environment: ${issues}`)
  }
  const env = parsed.data
  assertConsistentCluster(env)
  return env
}

/**
 * MASTER_PROMPT §22: mainnet requires SOLANA_CLUSTER=mainnet-beta AND MAINNET_ENABLED=true.
 * Refuse any configuration where these disagree, so the cluster is never inferred.
 */
export function assertConsistentCluster(env: BlinkEnv): void {
  if (env.SOLANA_CLUSTER === 'mainnet-beta' && !env.MAINNET_ENABLED) {
    throw new ConfigError('SOLANA_CLUSTER=mainnet-beta requires MAINNET_ENABLED=true')
  }
  if (env.MAINNET_ENABLED && env.SOLANA_CLUSTER !== 'mainnet-beta') {
    throw new ConfigError('MAINNET_ENABLED=true is only valid with SOLANA_CLUSTER=mainnet-beta')
  }
  if (env.MAINNET_GO_APPROVED && !env.MAINNET_ENABLED) {
    throw new ConfigError('MAINNET_GO_APPROVED=true requires MAINNET_ENABLED=true')
  }
  if (env.SOLANA_CLUSTER === 'mainnet-beta' && env.XSTOCK_COMPLIANCE !== 'enforce') {
    throw new ConfigError('XSTOCK_COMPLIANCE must be enforce on mainnet-beta (D-20)')
  }
  if (env.MAINNET_BUDGET_LAMPORTS > MAINNET_HARD_CEILING_LAMPORTS) {
    throw new ConfigError(
      `MAINNET_BUDGET_LAMPORTS ${env.MAINNET_BUDGET_LAMPORTS} exceeds hard ceiling ${MAINNET_HARD_CEILING_LAMPORTS} (0.10 SOL); requires explicit owner approval and a code change`,
    )
  }
}

/**
 * Call before building/sending ANY transaction that spends Blink-funded SOL on mainnet.
 * Throws unless every guard is present.
 */
export function assertMainnetSpendAllowed(env: BlinkEnv): void {
  if (env.SOLANA_CLUSTER !== 'mainnet-beta') return
  if (!env.MAINNET_ENABLED) throw new ConfigError('Refusing: MAINNET_ENABLED is not true')
  if (!env.MAINNET_GO_APPROVED) throw new ConfigError('Refusing: MAINNET_GO_APPROVED is not true')
}

export interface BudgetState {
  spentLamports: bigint
  reservedLamports: bigint
  estimatedNextOperationLamports: bigint
  configuredBudgetLamports: bigint
}

export type BudgetDecision =
  | { allowed: true; projectedLamports: bigint; remainingAfterLamports: bigint }
  | { allowed: false; projectedLamports: bigint; reason: string }

/** MASTER_PROMPT §7: spent + reserved + estimatedNextOperation <= configuredBudget, never above hard ceiling. */
/** Pre-mainnet gate W-3: at least this share of the budget always stays uncommitted (safety buffer). */
export const MAINNET_SAFETY_BUFFER_PERCENT = 25n

export function checkBudget(state: BudgetState): BudgetDecision {
  const values = [
    state.spentLamports,
    state.reservedLamports,
    state.estimatedNextOperationLamports,
    state.configuredBudgetLamports,
  ]
  if (values.some((v) => v < 0n)) {
    return { allowed: false, projectedLamports: 0n, reason: 'negative lamport value' }
  }
  const projected = state.spentLamports + state.reservedLamports + state.estimatedNextOperationLamports
  const budget =
    state.configuredBudgetLamports < MAINNET_HARD_CEILING_LAMPORTS
      ? state.configuredBudgetLamports
      : MAINNET_HARD_CEILING_LAMPORTS
  // W-3: spend at most 75 % of the budget; the remaining 25 % is a buffer that is never committed.
  const limit = (budget * (100n - MAINNET_SAFETY_BUFFER_PERCENT)) / 100n
  if (projected > limit) {
    return {
      allowed: false,
      projectedLamports: projected,
      reason: `projected ${projected} lamports exceeds limit ${limit}`,
    }
  }
  return { allowed: true, projectedLamports: projected, remainingAfterLamports: limit - projected }
}

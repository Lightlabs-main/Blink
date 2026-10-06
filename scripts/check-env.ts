/**
 * Validates an env file with the API's own rules (packages/config: mainnet guards, budget ceiling, compliance) without
 * starting anything. Exit 1 on any problem.
 *
 *   npx tsx scripts/check-env.ts .env.mainnet
 */
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

import { assertMainnetSpendAllowed, loadEnv } from '../packages/config/src/index.ts'

const file = process.argv[2] ?? '.env'
const vars = parseEnv(readFileSync(file, 'utf8'))
try {
  const env = loadEnv(vars)
  assertMainnetSpendAllowed(env)
  console.log(`${file}: OK · cluster ${env.SOLANA_CLUSTER} · compliance ${env.XSTOCK_COMPLIANCE} · budget ${env.MAINNET_BUDGET_LAMPORTS} lamports · payouts ${env.PAYOUTS_ENABLED ? 'on' : 'off'}`)
} catch (err) {
  console.error(`${file}: ${(err as Error).message}`)
  process.exit(1)
}

import { loadEnv } from '@blink/config'
import { createSolanaRpc } from '@solana/kit'

import { buildApp } from './app.ts'
import { PrivyAuthVerifier } from './auth.ts'
import { InMemoryCampaignRepository } from './campaign-repo.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on the process environment
}

const env = loadEnv()
if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
  console.error('PRIVY_APP_ID and PRIVY_APP_SECRET are required (backend .env only — never the APK).')
  process.exit(1)
}

// TODO(Codex): swap for the Prisma-backed repository once a Blink-only PostgreSQL database exists.
// In-memory storage loses data on restart and is refused outside BLINK_ENV=local.
if (env.BLINK_ENV !== 'local') {
  console.error('Refusing to start: persistent campaign storage is not wired yet (BLINK_ENV must be local).')
  process.exit(1)
}

const app = buildApp({
  env,
  auth: new PrivyAuthVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }),
  campaigns: new InMemoryCampaignRepository(),
  rpc: createSolanaRpc(env.SOLANA_RPC_URL),
  logger: true,
})

await app.listen({ host: env.API_HOST, port: env.API_PORT })

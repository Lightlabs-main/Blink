import { fileURLToPath } from 'node:url'

import { loadEnv } from '@blink/config'
import { createSolanaRpc } from '@solana/kit'

import { buildApp } from './app.ts'
import { PrivyAuthVerifier } from './auth.ts'
import { type CampaignRepository, InMemoryCampaignRepository } from './campaign-repo.ts'
import { createPrismaClient, PrismaCampaignRepository } from './prisma-campaign-repo.ts'
import { XStockMarket } from './xstock-market.ts'

// Blink's own .env at the repository root, regardless of the process cwd.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
} catch {
  // No file: rely on the process environment.
}

const env = loadEnv()
if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
  console.error('PRIVY_APP_ID and PRIVY_APP_SECRET are required (backend .env only — never the APK).')
  process.exit(1)
}

let campaigns: CampaignRepository
let prisma: ReturnType<typeof createPrismaClient> | undefined
if (env.DATABASE_URL) {
  prisma = createPrismaClient(env.DATABASE_URL)
  campaigns = new PrismaCampaignRepository(prisma)
} else if (env.BLINK_ENV === 'local') {
  console.warn('DATABASE_URL not set: using in-memory campaign storage (local only, data lost on restart).')
  campaigns = new InMemoryCampaignRepository()
} else {
  console.error('Refusing to start: DATABASE_URL is required outside BLINK_ENV=local.')
  process.exit(1)
}

const app = buildApp({
  env,
  auth: new PrivyAuthVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }),
  campaigns,
  rpc: createSolanaRpc(env.SOLANA_RPC_URL),
  market: env.XSTOCK_READ_RPC_URL ? new XStockMarket(createSolanaRpc(env.XSTOCK_READ_RPC_URL)) : undefined,
  logger: true,
})

app.addHook('onClose', async () => {
  await prisma?.$disconnect()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ host: env.API_HOST, port: env.API_PORT })

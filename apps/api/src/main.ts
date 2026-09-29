import { fileURLToPath } from 'node:url'

import { loadEnv } from '@blink/config'
import { PrivyClient } from '@privy-io/node'
import { createSolanaRpc } from '@solana/kit'

import { buildApp } from './app.ts'
import { assetsForCluster } from './assets.ts'
import { PrivyAuthVerifier } from './auth.ts'
import { type CampaignRepository, InMemoryCampaignRepository } from './campaign-repo.ts'
import { PrivyDelegateProvider } from './delegate.ts'
import { SolanaFundingService } from './funding-service.ts'
import { createPrismaClient, PrismaCampaignRepository } from './prisma-campaign-repo.ts'
import { XStockHoldings } from './xstock-holdings.ts'
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

const clusterRpc = createSolanaRpc(env.SOLANA_RPC_URL)
const assets = assetsForCluster(env)
// Asset data is read on the cluster the assets live on: real xStocks → mainnet read RPC; devnet test mint → devnet.
let readRpc: typeof clusterRpc | undefined
if (env.SOLANA_CLUSTER === 'mainnet-beta') {
  readRpc = env.XSTOCK_READ_RPC_URL ? createSolanaRpc(env.XSTOCK_READ_RPC_URL) : clusterRpc
} else if (assets.length) {
  readRpc = clusterRpc
}

const privy = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET })
const funding = new SolanaFundingService(clusterRpc, assets, new PrivyDelegateProvider(privy), campaigns)

const app = buildApp({
  env,
  auth: new PrivyAuthVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }),
  campaigns,
  rpc: clusterRpc,
  assets,
  funding,
  market: readRpc ? new XStockMarket(readRpc, 60_000, assets) : undefined,
  holdings: readRpc ? new XStockHoldings(readRpc, 30_000, assets) : undefined,
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

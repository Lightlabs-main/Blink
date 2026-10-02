import { fileURLToPath } from 'node:url'

import { loadEnv } from '@blink/config'
import { PrivyClient } from '@privy-io/node'
import { createSolanaRpc } from '@solana/kit'

import { buildApp } from './app.ts'
import { assetsForCluster } from './assets.ts'
import { PrivyAuthVerifier } from './auth.ts'
import { type BudgetLedger, InMemoryBudgetLedger, PrismaBudgetLedger } from './budget-ledger.ts'
import { type CampaignRepository, InMemoryCampaignRepository } from './campaign-repo.ts'
import { type ClaimRepository, InMemoryClaimRepository, type ServiceWalletStore } from './claim-repo.ts'
import type { EligibilityStore } from './eligibility.ts'
import { PrivyDelegateProvider, PrivyServerWalletSigner } from './delegate.ts'
import { SolanaFundingService } from './funding-service.ts'
import { ClaimService } from './claim-service.ts'
import { SolanaPayoutService } from './payout-service.ts'
import { createPrismaClient, PrismaCampaignRepository } from './prisma-campaign-repo.ts'
import { PrismaClaimRepository } from './prisma-claim-repo.ts'
import { MainnetSeekerVerifier } from './seeker.ts'
import { EligibilityService } from './eligibility.ts'
import { GeoipCountryResolver } from './ip-country.ts'
import { MainnetChainReader, QuestService } from './quest-service.ts'
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
let claims: ClaimRepository & ServiceWalletStore & EligibilityStore
let ledger: BudgetLedger
let prisma: ReturnType<typeof createPrismaClient> | undefined
if (env.DATABASE_URL) {
  prisma = createPrismaClient(env.DATABASE_URL)
  campaigns = new PrismaCampaignRepository(prisma)
  claims = new PrismaClaimRepository(prisma)
  ledger = new PrismaBudgetLedger(prisma, env)
} else if (env.BLINK_ENV === 'local') {
  console.warn('DATABASE_URL not set: using in-memory campaign storage (local only, data lost on restart).')
  const memory = new InMemoryCampaignRepository()
  campaigns = memory
  claims = new InMemoryClaimRepository(memory)
  ledger = new InMemoryBudgetLedger(env)
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
const payouts = new SolanaPayoutService({
  env,
  rpc: clusterRpc,
  assets,
  campaigns,
  claims,
  serviceWallets: claims,
  signer: new PrivyServerWalletSigner(privy),
  ledger,
  // Payout logs go through the app's (redacting) logger once it exists.
  log: { info: (o, msg) => app.log.info(o, msg), warn: (o, msg) => app.log.warn(o, msg) },
})

const auth = new PrivyAuthVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET })
// D-21: Verified Quest reads SKR/ORE from mainnet (the protocols exist only there), whatever cluster payouts use.
const mainnetRead = createSolanaRpc(env.SEEKER_RPC_URL ?? env.XSTOCK_READ_RPC_URL ?? 'https://api.mainnet.solana.com')
const seeker = new MainnetSeekerVerifier(mainnetRead)
const quests = new QuestService({ auth, claims, chain: new MainnetChainReader(mainnetRead), seeker, log: { warn: (o, msg) => app.log.warn(o, msg) } })
// D-20: xStocks eligibility (self-declared + offline IP-country cross-check; no IP is stored or sent anywhere).
const eligibility = new EligibilityService({ env, store: claims, ipCountry: new GeoipCountryResolver() })
const app = buildApp({
  env,
  auth,
  campaigns,
  rpc: clusterRpc,
  assets,
  funding,
  claims,
  payouts,
  eligibility,
  // SGTs, SKR and ORE live on mainnet only, so these checks always read mainnet, even while payouts run on devnet.
  seeker,
  quests,
  market: readRpc ? new XStockMarket(readRpc, 60_000, assets) : undefined,
  holdings: readRpc ? new XStockHoldings(readRpc, 30_000, assets) : undefined,
  logger: true,
})

app.addHook('onClose', async () => {
  clearInterval(sweepTimer)
  clearInterval(feeCheck)
  await prisma?.$disconnect()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

await app.listen({ host: env.API_HOST, port: env.API_PORT })

// D-13/D-14: confirm SENDING payouts and release abandoned reservations even when nobody is looking at them.
const sweeper = new ClaimService({ env, auth, campaigns, claims, payouts, log: app.log, eligibility, quests })
let sweeping = false
const sweepTimer = setInterval(() => {
  if (sweeping) return
  sweeping = true
  sweeper
    .sweep()
    .catch((err: unknown) => app.log.warn({ err }, 'claim sweep failed'))
    .finally(() => {
      sweeping = false
    })
}, 60_000)
sweepTimer.unref()

// §16: the fee payer holds minimal SOL; say so loudly (at most hourly) when it needs topping up.
let lastLowWarning = 0
const feeCheck = setInterval(() => {
  payouts.feePayerStatus().then(
    (s) => {
      if (s.low && Date.now() - lastLowWarning > 3_600_000) {
        lastLowWarning = Date.now()
        app.log.warn({ feePayer: s.address, balanceLamports: s.balanceLamports.toString() }, 'FEE PAYER LOW: top it up or claims will fail')
      }
    },
    (err: unknown) => app.log.warn({ err }, 'fee payer balance check failed'),
  )
}, 300_000)
feeCheck.unref()

// Resolve (or create once) the §16 fee payer at boot so its address is in the logs for funding.
payouts.feePayerAddress().then(
  (feePayer) => app.log.info({ feePayer, cluster: env.SOLANA_CLUSTER }, 'payout fee payer ready'),
  (err: unknown) => app.log.warn({ err }, 'payout fee payer unavailable; claims will fail until it is'),
)

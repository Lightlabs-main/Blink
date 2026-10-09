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
import { ExpoPushNotifier, InMemoryPushTokenStore, PrismaPushTokenStore, type PushTokenStore } from './push.ts'
import { MainnetSkrStaking } from './skr-service.ts'
import { SendService } from './send-service.ts'
import { InMemoryProfileStore, PrismaProfileStore, type ProfileStore } from './profile.ts'
import { InMemoryTransferStore, PrismaTransferStore, type TransferStore } from './history.ts'
import { InMemorySocialStore, PrismaSocialStore, type SocialStore } from './social-store.ts'
import { InMemoryXTaskStore, OEmbedXPostReader, PrismaXTaskStore, type XTaskStore } from './x-quest.ts'
import { XStockHoldings } from './xstock-holdings.ts'
import { XStockMarket } from './xstock-market.ts'
import { type ChainActivityStore, InMemoryChainActivityStore, PrismaChainActivityStore } from './chain-activity-store.ts'
import { AllDomainsSkrResolver } from './skr-identity.ts'
import { WalletTxRelay } from './wallet-relay.ts'

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
let pushTokens: PushTokenStore
let profiles: ProfileStore
let transfers: TransferStore
let xTasks: XTaskStore
let social: SocialStore
let chainStore: ChainActivityStore
if (env.DATABASE_URL) {
  prisma = createPrismaClient(env.DATABASE_URL)
  xTasks = new PrismaXTaskStore(prisma)
  social = new PrismaSocialStore(prisma)
  chainStore = new PrismaChainActivityStore(prisma)
  transfers = new PrismaTransferStore(prisma)
  pushTokens = new PrismaPushTokenStore(prisma)
  profiles = new PrismaProfileStore(prisma)
  campaigns = new PrismaCampaignRepository(prisma)
  claims = new PrismaClaimRepository(prisma)
  ledger = new PrismaBudgetLedger(prisma, env)
} else if (env.BLINK_ENV === 'local') {
  console.warn('DATABASE_URL not set: using in-memory campaign storage (local only, data lost on restart).')
  const memory = new InMemoryCampaignRepository()
  campaigns = memory
  pushTokens = new InMemoryPushTokenStore()
  profiles = new InMemoryProfileStore()
  transfers = new InMemoryTransferStore()
  xTasks = new InMemoryXTaskStore()
  social = new InMemorySocialStore()
  chainStore = new InMemoryChainActivityStore()
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

// D-24: push notifications via the Expo push service; failures are logged, never thrown into payouts.
const notifier = new ExpoPushNotifier({ store: pushTokens, accessToken: env.EXPO_ACCESS_TOKEN, log: { warn: (o, msg) => app.log.warn(o, msg) } })

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
  notifier,
  // Payout logs go through the app's (redacting) logger once it exists.
  log: { info: (o, msg) => app.log.info(o, msg), warn: (o, msg) => app.log.warn(o, msg) },
})

const auth = new PrivyAuthVerifier({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET })
// D-21: Verified Quest reads SKR/ORE from mainnet (the protocols exist only there), whatever cluster payouts use.
const mainnetRead = createSolanaRpc(env.SEEKER_RPC_URL ?? env.XSTOCK_READ_RPC_URL ?? 'https://api.mainnet.solana.com')
const seeker = new MainnetSeekerVerifier(mainnetRead)
// D-49..D-52: SKR and ORE exist only on mainnet. On a mainnet server the main RPC builds and relays; otherwise the
// mainnet read RPC serves the read-only parts (every spending route is disabled off mainnet by featureConfig).
const chainRpc = env.SOLANA_CLUSTER === 'mainnet-beta' ? clusterRpc : mainnetRead
const quests = new QuestService({ auth, claims, chain: new MainnetChainReader(mainnetRead), seeker, xTasks, social, oreRewardsEnabled: env.ORE_REWARDS_ENABLED, log: { warn: (o, msg) => app.log.warn(o, msg) } })
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
  // D-23 / D-48: in-app SKR staking is off unless SKR_IN_APP_STAKING=true (staking happens on Solana Mobile's surfaces).
  skr: env.SKR_IN_APP_STAKING ? new MainnetSkrStaking(mainnetRead) : undefined,
  // D-32: Send from the stock wallet; Blink's fee payer pays the network fee.
  send: new SendService({
    env,
    rpc: clusterRpc,
    assets,
    auth,
    signer: new PrivyServerWalletSigner(privy),
    serviceWallets: claims,
    ledger,
    transfers,
    eligibility,
    log: { warn: (o, msg) => app.log.warn(o, msg) },
  }),
  pushTokens,
  notifier,
  profiles,
  transfers,
  social,
  // D-39: X tasks read public posts through X's oEmbed endpoint.
  xTasks,
  xReader: new OEmbedXPostReader(),
  market: readRpc ? new XStockMarket(readRpc, 60_000, assets) : undefined,
  holdings: readRpc ? new XStockHoldings(readRpc, 30_000, assets) : undefined,
  chain: {
    store: chainStore,
    rpc: chainRpc,
    relay: new WalletTxRelay(chainRpc),
    skrNames: new AllDomainsSkrResolver(env.SEEKER_RPC_URL ?? env.XSTOCK_READ_RPC_URL ?? 'https://api.mainnet.solana.com'),
  },
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

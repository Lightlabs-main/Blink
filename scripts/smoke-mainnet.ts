/**
 * MAINNET SMOKE TEST (MASTER_PROMPT §7, §22; docs/MAINNET_SMOKE_TEST.md). Dry run by default.
 *
 *   npx tsx scripts/smoke-mainnet.ts --campaign <id> --recipient <wallet> [--execute]
 *
 * Dry run (default, read-only): verifies the cluster is mainnet-beta by genesis hash, the campaign is LIVE on
 * mainnet, the real mint has no transfer blockers, the creator's onchain delegation covers one reward, the fee
 * payer can pay, the §7 budget has room, and SIMULATES the exact payout. Nothing is signed or sent.
 *
 * --execute: additionally requires SOLANA_CLUSTER=mainnet-beta, MAINNET_ENABLED=true and MAINNET_GO_APPROVED=true
 * (Maris's go-ahead), then pays ONE reward to --recipient through the production payout path and verifies the
 * recipient's balance onchain. Real SOL and real stock move. Uses the API's database, Privy and ledger.
 */
import { assertMainnetSpendAllowed, loadEnv } from '@blink/config'
import { buildPayoutTransaction, checkCampaignDelegation, inspectMint, mintTransferBlockers } from '@blink/solana'
import { PrivyClient } from '@privy-io/node'
import { address, createSolanaRpc } from '@solana/kit'
import { fetchMaybeToken, findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

import { assetsForCluster } from '../apps/api/src/assets.ts'
import { PrismaBudgetLedger } from '../apps/api/src/budget-ledger.ts'
import { PrivyServerWalletSigner } from '../apps/api/src/delegate.ts'
import { SolanaPayoutService } from '../apps/api/src/payout-service.ts'
import { createPrismaClient, PrismaCampaignRepository } from '../apps/api/src/prisma-campaign-repo.ts'
import { PrismaClaimRepository } from '../apps/api/src/prisma-claim-repo.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' // VERIFIED against the live cluster 2026-10-01
const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const campaignId = arg('--campaign')
const recipient = arg('--recipient')
const execute = args.includes('--execute')
if (!campaignId || !recipient) {
  console.error('Usage: npx tsx scripts/smoke-mainnet.ts --campaign <id> --recipient <wallet> [--execute]')
  process.exit(1)
}

const ok = (msg: string, detail?: unknown) => console.log(`✔ ${msg}${detail === undefined ? '' : ' ' + JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
const fail = (msg: string): never => {
  console.error(`✘ ${msg}`)
  process.exit(1)
}

const env = loadEnv()
if (env.SOLANA_CLUSTER !== 'mainnet-beta') fail(`SOLANA_CLUSTER is ${env.SOLANA_CLUSTER}, not mainnet-beta`)
if (execute) {
  assertMainnetSpendAllowed(env) // throws unless MAINNET_ENABLED and MAINNET_GO_APPROVED are both true
  ok('mainnet spend guards present (MAINNET_ENABLED, MAINNET_GO_APPROVED)')
}
if (!env.DATABASE_URL || !env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) fail('DATABASE_URL, PRIVY_APP_ID and PRIVY_APP_SECRET are required')

const rpc = createSolanaRpc(env.SOLANA_RPC_URL)
const genesis = await rpc.getGenesisHash().send()
if (genesis !== MAINNET_GENESIS) fail(`RPC is not mainnet-beta (genesis ${genesis})`)
ok('RPC is mainnet-beta', new URL(env.SOLANA_RPC_URL).host)

const prisma = createPrismaClient(env.DATABASE_URL!)
try {
  const campaigns = new PrismaCampaignRepository(prisma)
  const claims = new PrismaClaimRepository(prisma)
  const ledger = new PrismaBudgetLedger(prisma, env)
  const assets = assetsForCluster(env)

  const campaign = (await campaigns.findById(campaignId)) ?? fail('campaign not found')
  if (campaign.cluster !== 'mainnet-beta') fail(`campaign is on ${campaign.cluster}`)
  if (campaign.status !== 'LIVE') fail(`campaign is ${campaign.status}, not LIVE`)
  if (!campaign.rewardPerClaimRaw || !campaign.delegateAddress) fail('campaign has no reward or delegate')
  const asset = assets.find((a) => a.mint === campaign.mint) ?? fail('campaign mint is not a supported xStock')
  ok('campaign LIVE on mainnet', { id: campaign.id, stock: asset.symbol, rewardRaw: campaign.rewardPerClaimRaw })

  const mint = await inspectMint(rpc, address(campaign.mint))
  const blockers = mintTransferBlockers(mint)
  if (mint.decimals !== asset.decimals || blockers.length) fail(`mint not transferable: decimals ${mint.decimals}, blockers ${blockers.join(',')}`)
  ok('mint transferable', { decimals: mint.decimals, extensions: mint.extensionKinds })

  const status = await checkCampaignDelegation(rpc, {
    account: address(campaign.campaignTokenAccount),
    mint: address(campaign.mint),
    creator: address(campaign.creatorWallet),
    delegate: address(campaign.delegateAddress!),
  })
  if (!status.valid || status.distributable < campaign.rewardPerClaimRaw!) fail(`delegation does not cover a reward: ${status.problems.join(',')}`)
  ok('onchain delegation covers a reward', { distributable: status.distributable, balance: status.balance })

  const signer = new PrivyServerWalletSigner(new PrivyClient({ appId: env.PRIVY_APP_ID!, appSecret: env.PRIVY_APP_SECRET! }))
  const logs = { info: (o: object, m: string) => ok(m, o), warn: (o: object, m: string) => console.warn('!', m, o) }
  const payouts = new SolanaPayoutService({ env, rpc, assets, campaigns, claims, serviceWallets: claims, signer, ledger, log: logs })
  const fee = await payouts.feePayerStatus()
  ok('fee payer', { address: fee.address, balanceLamports: fee.balanceLamports, low: fee.low })

  const plan = await buildPayoutTransaction(rpc, {
    campaignAccount: address(campaign.campaignTokenAccount),
    mint: address(campaign.mint),
    expectedDecimals: asset.decimals,
    delegate: address(campaign.delegateAddress!),
    recipient: address(recipient),
    feePayer: address(fee.address),
    amountRaw: campaign.rewardPerClaimRaw!,
  })
  ok('payout simulated', { createsRecipientAccount: plan.createsRecipientAccount, estimatedLamports: plan.estimatedLamports })
  if (fee.balanceLamports < plan.estimatedLamports) fail('fee payer cannot cover this payout')

  const spent = await prisma.budgetLedgerEntry.groupBy({ by: ['state'], where: { cluster: 'mainnet_beta' }, _sum: { lamports: true } })
  const sum = (s: string) => spent.find((r) => r.state === s)?._sum.lamports ?? 0n
  const used = sum('SPENT') + sum('RESERVED')
  if (used + plan.estimatedLamports > env.MAINNET_BUDGET_LAMPORTS) fail(`budget: ${used} used + ${plan.estimatedLamports} > ${env.MAINNET_BUDGET_LAMPORTS}`)
  ok('§7 budget has room', { usedLamports: used, budgetLamports: env.MAINNET_BUDGET_LAMPORTS })

  if (!execute) {
    console.log('\nDRY RUN PASSED. Nothing was signed or sent. Re-run with --execute (and the MAINNET flags) to pay one reward.')
    process.exit(0)
  }

  const reserved = await claims.reserve({
    campaignId: campaign.id,
    privyUserId: `smoke-test:${Date.now()}`,
    recipientWallet: recipient,
    amountRaw: campaign.rewardPerClaimRaw!,
    tapSessionId: null,
  })
  if (!reserved.ok) throw new Error(`could not reserve: ${reserved.reason}`)
  const paid = await payouts.pay(campaign, reserved.claim)
  if (paid.status !== 'PAID') fail(`payout ended ${paid.status} ${paid.failureReason ?? ''} (signature ${paid.txSignature ?? 'none'})`)
  const [ata] = await findAssociatedTokenPda({ owner: address(recipient), mint: address(campaign.mint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const after = await fetchMaybeToken(rpc, ata, { commitment: 'confirmed' })
  const balance = after.exists ? after.data.amount : 0n
  if (balance < campaign.rewardPerClaimRaw!) fail('recipient balance did not increase')
  ok('MAINNET PAYOUT CONFIRMED', { signature: paid.txSignature, explorer: `https://explorer.solana.com/tx/${paid.txSignature}`, recipientBalance: balance })
  process.exit(0)
} finally {
  await prisma.$disconnect()
}

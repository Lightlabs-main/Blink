/**
 * Creates (once) the mainnet fee payer, so it can be funded BEFORE the server switches to mainnet. Same role and code
 * path the payout service uses on first mainnet boot (`fee-payer-mainnet-beta`, a Privy server wallet), so the API
 * picks this exact wallet up. Signs and sends nothing; prints the address and its mainnet SOL balance.
 *
 *   npx tsx scripts/prepare-mainnet-fee-payer.ts        (uses .env: DATABASE_URL, PRIVY_*, SEEKER_RPC_URL for the balance)
 */
import { PrivyClient } from '@privy-io/node'
import { address, createSolanaRpc } from '@solana/kit'

import { PrivyServerWalletSigner } from '../apps/api/src/delegate.ts'
import { createPrismaClient } from '../apps/api/src/prisma-campaign-repo.ts'
import { PrismaClaimRepository } from '../apps/api/src/prisma-claim-repo.ts'
import { assertBlinkDatabase } from './db-guard.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}
const ROLE = 'fee-payer-mainnet-beta'
assertBlinkDatabase(process.env.DATABASE_URL, process.env.BLINK_DATABASE_NAME ?? 'blink_to_stock')
if (!process.env.PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) throw new Error('PRIVY_APP_ID and PRIVY_APP_SECRET are required')

const prisma = createPrismaClient(process.env.DATABASE_URL!)
const store = new PrismaClaimRepository(prisma)
let wallet = await store.get(ROLE)
if (wallet) {
  console.log(`exists   ${ROLE}`)
} else {
  const signer = new PrivyServerWalletSigner(new PrivyClient({ appId: process.env.PRIVY_APP_ID, appSecret: process.env.PRIVY_APP_SECRET }))
  wallet = await store.putIfAbsent(ROLE, await signer.createServiceWallet(ROLE))
  console.log(`created  ${ROLE}`)
}
console.log(`address  ${wallet.address}`)
const rpcUrl = process.env.SEEKER_RPC_URL ?? process.env.XSTOCK_READ_RPC_URL
if (rpcUrl) {
  const rpc = createSolanaRpc(rpcUrl)
  if ((await rpc.getGenesisHash().send()) === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
    const { value } = await rpc.getBalance(address(wallet.address)).send()
    console.log(`mainnet  ${(Number(value) / 1e9).toFixed(6)} SOL`)
  }
}
await prisma.$disconnect()

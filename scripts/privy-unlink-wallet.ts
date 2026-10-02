/**
 * Owner support tool (D-26): list or remove a user's SIWS-linked external Solana wallets via the Privy server API.
 * The Expo SDK's unlinkWallet only accepts Ethereum addresses, so Solana wallets are removed server-side.
 * Prints only public data (user id, wallet addresses).
 *
 *   npx tsx scripts/privy-unlink-wallet.ts <email>                 # list
 *   npx tsx scripts/privy-unlink-wallet.ts <email> <solanaAddress> # remove that wallet
 */
import { PrivyClient } from '@privy-io/node'

import { extractVerifiedExternalSolanaWallets } from '../apps/api/src/auth.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on the process environment
}
const [email, remove] = process.argv.slice(2)
if (!email) throw new Error('usage: privy-unlink-wallet.ts <email> [solanaAddress]')
const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! })
const user = await privy.users().getByEmailAddress({ address: email })
const wallets = extractVerifiedExternalSolanaWallets(user.linked_accounts)
console.log('user', user.id, 'external Solana wallets (newest first):', wallets)
if (remove) {
  if (!wallets.includes(remove)) throw new Error(`${remove} is not one of this user's external wallets`)
  const after = await privy.users().unlinkLinkedAccount(user.id, { type: 'wallet', handle: remove })
  console.log('removed', remove, '→ now:', extractVerifiedExternalSolanaWallets(after.linked_accounts))
}

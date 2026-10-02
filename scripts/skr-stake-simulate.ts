/**
 * Read-only check of the hand-built SKR staking instructions (D-23) against MAINNET.
 * It finds a wallet that recently used the staking program, reads its position and SIMULATES
 * stake / unstake / cancel / withdraw for it. It signs nothing and sends nothing.
 *
 *   SKR_RPC_URL=https://... npx tsx scripts/skr-stake-simulate.ts [wallet]
 */
import { address, type Address, createSolanaRpc, type Signature } from '@solana/kit'

import {
  prepareSkrStakeTransaction,
  readSkrPosition,
  SKR_GUARDIAN_POOL,
  SKR_STAKING_PROGRAM,
  SkrStakeError,
  skrSharesForAmount,
  type SkrStakeInput,
} from '../packages/solana/src/index.ts'

const rpc = createSolanaRpc(process.env.SKR_RPC_URL ?? 'https://api.mainnet.solana.com')

async function recentStaker(): Promise<Address> {
  const sigs = await rpc.getSignaturesForAddress(SKR_GUARDIAN_POOL, { limit: 25 }).send()
  for (const s of sigs) {
    if (s.err) continue
    const tx = await rpc.getTransaction(s.signature as Signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }).send()
    const payer = tx?.transaction.message.accountKeys[0]
    if (payer) return address(payer)
  }
  throw new Error('no recent staker found')
}

async function trySim(label: string, input: SkrStakeInput) {
  try {
    await prepareSkrStakeTransaction(rpc, input)
    console.log(`  ${label}: simulation OK`)
  } catch (e) {
    if (e instanceof SkrStakeError) console.log(`  ${label}: ${e.message}\n    ${e.logs.slice(-4).join('\n    ')}`)
    else throw e
  }
}

const wallet = process.argv[2] ? address(process.argv[2]) : await recentStaker()
const p = await readSkrPosition(rpc, wallet)
console.log('program', SKR_STAKING_PROGRAM, 'wallet', wallet)
console.log({
  walletSkr: Number(p.walletRaw) / 1e6,
  stakedSkr: Number(p.stakedRaw) / 1e6,
  unstakingSkr: Number(p.unstakingRaw) / 1e6,
  minStake: Number(p.minStakeRaw) / 1e6,
  cooldownHours: Number(p.cooldownSeconds) / 3600,
  sharePrice: p.sharePrice.toString(),
  unstakeTimestamp: p.unstakeTimestamp.toString(),
})
const stakeAmount = p.walletRaw >= p.minStakeRaw && p.minStakeRaw > 0n ? p.minStakeRaw : p.walletRaw
if (stakeAmount > 0n) await trySim(`stake ${Number(stakeAmount) / 1e6} SKR`, { action: 'stake', user: wallet, amountRaw: stakeAmount })
if (p.shares > 0n) await trySim('unstake 1 SKR', { action: 'unstake', user: wallet, shares: skrSharesForAmount(1_000_000n, p.sharePrice, p.shares) })
if (p.unstakingRaw > 0n) {
  await trySim('cancel unstake', { action: 'cancel_unstake', user: wallet })
  await trySim('withdraw', { action: 'withdraw', user: wallet })
}

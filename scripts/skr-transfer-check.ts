/**
 * READ-ONLY. Checks packages/solana/src/skr-transfer.ts on mainnet:
 *  1. verifySkrTransfer on real recent SKR transfers (positive) and with a wrong amount / recipient (negative).
 *  2. buildSkrTransferTransaction for a real holder → another real wallet: built + simulated (sigVerify off).
 * Never signs or sends anything.
 *
 * Usage: SOLANA_RPC_URL=<mainnet rpc> tsx scripts/skr-transfer-check.ts
 */
import { address, createSolanaRpc, generateKeyPairSigner, type Signature } from '@solana/kit'

import { buildSkrTransferTransaction, SKR_MINT, tokenDelta, type TokenBalanceTx, verifySkrTransfer } from '../packages/solana/src/index.ts'

const rpcUrl = process.env.SOLANA_RPC_URL
if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required (mainnet)')
const rpc = createSolanaRpc(rpcUrl)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = false
const report = (ok: boolean, what: string) => {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

const sigs = await rpc.getSignaturesForAddress(SKR_MINT, { limit: 30 }).send()
const pairs: { from: string; to: string }[] = []
let checked = 0
for (const s of sigs) {
  if (s.err || checked >= 3) continue
  await sleep(1200)
  const tx = (await rpc.getTransaction(s.signature as Signature, { encoding: 'json', maxSupportedTransactionVersion: 1 as unknown as 0, commitment: 'confirmed' }).send()) as unknown as TokenBalanceTx | null
  if (!tx?.meta) continue
  const owners = [...new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].filter((r) => r.mint === SKR_MINT && r.owner).map((r) => r.owner!))]
  const deltas = owners.map((o) => ({ owner: o, d: tokenDelta(tx, o, SKR_MINT) })).filter((x) => x.d !== 0n)
  // A plain transfer: exactly one sender and one recipient with opposite deltas.
  if (deltas.length !== 2 || deltas[0]!.d !== -deltas[1]!.d) continue
  const from = deltas.find((x) => x.d < 0n)!
  const to = deltas.find((x) => x.d > 0n)!
  checked += 1
  report(verifySkrTransfer(tx, { from: from.owner, to: to.owner, amountRaw: to.d }).ok, `real transfer ${s.signature.slice(0, 12)}… ${to.d} raw verifies`)
  report(!verifySkrTransfer(tx, { from: from.owner, to: to.owner, amountRaw: to.d + 1n }).ok, `  … rejected with a wrong amount`)
  report(!verifySkrTransfer(tx, { from: from.owner, to: from.owner === to.owner ? to.owner : '11111111111111111111111111111112', amountRaw: to.d }).ok, `  … rejected with a wrong recipient`)
  pairs.push({ from: from.owner, to: to.owner })
}
report(checked > 0, `found ${checked} plain SKR transfers`)

// The recipient of a real transfer now holds SKR: simulate a 1-raw-unit transfer back from it. Program-owned
// recipients (exchanges, smart wallets) cannot pay fees and must be refused with WALLET_CANNOT_PAY.
let simulated = false
for (const pair of pairs.flatMap((p) => [p, { from: p.to, to: p.from }])) {
  try {
    const plan = await buildSkrTransferTransaction(rpc, { from: address(pair.to), to: address(pair.from), amountRaw: 1n })
    report(true, `built + simulated 0.000001 SKR ${pair.to.slice(0, 6)}… → ${pair.from.slice(0, 6)}… (creates account: ${plan.createsRecipientAccount}, rent ${plan.rentLamports})`)
    // Same sender to a brand-new wallet: exercises the idempotent recipient-account creation (sender pays rent).
    const fresh = (await generateKeyPairSigner()).address
    const plan2 = await buildSkrTransferTransaction(rpc, { from: address(pair.to), to: fresh, amountRaw: 1n })
    report(plan2.createsRecipientAccount, `built + simulated to a new wallet: creates account ${plan2.createsRecipientAccount}, rent ${plan2.rentLamports} lamports paid by the sender`)
    simulated = true
    break
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'WALLET_CANNOT_PAY' || code === 'INSUFFICIENT_SOL') {
      console.log(`info  ${pair.to.slice(0, 6)}… refused as sender: ${code}`)
      continue
    }
    report(false, `build/simulate failed: ${(err as Error).message}`)
    console.log(((err as { logs?: string[] }).logs ?? []).join('\n'))
  }
}
if (!simulated) console.log('info  no ordinary-wallet sender among the sampled transfers; rerun later')
process.exit(failed ? 1 : 0)

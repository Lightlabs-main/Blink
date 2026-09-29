/**
 * READ-ONLY. Inspects xStock mints on a cluster and (optionally) estimates campaign-account rent.
 * Never signs or sends a transaction. Rent estimation uses simulateTransaction with sigVerify=false.
 *
 * Usage:
 *   SOLANA_RPC_URL=<rpc> tsx scripts/inspect-xstock.ts <mint> [<mint>...] [--fee-payer <existing address>]
 */
import { address, createSolanaRpc } from '@solana/kit'

import { estimateCampaignAccountRent, inspectMint } from '../packages/solana/src/index.ts'

const args = process.argv.slice(2)
const feePayerIdx = args.indexOf('--fee-payer')
const feePayer = feePayerIdx >= 0 ? args[feePayerIdx + 1] : undefined
const mints = args.filter((_a, i) => feePayerIdx < 0 || (i !== feePayerIdx && i !== feePayerIdx + 1))

const rpcUrl = process.env.SOLANA_RPC_URL
if (!rpcUrl) {
  console.error('SOLANA_RPC_URL is required')
  process.exit(1)
}
if (mints.length === 0) {
  console.error('Usage: tsx scripts/inspect-xstock.ts <mint> [...] [--fee-payer <address>]')
  process.exit(1)
}

const rpc = createSolanaRpc(rpcUrl)
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)

let failed = false
for (const m of mints) {
  try {
    const info = await inspectMint(rpc, address(m))
    const out: Record<string, unknown> = { ...info }
    if (feePayer) {
      out.rent = await estimateCampaignAccountRent(rpc, { mint: address(m), simulationFeePayer: address(feePayer) })
    }
    console.log(json(out))
  } catch (err) {
    failed = true
    console.error(`FAILED ${m}: ${(err as Error).message}`)
  }
}
process.exit(failed ? 1 : 0)

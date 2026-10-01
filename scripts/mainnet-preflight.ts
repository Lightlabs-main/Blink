/**
 * READ-ONLY mainnet preflight (MASTER_PROMPT §7, §13; OPEN_QUESTIONS OQ-7). Never signs or sends anything.
 *
 * For every supported xStock: the mint exists on mainnet with the expected decimals, transfer blockers,
 * extensions, and the REAL size and rent of a recipient token account (read from the largest existing holder
 * account, not assumed). Then how many Blink-sponsored recipients each budget level covers.
 *
 * Usage: SOLANA_RPC_URL=https://api.mainnet.solana.com npx tsx scripts/mainnet-preflight.ts
 */
import { MAINNET_HARD_CEILING_LAMPORTS, MAINNET_SOFT_FALLBACK_LAMPORTS, MAINNET_TARGET_LAMPORTS } from '../packages/config/src/index.ts'
import { inspectMint, mintTransferBlockers, PAYOUT_SIGNATURE_FEES_LAMPORTS } from '../packages/solana/src/index.ts'
import { SUPPORTED_XSTOCKS } from '../packages/xstocks/src/index.ts'
import { address, createSolanaRpc } from '@solana/kit'

const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet.solana.com'
const rpc = createSolanaRpc(rpcUrl)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The public RPC rate-limits (HTTP 429, OQ-6): back off and retry. */
async function retry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (attempt >= 5 || !/429/.test((err as Error).message)) throw err
      await sleep(2000 * 2 ** attempt)
    }
  }
}
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6)

const genesis = await rpc.getGenesisHash().send()
// Mainnet-beta genesis hash (VERIFIED against the live cluster 2026-10-01); refuse to label another cluster's numbers as mainnet.
if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
  console.error(`Not mainnet-beta (genesis ${genesis}). Refusing.`)
  process.exit(1)
}
console.log(`mainnet-beta via ${new URL(rpcUrl).host}\n`)

let worstCost = 0n
let failed = false
for (const x of SUPPORTED_XSTOCKS) {
  try {
    await sleep(1500)
    const mint = await retry(() => inspectMint(rpc, address(x.mint)))
    const blockers = mintTransferBlockers(mint)
    // A real holder account shows the true size (base + the mint's required account extensions + ImmutableOwner for ATAs).
    const largest = await retry(() => rpc.getTokenLargestAccounts(address(x.mint), { commitment: 'confirmed' }).send())
    const holder = largest.value[0]?.address
    let size: bigint | null = null
    if (holder) {
      const info = await retry(() => rpc.getAccountInfo(holder, { encoding: 'base64', commitment: 'confirmed' }).send())
      if (info.value) size = BigInt(Buffer.from(info.value.data[0], 'base64').length)
    }
    const rent = size === null ? null : await retry(() => rpc.getMinimumBalanceForRentExemption(size, { commitment: 'confirmed' }).send())
    const perRecipient = rent === null ? null : rent + PAYOUT_SIGNATURE_FEES_LAMPORTS
    if (perRecipient !== null && perRecipient > worstCost) worstCost = perRecipient
    const ok = mint.decimals === x.decimals && blockers.length === 0
    if (!ok) failed = true
    console.log(
      `${ok ? '✔' : '✘'} ${x.symbol.padEnd(6)} decimals ${mint.decimals}${mint.decimals === x.decimals ? '' : ` (expected ${x.decimals})`}` +
        ` · blockers [${blockers.join(', ')}]` +
        ` · holder account ${size ?? '?'} bytes, rent ${rent === null ? '?' : sol(rent)} SOL` +
        `\n    extensions: ${mint.extensionKinds.join(', ')}`,
    )
  } catch (err) {
    failed = true
    console.log(`✘ ${x.symbol}: ${(err as Error).message}`)
  }
}

if (worstCost > 0n) {
  console.log(`\nWorst case per NEW recipient (account rent + 2 signature fees): ${sol(worstCost)} SOL`)
  for (const [name, budget] of [
    ['target', MAINNET_TARGET_LAMPORTS],
    ['soft fallback', MAINNET_SOFT_FALLBACK_LAMPORTS],
    ['hard ceiling', MAINNET_HARD_CEILING_LAMPORTS],
  ] as const) {
    console.log(`  ${name.padEnd(13)} ${sol(budget)} SOL → ${budget / worstCost} new recipients`)
  }
  console.log(`  A recipient who already holds the stock costs only ${sol(PAYOUT_SIGNATURE_FEES_LAMPORTS)} SOL in fees.`)
}
process.exit(failed ? 1 : 0)

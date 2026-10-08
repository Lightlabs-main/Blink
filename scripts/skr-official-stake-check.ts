/**
 * D-48 regression (READ-ONLY, mainnet): Blink's SKR checks detect stake created on Solana Mobile's official surfaces
 * (stake.solanamobile.com / Seed Vault Wallet). It samples real UserStake accounts from the SKR staking program,
 * across guardian pools, and runs the same reader the SKR_STAKED / SKR_TOTAL verifiers and the SKR OG mark use.
 * It signs nothing and sends nothing.
 *
 *   SKR_RPC_URL=https://... npx tsx scripts/skr-official-stake-check.ts [perPool]
 */
import { address, type Address, type Base58EncodedBytes, createSolanaRpc, getBase58Decoder, getBase64Encoder } from '@solana/kit'

import { MainnetChainReader } from '../apps/api/src/quest-service.ts'
import { SKR_GUARDIAN_POOL, SKR_STAKE_CONFIG, SKR_STAKING_PROGRAM } from '../packages/solana/src/index.ts'

const rpc = createSolanaRpc(process.env.SKR_RPC_URL ?? 'https://api.mainnet.solana.com')
const perPool = Number(process.argv[2] ?? 2)
const USER_STAKE_DISCRIMINATOR = new Uint8Array([102, 53, 163, 107, 9, 138, 87, 153])
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`

async function main() {
  const b58 = getBase58Decoder()
  // user (41) · guardian_pool (73) · shares u128 (105): slice 41..121 only.
  const accounts = await rpc
    .getProgramAccounts(SKR_STAKING_PROGRAM, {
      encoding: 'base64',
      dataSlice: { offset: 41, length: 80 },
      filters: [
        { memcmp: { offset: 0n, bytes: b58.decode(USER_STAKE_DISCRIMINATOR) as Base58EncodedBytes, encoding: 'base58' } },
        { memcmp: { offset: 9n, bytes: SKR_STAKE_CONFIG as string as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send()

  const byPool = new Map<string, Address[]>()
  for (const { account } of accounts) {
    const d = Uint8Array.from(getBase64Encoder().encode(account.data[0]))
    let shares = 0n
    for (let i = 15; i >= 0; i--) shares = (shares << 8n) | BigInt(d[64 + i]!)
    if (shares === 0n) continue
    const pool = b58.decode(d.subarray(32, 64))
    const list = byPool.get(pool) ?? []
    if (list.length < perPool) list.push(address(b58.decode(d.subarray(0, 32))))
    byPool.set(pool, list)
  }
  console.log(`UserStake accounts (official program): ${accounts.length}; guardian pools with active stake: ${byPool.size}`)

  const chain = new MainnetChainReader(rpc)
  let checked = 0
  let detected = 0
  for (const [pool, owners] of byPool) {
    for (const owner of owners) {
      const raw = await chain.skrStaked(owner)
      checked += 1
      if (raw > 0n) detected += 1
      console.log(`  pool ${short(pool)}${pool === SKR_GUARDIAN_POOL ? ' (official default pool)' : ''} · wallet ${short(owner)} → staked ${raw} raw ${raw > 0n ? '✔' : '✘'}`)
    }
  }
  console.log(`\nDetected ${detected}/${checked} sampled stakers across ${byPool.size} pools`)
  if (checked === 0 || detected !== checked) {
    console.log('FAILED')
    process.exit(1)
  }
  console.log('PASSED (read-only; nothing signed or sent)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

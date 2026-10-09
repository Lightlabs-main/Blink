/**
 * READ-ONLY. Checks .skr resolution with the official approach (Solana Mobile sample skr-address-resolution:
 * @onsol/tldparser on mainnet): forward name → owner, then reverse owner → .skr names must include the name.
 *
 * Usage: SOLANA_RPC_URL=<mainnet rpc> tsx scripts/skr-domain-check.ts name1.skr [name2.skr ...]
 */
import { TldParser } from '@onsol/tldparser'
import { Connection } from '@solana/web3.js'

const rpcUrl = process.env.SOLANA_RPC_URL
if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required (mainnet)')
const parser = new TldParser(new Connection(rpcUrl, 'confirmed'))
for (const name of process.argv.slice(2)) {
  let owner: Awaited<ReturnType<typeof parser.getOwnerFromDomainTld>>
  try {
    owner = await parser.getOwnerFromDomainTld(name)
  } catch (err) {
    console.log(`${name}: lookup threw (${(err as Error).message.slice(0, 80)})`)
    continue
  }
  const ownerStr = owner ? (typeof owner === 'string' ? owner : owner.toBase58()) : null
  if (!ownerStr) {
    console.log(`${name}: not registered`)
    continue
  }
  const reverse = await parser.getParsedAllUserDomainsFromTld(ownerStr, 'skr')
  const names = reverse.map((d) => ('domain' in d ? d.domain : String(d)))
  console.log(`${name}: owner ${ownerStr} · reverse → [${names.join(', ')}] · round-trip ${names.some((n) => `${n}` === name || `${n}.skr` === name || n === name.replace(/\.skr$/, '')) ? 'OK' : 'MISMATCH'}`)
}

import { TldParser } from '@onsol/tldparser'
import { Connection } from '@solana/web3.js'

/*
 * D-52: .skr names, resolved the way Solana Mobile's official sample does it (docs.solanamobile.com
 * /solana-mobile-stack/skr-domain → react-native-samples/skr-address-resolution: @onsol/tldparser on mainnet,
 * AllDomains). A name is bound to a Blink user only when BOTH hold:
 *   1. reverse: one of the user's SIWS-verified wallets owns `<name>.skr` (getParsedAllUserDomainsFromTld), and
 *   2. forward: `<name>.skr` resolves back to that same wallet (getOwnerFromDomainTld).
 * The user never types a name, so a fake or someone else's .skr can't be claimed. Any error is "unable to verify".
 */

export type SkrLookup = { status: 'VERIFIED'; name: string; wallet: string } | { status: 'NONE' } | { status: 'UNAVAILABLE' }

export interface SkrNameResolver {
  /** Reverse lookup: the .skr names `wallet` owns (full names, e.g. "maris.skr"). Throws on RPC/library errors. */
  namesOf(wallet: string): Promise<string[]>
  /** Forward lookup: the owner of `name`, or null when it is not registered. Throws on RPC errors. */
  ownerOf(name: string): Promise<string | null>
}

const NAME_RE = /^[a-z0-9-]{1,63}\.skr$/

export class AllDomainsSkrResolver implements SkrNameResolver {
  private readonly parser: TldParser

  constructor(mainnetRpcUrl: string) {
    this.parser = new TldParser(new Connection(mainnetRpcUrl, 'confirmed'))
  }

  async namesOf(wallet: string): Promise<string[]> {
    const rows = await this.parser.getParsedAllUserDomainsFromTld(wallet, 'skr')
    return rows
      .map((r) => String((r as { domain?: string }).domain ?? '').toLowerCase())
      .map((d) => (d.endsWith('.skr') ? d : `${d}.skr`))
      .filter((d) => NAME_RE.test(d))
  }

  async ownerOf(name: string): Promise<string | null> {
    try {
      const owner = await this.parser.getOwnerFromDomainTld(name)
      if (!owner) return null
      return typeof owner === 'string' ? owner : owner.toBase58()
    } catch (err) {
      // tldparser throws a TypeError ("reading 'owner'") for an unregistered name; anything else is a real error.
      if (err instanceof TypeError && /owner/.test(err.message)) return null
      throw err
    }
  }
}

/** The .skr identity of a user from their SIWS-verified wallets (most recently linked first). */
export async function resolveSkrIdentity(resolver: SkrNameResolver, verifiedWallets: string[]): Promise<SkrLookup> {
  try {
    for (const wallet of verifiedWallets) {
      const names = (await resolver.namesOf(wallet)).sort()
      for (const name of names) {
        if ((await resolver.ownerOf(name)) === wallet) return { status: 'VERIFIED', name, wallet }
      }
    }
    return { status: 'NONE' }
  } catch {
    return { status: 'UNAVAILABLE' }
  }
}

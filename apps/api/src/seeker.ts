import { findSeekerGenesisToken } from '@blink/solana'
import { address, type GetGenesisHashApi, type GetMultipleAccountsApi, type GetTokenAccountsByOwnerApi, type Rpc } from '@solana/kit'

import type { SeekerVerifier } from './claim-service.ts'

const TTL_MS = 5 * 60_000
/** Mainnet-beta genesis hash, VERIFIED against the live cluster 2026-10-01. */
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/**
 * D-17: Seeker Genesis Token lookup on MAINNET (SGTs exist only there), whatever cluster payouts run on.
 * Results are cached briefly per wallet; a lookup failure is an error, never a silent "no SGT".
 */
export class MainnetSeekerVerifier implements SeekerVerifier {
  private readonly cache = new Map<string, { mint: string | null; at: number }>()
  private mainnetChecked = false

  constructor(private readonly rpc: Rpc<GetTokenAccountsByOwnerApi & GetMultipleAccountsApi & GetGenesisHashApi>) {}

  async findSgt(wallet: string): Promise<string | null> {
    if (!this.mainnetChecked) {
      // A non-mainnet RPC would answer "no SGT" for everyone; refuse instead.
      const genesis = await this.rpc.getGenesisHash().send()
      if (genesis !== MAINNET_GENESIS) throw new Error(`Seeker RPC is not mainnet-beta (genesis ${genesis})`)
      this.mainnetChecked = true
    }
    const hit = this.cache.get(wallet)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.mint
    const mint = await findSeekerGenesisToken(this.rpc, address(wallet))
    this.cache.set(wallet, { mint, at: Date.now() })
    return mint
  }
}

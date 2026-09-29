import { effectiveScaledUiMultiplier, inspectMint } from '@blink/solana'
import { address, type GetAccountInfoApi, type Rpc } from '@solana/kit'
import { fetchSysvarClock } from '@solana/sysvars'

export interface XStockMarketInfo {
  /** Effective Scaled UI multiplier at the cluster clock. Display-only; payouts use raw units. */
  multiplier: number
  decimals: number
  paused: boolean
  /** Cluster unix time (seconds) the multiplier was evaluated at. */
  asOf: number
}

/**
 * Read-only mainnet mint data for supported xStocks (they exist only on mainnet), cached briefly so the
 * rate-limited public RPC isn't hammered. Never signs or sends anything.
 */
export class XStockMarket {
  private cache: { at: number; data: Map<string, XStockMarketInfo> } | null = null

  constructor(
    private readonly rpc: Rpc<GetAccountInfoApi> | undefined,
    private readonly ttlMs = 60_000,
    private readonly assets: { mint: string }[] = [],
  ) {}

  async getAll(): Promise<Map<string, XStockMarketInfo>> {
    if (!this.rpc) return new Map()
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.data
    const clock = await fetchSysvarClock(this.rpc)
    const data = new Map<string, XStockMarketInfo>()
    for (const x of this.assets) {
      try {
        const info = await inspectMint(this.rpc, address(x.mint))
        if (!info.scaledUi) continue
        data.set(x.mint, {
          multiplier: effectiveScaledUiMultiplier(info.scaledUi, clock.unixTimestamp),
          decimals: info.decimals,
          paused: info.pausable?.paused ?? false,
          asOf: Number(clock.unixTimestamp),
        })
      } catch {
        // Leave this mint without market data; the client shows raw-safe fallbacks.
      }
    }
    this.cache = { at: Date.now(), data }
    return data
  }
}

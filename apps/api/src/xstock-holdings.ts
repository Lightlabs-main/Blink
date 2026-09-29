import { SUPPORTED_XSTOCKS } from '@blink/xstocks'
import { address, type GetTokenAccountsByOwnerApi, type Rpc } from '@solana/kit'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

/** Raw xStock balances (base units, decimal strings) keyed by mint. Read-only mainnet data. */
export type Holdings = Record<string, string>

/**
 * Sum a wallet's balances of supported xStocks across all its Token-2022 accounts (ATA and any others).
 * One RPC call per wallet, cached briefly. Never signs or sends.
 */
export class XStockHoldings {
  private readonly cache = new Map<string, { at: number; data: Holdings }>()

  constructor(
    private readonly rpc: Rpc<GetTokenAccountsByOwnerApi> | undefined,
    private readonly ttlMs = 30_000,
  ) {}

  async forOwner(owner: string): Promise<Holdings | null> {
    if (!this.rpc) return null
    const hit = this.cache.get(owner)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.data

    const { value } = await this.rpc
      .getTokenAccountsByOwner(address(owner), { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'jsonParsed', commitment: 'confirmed' })
      .send()

    const supported = new Set(SUPPORTED_XSTOCKS.map((x) => x.mint))
    const totals = new Map<string, bigint>()
    for (const { account } of value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info
      const mint = info?.mint
      const amount = info?.tokenAmount?.amount
      if (!mint || !supported.has(mint) || !amount || !/^\d+$/.test(amount)) continue
      totals.set(mint, (totals.get(mint) ?? 0n) + BigInt(amount))
    }
    const data: Holdings = {}
    for (const mint of supported) data[mint] = (totals.get(mint) ?? 0n).toString()
    this.cache.set(owner, { at: Date.now(), data })
    return data
  }
}

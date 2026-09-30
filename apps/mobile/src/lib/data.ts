import { usePrivy } from '@privy-io/expo'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { rawToUiShares } from '../shared'
import { api, type XStockListing } from './api'

/** Shared queries so every screen reads the same cache. */
export function useAssets() {
  return useQuery({ queryKey: ['xstocks'], queryFn: api.xstocks, staleTime: 60_000 })
}

export function useNetwork() {
  return useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 5 * 60_000 })
}

export function useMe() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['me'], queryFn: () => api.me(getAccessToken), enabled: Boolean(user) })
}

export function useMyCampaigns() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['my-campaigns'], queryFn: () => api.myCampaigns(getAccessToken), enabled: Boolean(user) })
}

export function useLiveCampaigns() {
  return useQuery({ queryKey: ['campaigns', 'live'], queryFn: api.liveCampaigns })
}

export function useHoldings() {
  const { getAccessToken, user } = usePrivy()
  return useQuery({ queryKey: ['holdings'], queryFn: () => api.holdings(getAccessToken), enabled: Boolean(user), staleTime: 30_000 })
}

export function useAssetMap() {
  const assets = useAssets()
  return useMemo(() => new Map((assets.data?.xstocks ?? []).map((a) => [a.mint, a])), [assets.data])
}

/** Display string for a raw amount of an asset ("0.1"), or null when the multiplier is unknown. Display only. */
export function displayShares(asset: XStockListing | undefined, raw: string | bigint): string | null {
  if (!asset || asset.multiplier == null) return null
  return rawToUiShares(BigInt(raw), asset.decimals, asset.multiplier)
}

export interface Position {
  asset: XStockListing
  raw: bigint
  shares: string | null
  /** Which of the user's wallets hold it. */
  kinds: ('stock' | 'creator')[]
}

/** Non-zero positions across the user's stock (embedded) wallet and creator wallets. */
export function usePositions() {
  const holdings = useHoldings()
  const assets = useAssets()
  const positions = useMemo<Position[]>(() => {
    const list = assets.data?.xstocks ?? []
    const out: Position[] = []
    for (const asset of list) {
      let raw = 0n
      const kinds = new Set<'stock' | 'creator'>()
      for (const w of holdings.data?.wallets ?? []) {
        const b = w.balances?.[asset.mint]
        if (b && b !== '0') {
          raw += BigInt(b)
          kinds.add(w.kind)
        }
      }
      if (raw > 0n) out.push({ asset, raw, shares: displayShares(asset, raw), kinds: [...kinds] })
    }
    return out
  }, [holdings.data, assets.data])
  return { positions, isLoading: holdings.isPending || assets.isPending, available: holdings.data?.available ?? false, error: holdings.error }
}

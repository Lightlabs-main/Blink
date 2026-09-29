import type { BlinkEnv } from '@blink/config'
import { SUPPORTED_XSTOCKS } from '@blink/xstocks'

export interface Asset {
  symbol: string
  name: string
  mint: string
  decimals: number
  /** True for devnet test stand-ins that have no real-world value. */
  isTest: boolean
}

/**
 * Campaign assets for the configured cluster. Real xStocks exist only on mainnet (verified mints in
 * @blink/xstocks). Devnet uses a test mint created by scripts/devnet-test-mint.ts that mirrors xStock extensions.
 */
export function assetsForCluster(env: BlinkEnv): Asset[] {
  if (env.SOLANA_CLUSTER === 'mainnet-beta') {
    return SUPPORTED_XSTOCKS.map((x) => ({ ...x, isTest: false }))
  }
  if (env.SOLANA_CLUSTER === 'devnet' && env.DEVNET_TEST_MINT) {
    return [{ symbol: 'tNVDAx', name: 'Test NVIDIA (devnet, no value)', mint: env.DEVNET_TEST_MINT, decimals: 8, isTest: true }]
  }
  return []
}

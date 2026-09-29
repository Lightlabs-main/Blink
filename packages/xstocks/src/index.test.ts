import { describe, expect, it } from 'vitest'

import {
  findXStockByMint,
  multiplierToFraction,
  rawToUiShares,
  ScaledUiError,
  SUPPORTED_XSTOCKS,
  uiSharesToRawFloor,
} from './index.ts'

describe('registry', () => {
  it('has unique symbols and mints', () => {
    expect(new Set(SUPPORTED_XSTOCKS.map((x) => x.mint)).size).toBe(SUPPORTED_XSTOCKS.length)
    expect(new Set(SUPPORTED_XSTOCKS.map((x) => x.symbol)).size).toBe(SUPPORTED_XSTOCKS.length)
  })
  it('looks up by exact mint only', () => {
    const first = SUPPORTED_XSTOCKS[0]!
    expect(findXStockByMint(first.mint)?.symbol).toBe(first.symbol)
    expect(findXStockByMint(first.mint.toLowerCase())).toBeUndefined()
  })
})

describe('multiplierToFraction', () => {
  it('is exact for the shortest decimal form', () => {
    expect(multiplierToFraction(1)).toEqual({ numerator: 1n, denominator: 1n })
    expect(multiplierToFraction(1.0009180758490996)).toEqual({
      numerator: 10009180758490996n,
      denominator: 10n ** 16n,
    })
  })
  it('rejects zero, negative, non-finite and exponent forms', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e-7, 1e21]) {
      expect(() => multiplierToFraction(bad)).toThrow(ScaledUiError)
    }
  })
})

describe('Scaled UI conversions (8 decimals, as observed on xStocks)', () => {
  it('multiplier 1: 1 share = 10^8 raw', () => {
    expect(uiSharesToRawFloor('1', 8, 1)).toBe(100_000_000n)
    expect(rawToUiShares(100_000_000n, 8, 1)).toBe('1')
  })

  it('rounds raw down so the payout never exceeds the promised shares', () => {
    const m = 1.0009180758490996
    const raw = uiSharesToRawFloor('0.01', 8, m)
    // raw * m / 1e8 must be <= 0.01 shares, and raw + 1 must exceed it.
    const f = multiplierToFraction(m)
    expect(raw * f.numerator * 100n <= 10n ** 8n * f.denominator).toBe(true)
    expect((raw + 1n) * f.numerator * 100n > 10n ** 8n * f.denominator).toBe(true)
  })

  it('display floors rather than rounding up', () => {
    expect(rawToUiShares(99_999_999n, 8, 1, 2)).toBe('0.99')
  })

  it('handles large raw amounts without float drift', () => {
    const raw = 32_127_184_794_500n // observed NVDAx supply, raw units
    expect(rawToUiShares(raw, 8, 1)).toBe('321271.847945')
  })

  it('rejects malformed share strings', () => {
    for (const bad of ['', '-1', '1e3', '1.', '.5', 'abc']) {
      expect(() => uiSharesToRawFloor(bad, 8, 1)).toThrow(ScaledUiError)
    }
  })
})

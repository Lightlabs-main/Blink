import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { tokenDelta, type TokenBalanceTx, verifySkrTransfer } from './skr-transfer.ts'
import { SKR_MINT } from './stake-readers.ts'

// A real SKR transfer between two wallets on mainnet (public data), captured 2026-10-09.
const REAL = JSON.parse(readFileSync(new URL('./__fixtures__/skr-transfer-tx.json', import.meta.url), 'utf8')) as TokenBalanceTx
const owners = [...new Set([...(REAL.meta!.preTokenBalances ?? []), ...(REAL.meta!.postTokenBalances ?? [])].filter((r) => r.mint === SKR_MINT).map((r) => r.owner!))]
const deltas = owners.map((o) => ({ owner: o, d: tokenDelta(REAL, o, SKR_MINT) }))
const from = deltas.find((x) => x.d < 0n)!
const to = deltas.find((x) => x.d > 0n)!
const clone = () => JSON.parse(JSON.stringify(REAL)) as TokenBalanceTx

describe('SKR transfer verification (real mainnet fixture)', () => {
  it('accepts the exact sender, recipient and amount', () => {
    expect(to.d).toBe(-from.d)
    expect(verifySkrTransfer(REAL, { from: from.owner, to: to.owner, amountRaw: to.d })).toEqual({ ok: true })
  })

  it('rejects a wrong amount, a wrong recipient, a swapped direction and a failed transaction', () => {
    expect(verifySkrTransfer(REAL, { from: from.owner, to: to.owner, amountRaw: to.d + 1n })).toEqual({ ok: false, reason: 'WRONG_AMOUNT' })
    expect(verifySkrTransfer(REAL, { from: from.owner, to: '11111111111111111111111111111112', amountRaw: to.d })).toEqual({ ok: false, reason: 'WRONG_RECIPIENT' })
    expect(verifySkrTransfer(REAL, { from: to.owner, to: from.owner, amountRaw: to.d }).ok).toBe(false)
    const failed = clone()
    failed.meta!.err = { InstructionError: [1, 'Custom'] }
    expect(verifySkrTransfer(failed, { from: from.owner, to: to.owner, amountRaw: to.d })).toEqual({ ok: false, reason: 'FAILED' })
  })

  it('ignores a look-alike token: the same balances under another mint never count as SKR', () => {
    const fake = clone()
    for (const r of [...(fake.meta!.preTokenBalances ?? []), ...(fake.meta!.postTokenBalances ?? [])]) (r as { mint: string }).mint = 'FakeSKR1111111111111111111111111111111111111'
    expect(verifySkrTransfer(fake, { from: from.owner, to: to.owner, amountRaw: to.d })).toEqual({ ok: false, reason: 'WRONG_RECIPIENT' })
  })

  it('ignores SKR-mint balances reported under another token program', () => {
    const other = clone()
    for (const r of [...(other.meta!.preTokenBalances ?? []), ...(other.meta!.postTokenBalances ?? [])]) (r as { programId?: string }).programId = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
    expect(verifySkrTransfer(other, { from: from.owner, to: to.owner, amountRaw: to.d }).ok).toBe(false)
  })
})

import { readFileSync } from 'node:fs'

import { address } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import {
  buildOreDeployInstruction,
  decodeDeployEvent,
  maskToSquares,
  normalizeJsonTransaction,
  ORE_BOARD_ADDRESS,
  ORE_CHECKPOINT_FEE,
  oreDeployCost,
  oreNeedsCheckpoint,
  type OreMiner,
  type RpcJsonTransaction,
  squaresToMask,
  verifyOreDeployTx,
} from './ore.ts'
import { ORE_PROGRAM } from './stake-readers.ts'

// A real manual deploy from mainnet (public data), captured 2026-10-09 by the fixture script in
// docs/SKR_ORE_TEST_REPORT.md. Negative cases mutate a deep copy of it.
const REAL = JSON.parse(readFileSync(new URL('./__fixtures__/ore-deploy-tx.json', import.meta.url), 'utf8')) as RpcJsonTransaction
const clone = () => JSON.parse(JSON.stringify(REAL)) as RpcJsonTransaction
const signerOf = (tx: RpcJsonTransaction) => address(tx.transaction.message.accountKeys[0]!)

describe('ORE deploy verification (real mainnet fixture)', () => {
  it('verifies the genuine deploy for its own signer and decodes the event', () => {
    const v = verifyOreDeployTx(normalizeJsonTransaction(REAL), signerOf(REAL))
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.event.authority).toBe(signerOf(REAL))
    expect(v.event.roundId > 0n).toBe(true)
    expect(v.squares.length).toBe(Number(v.event.totalSquares))
    expect(v.totalLamports).toBe(v.event.amountPerSquare * v.event.totalSquares)
  })

  it('rejects another wallet (wrong authority)', () => {
    expect(verifyOreDeployTx(normalizeJsonTransaction(REAL), address('11111111111111111111111111111112'))).toEqual({ ok: false, reason: 'WRONG_AUTHORITY' })
  })

  it('rejects a failed transaction', () => {
    const tx = clone()
    tx.meta!.err = { InstructionError: [0, { Custom: 1 }] }
    expect(verifyOreDeployTx(normalizeJsonTransaction(tx), signerOf(tx))).toEqual({ ok: false, reason: 'FAILED' })
  })

  it('rejects a transaction without an ORE Deploy instruction (e.g. an unrelated SOL transfer)', () => {
    const tx = clone()
    tx.transaction.message.instructions = tx.transaction.message.instructions.filter((ix) => tx.transaction.message.accountKeys[ix.programIdIndex] !== ORE_PROGRAM)
    expect(verifyOreDeployTx(normalizeJsonTransaction(tx), signerOf(tx))).toEqual({ ok: false, reason: 'NO_DEPLOY' })
  })

  it('rejects an event logged by another program (forged event)', () => {
    const tx = clone()
    const keys = tx.transaction.message.accountKeys as string[]
    keys.push('11111111111111111111111111111113')
    for (const g of tx.meta!.innerInstructions!) for (const ix of g.instructions) if (keys[ix.programIdIndex] === ORE_PROGRAM) (ix as { programIdIndex: number }).programIdIndex = keys.length - 1
    expect(verifyOreDeployTx(normalizeJsonTransaction(tx), signerOf(tx))).toEqual({ ok: false, reason: 'NO_DEPLOY' })
  })

  it('rejects an ORE Log not signed by the Board PDA', () => {
    const norm = normalizeJsonTransaction(REAL)
    const signerIdx = 0
    const forged = { ...norm, inner: norm.inner.map((ix) => ({ ...ix, accounts: [signerIdx, ...ix.accounts.slice(1)] })) }
    expect(norm.accountKeys[signerIdx]).not.toBe(ORE_BOARD_ADDRESS)
    expect(verifyOreDeployTx(forged, signerOf(REAL))).toEqual({ ok: false, reason: 'NO_DEPLOY' })
  })

  it('rejects automation deploys, zero-effect deploys and duplicate events', () => {
    const norm = normalizeJsonTransaction(REAL)
    const logIdx = norm.inner.findIndex((ix) => norm.accountKeys[ix.programIdIndex] === ORE_PROGRAM)
    const withEvent = (patch: (b: Uint8Array) => void) => {
      const data = Uint8Array.from(norm.inner[logIdx]!.data)
      patch(data.subarray(1))
      return { ...norm, inner: norm.inner.map((ix, i) => (i === logIdx ? { ...ix, data } : ix)) }
    }
    // strategy u64 @96 within the event: anything but u64::MAX is an autominer.
    expect(verifyOreDeployTx(withEvent((b) => b.fill(0, 96, 104)), signerOf(REAL))).toEqual({ ok: false, reason: 'NOT_MANUAL' })
    // total_squares u64 @104 = 0 and mask @48 = 0: the deploy added no square.
    expect(verifyOreDeployTx(withEvent((b) => { b.fill(0, 104, 112); b.fill(0, 48, 56) }), signerOf(REAL))).toEqual({ ok: false, reason: 'ZERO_EFFECT' })
    const dup = { ...norm, inner: [...norm.inner, norm.inner[logIdx]!] }
    expect(verifyOreDeployTx(dup, signerOf(REAL))).toEqual({ ok: false, reason: 'MULTIPLE' })
  })

  it('decodes only DeployEvent bytes (discriminator 2, 120 bytes)', () => {
    expect(decodeDeployEvent(new Uint8Array(119))).toBeNull()
    const other = new Uint8Array(120)
    other[0] = 4 // ClaimEvent
    expect(decodeDeployEvent(other)).toBeNull()
  })
})

describe('ORE deploy construction', () => {
  it('encodes Deploy = 6 · amount u64 LE · squares u32 LE mask, with the official account order', async () => {
    const authority = address('11111111111111111111111111111112')
    const ix = await buildOreDeployInstruction({ authority, amountLamports: 10_000n, roundId: 433_821n, squares: [0, 24] })
    expect(ix.programAddress).toBe(ORE_PROGRAM)
    expect(ix.data![0]).toBe(6)
    expect(Buffer.from(ix.data!.subarray(1, 9)).readBigUInt64LE()).toBe(10_000n)
    expect(Buffer.from(ix.data!.subarray(9, 13)).readUInt32LE()).toBe((1 << 0) | (1 << 24))
    expect(ix.accounts).toHaveLength(12)
    expect(ix.accounts![0]!.address).toBe(authority)
    expect(ix.accounts![3]!.address).toBe(ORE_BOARD_ADDRESS)
  })

  it('validates squares and amounts', async () => {
    expect(() => squaresToMask([25])).toThrow()
    expect(maskToSquares(squaresToMask([3, 7]))).toEqual([3, 7])
    await expect(buildOreDeployInstruction({ authority: address('11111111111111111111111111111112'), amountLamports: 0n, roundId: 1n, squares: [1] })).rejects.toThrow()
    await expect(buildOreDeployInstruction({ authority: address('11111111111111111111111111111112'), amountLamports: 1n, roundId: 1n, squares: [] })).rejects.toThrow()
  })

  it('needs a checkpoint only when the miner played an unsettled earlier round', () => {
    const miner = (roundId: bigint, checkpointId: bigint): OreMiner => ({ authority: address('11111111111111111111111111111112'), checkpointId, checkpointFee: 0n, deployed: Array(25).fill(0n), roundId })
    expect(oreNeedsCheckpoint(null, 10n)).toBe(false)
    expect(oreNeedsCheckpoint(miner(10n, 9n), 10n)).toBe(false)
    expect(oreNeedsCheckpoint(miner(9n, 9n), 10n)).toBe(false)
    expect(oreNeedsCheckpoint(miner(9n, 8n), 10n)).toBe(true)
  })

  it('prices a first deploy with Miner rent and the checkpoint fee', () => {
    const first = oreDeployCost({ amountLamports: 10_000n, squares: 2, miner: null, minerRentLamports: 4_470_400n })
    expect(first).toEqual({ stake: 20_000n, checkpointFee: ORE_CHECKPOINT_FEE, minerRent: 4_470_400n, total: 20_000n + ORE_CHECKPOINT_FEE + 4_470_400n })
  })
})

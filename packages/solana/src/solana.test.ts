import { createHash, randomUUID } from 'node:crypto'

import { type Address, address, getAddressCodec, getU64Encoder, getBase64Decoder } from '@solana/kit'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'
import { describe, expect, it } from 'vitest'

import {
  assertStoredCampaignAccount,
  CampaignAccountMismatchError,
  campaignSeedFromHash,
  campaignSeedFromUuid,
  CampaignSeedError,
  decodeAccountSizeReturnData,
  deriveCampaignTokenAccount,
  effectiveScaledUiMultiplier,
  evaluateDelegation,
  MAX_CREATE_WITH_SEED_LENGTH,
} from './index.ts'

// Arbitrary valid base58 addresses used purely as test inputs (not real wallets or mints).
const CREATOR = address('11111111111111111111111111111112')
const OTHER = address('11111111111111111111111111111113')

describe('campaign seed (MASTER_PROMPT §11)', () => {
  it('UUID without hyphens is exactly 32 ASCII hex chars', () => {
    const seed = campaignSeedFromUuid('3f2b8c1e-9d4a-4c7b-8e2f-1a0b9c8d7e6f')
    expect(seed).toBe('3f2b8c1e9d4a4c7b8e2f1a0b9c8d7e6f')
    expect(new TextEncoder().encode(seed).byteLength).toBe(MAX_CREATE_WITH_SEED_LENGTH)
  })

  it('is deterministic for random UUIDs and always 32 bytes', () => {
    for (let i = 0; i < 100; i++) {
      const id = randomUUID()
      expect(campaignSeedFromUuid(id)).toBe(campaignSeedFromUuid(id))
      expect(campaignSeedFromUuid(id)).toHaveLength(32)
    }
  })

  it('rejects uppercase / malformed / UUID+mint inputs rather than normalising', () => {
    expect(() => campaignSeedFromUuid('3F2B8C1E-9D4A-4C7B-8E2F-1A0B9C8D7E6F')).toThrow(CampaignSeedError)
    expect(() => campaignSeedFromUuid('not-a-uuid')).toThrow(CampaignSeedError)
    expect(() => campaignSeedFromUuid(`${randomUUID()}${CREATOR}`)).toThrow(CampaignSeedError)
  })

  it('hash fallback = first 32 hex chars of sha256(campaignId:mint)', () => {
    const expected = createHash('sha256').update('camp-1:MINT').digest('hex').slice(0, 32)
    expect(campaignSeedFromHash('camp-1', 'MINT')).toBe(expected)
    expect(campaignSeedFromHash('camp-1', 'MINT')).toHaveLength(32)
    expect(campaignSeedFromHash('camp-1', 'MINT2')).not.toBe(expected)
  })
})

describe('campaign token account derivation', () => {
  const seed = campaignSeedFromUuid('3f2b8c1e-9d4a-4c7b-8e2f-1a0b9c8d7e6f')

  it('matches sha256(base || seed || token2022ProgramId) computed independently', async () => {
    const codec = getAddressCodec()
    const digest = createHash('sha256')
      .update(Uint8Array.from(codec.encode(CREATOR)))
      .update(Buffer.from(seed, 'utf8'))
      .update(Uint8Array.from(codec.encode(TOKEN_2022_PROGRAM_ADDRESS)))
      .digest()
    const expected = codec.decode(new Uint8Array(digest))
    expect(await deriveCampaignTokenAccount({ creator: CREATOR, campaignSeed: seed })).toBe(expected)
  })

  it('differs per creator', async () => {
    const a = await deriveCampaignTokenAccount({ creator: CREATOR, campaignSeed: seed })
    const b = await deriveCampaignTokenAccount({ creator: OTHER, campaignSeed: seed })
    expect(a).not.toBe(b)
  })

  it('rejects a client-supplied address that does not match', async () => {
    await expect(
      assertStoredCampaignAccount({ creator: CREATOR, campaignSeed: seed, storedAccount: OTHER }),
    ).rejects.toThrow(CampaignAccountMismatchError)
  })

  it('refuses seeds over 32 bytes', async () => {
    await expect(deriveCampaignTokenAccount({ creator: CREATOR, campaignSeed: 'x'.repeat(33) })).rejects.toThrow(
      CampaignSeedError,
    )
  })
})

describe('GetAccountDataSize return data', () => {
  it('decodes u64 little-endian', () => {
    const b64 = getBase64Decoder().decode(getU64Encoder().encode(182n))
    expect(decodeAccountSizeReturnData(b64)).toBe(182n)
  })
  it('refuses missing or malformed data', () => {
    expect(() => decodeAccountSizeReturnData(undefined)).toThrow()
    expect(() => decodeAccountSizeReturnData('AAAA')).toThrow()
  })
})

describe('effectiveScaledUiMultiplier', () => {
  const cfg = { multiplier: 1, newMultiplier: 1.05, newMultiplierEffectiveTimestamp: 1_000n }
  it('uses the old multiplier before the effective time', () => {
    expect(effectiveScaledUiMultiplier(cfg, 999n)).toBe(1)
  })
  it('uses the new multiplier at and after the effective time', () => {
    expect(effectiveScaledUiMultiplier(cfg, 1_000n)).toBe(1.05)
    expect(effectiveScaledUiMultiplier(cfg, 5_000n)).toBe(1.05)
  })
})

describe('evaluateDelegation', () => {
  const DELEGATE = address('11111111111111111111111111111114')
  const MINT = address('11111111111111111111111111111115')
  const expected = { account: OTHER, mint: MINT, creator: CREATOR, delegate: DELEGATE }
  const healthy = {
    mint: MINT,
    owner: CREATOR,
    amount: 100n,
    delegate: DELEGATE as Address | null,
    delegatedAmount: 40n,
    frozen: false,
  }

  it('valid delegation distributes up to the allowance', () => {
    const s = evaluateDelegation(expected, healthy)
    expect(s.valid).toBe(true)
    expect(s.distributable).toBe(40n)
  })

  it('caps distributable at balance when allowance exceeds balance', () => {
    const s = evaluateDelegation(expected, { ...healthy, amount: 10n })
    expect(s.valid).toBe(true)
    expect(s.problems).toContain('ALLOWANCE_EXCEEDS_BALANCE')
    expect(s.distributable).toBe(10n)
  })

  it.each([
    [{ delegate: null }, 'NO_DELEGATE'],
    [{ delegate: OTHER }, 'WRONG_DELEGATE'],
    [{ owner: OTHER }, 'WRONG_OWNER'],
    [{ mint: OTHER }, 'WRONG_MINT'],
    [{ frozen: true }, 'FROZEN'],
    [{ delegatedAmount: 0n }, 'ALLOWANCE_EXHAUSTED'],
  ] as const)('invalid when %o → %s, distributable 0', (patch, problem) => {
    const s = evaluateDelegation(expected, { ...healthy, ...patch })
    expect(s.valid).toBe(false)
    expect(s.problems).toContain(problem)
    expect(s.distributable).toBe(0n)
  })
})

describe('multiplierUpdateInProgress (W-2, xStocks 15-minute window)', () => {
  const cfg = (ts: bigint) => ({ multiplier: 1, newMultiplier: 1.01, newMultiplierEffectiveTimestamp: ts })
  it('is true from 15 minutes before to 15 minutes after an activation', async () => {
    const { multiplierUpdateInProgress } = await import('./mint.ts')
    const t = 1_800_000_000n
    expect(multiplierUpdateInProgress(cfg(t), t - 901n)).toBe(false)
    expect(multiplierUpdateInProgress(cfg(t), t - 900n)).toBe(true)
    expect(multiplierUpdateInProgress(cfg(t), t)).toBe(true)
    expect(multiplierUpdateInProgress(cfg(t), t + 900n)).toBe(true)
    expect(multiplierUpdateInProgress(cfg(t), t + 901n)).toBe(false)
  })
  it('is false without a scheduled activation or Scaled UI', async () => {
    const { multiplierUpdateInProgress } = await import('./mint.ts')
    expect(multiplierUpdateInProgress(cfg(0n), 1_800_000_000n)).toBe(false)
    expect(multiplierUpdateInProgress(null, 1_800_000_000n)).toBe(false)
  })
})

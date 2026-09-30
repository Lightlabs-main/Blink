import { assessTapRound, canTransition } from '@blink/domain'
import { describe, expect, it } from 'vitest'

import { claimRequest, createCampaignRequest, finishTapRushRequest, rawAmount } from './index.ts'

const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'

describe('createCampaignRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(createCampaignRequest.parse({ type: 'TAP_RUSH', mint, allowanceRaw: '1000000', rewardPerClaimRaw: '1000' })).toEqual({
      type: 'TAP_RUSH',
      mint,
      allowanceRaw: '1000000',
      rewardPerClaimRaw: '1000',
    })
  })

  it('requires a positive amount per person for claimable mechanics, at most the total', () => {
    expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw: '100' }).success).toBe(false)
    expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw: '100', rewardPerClaimRaw: '0' }).success).toBe(false)
    expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw: '100', rewardPerClaimRaw: '101' }).success).toBe(false)
    expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw: '100', rewardPerClaimRaw: '100' }).success).toBe(true)
    // Mechanics without claiming yet may omit it.
    expect(createCampaignRequest.safeParse({ type: 'SEEKER', mint, allowanceRaw: '100' }).success).toBe(true)
    expect(createCampaignRequest.safeParse({ type: 'REFERRAL', mint, allowanceRaw: '100' }).success).toBe(false)
  })

  it('accepts Tap Rush rules only within limits and only for TAP_RUSH', () => {
    const base = { mint, allowanceRaw: '100', rewardPerClaimRaw: '10' }
    expect(createCampaignRequest.safeParse({ ...base, type: 'TAP_RUSH', tapRush: { goal: 50, seconds: 10 } }).success).toBe(true)
    expect(createCampaignRequest.safeParse({ ...base, type: 'TAP_RUSH', tapRush: { goal: 5, seconds: 10 } }).success).toBe(false)
    expect(createCampaignRequest.safeParse({ ...base, type: 'TAP_RUSH', tapRush: { goal: 50, seconds: 60 } }).success).toBe(false)
    expect(createCampaignRequest.safeParse({ ...base, type: 'GIFT', tapRush: { goal: 50, seconds: 10 } }).success).toBe(false)
  })

  it('rejects client-supplied wallet or campaign account fields (strict)', () => {
    for (const extra of [{ creatorWallet: mint }, { campaignTokenAccount: mint }, { delegateAddress: mint }]) {
      expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw: '1', ...extra }).success).toBe(false)
    }
  })

  it('rejects zero allowance and non-integer amounts', () => {
    for (const allowanceRaw of ['0', '1.5', '-1', '01', '1e6', '']) {
      expect(createCampaignRequest.safeParse({ type: 'GIFT', mint, allowanceRaw }).success).toBe(false)
    }
  })
})

describe('claim and Tap Rush requests', () => {
  const id = '6f1c1c0e-6a2b-4c55-9a36-3d1f6f0f2b11'
  it('finish needs a session id, a sane integer tap count and the tap times', () => {
    const tapTimesMs = [100, 250]
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 2, tapTimesMs }).success).toBe(true)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 2 }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: -1, tapTimesMs }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 1.5, tapTimesMs }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 100_000, tapTimesMs }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 2, tapTimesMs: [100, -5] }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: 'x', taps: 1, tapTimesMs }).success).toBe(false)
  })
  it('claim accepts only an optional session id and invite code', () => {
    expect(claimRequest.safeParse({}).success).toBe(true)
    expect(claimRequest.safeParse({ tapSessionId: id }).success).toBe(true)
    expect(claimRequest.safeParse({ ref: 'ABCDEFGH' }).success).toBe(true)
    expect(claimRequest.safeParse({ ref: 'abc' }).success).toBe(false)
    expect(claimRequest.safeParse({ ref: 'ABCDEFG0' }).success).toBe(false)
    expect(claimRequest.safeParse({ recipientWallet: mint }).success).toBe(false)
  })
})

describe('rawAmount', () => {
  it('enforces the u64 range', () => {
    expect(rawAmount.safeParse('18446744073709551615').success).toBe(true)
    expect(rawAmount.safeParse('18446744073709551616').success).toBe(false)
  })
})

describe('campaign lifecycle', () => {
  it('cannot go LIVE without delegation', () => {
    expect(canTransition('DRAFT', 'LIVE')).toBe(false)
    expect(canTransition('AWAITING_FUNDING', 'LIVE')).toBe(false)
    expect(canTransition('AWAITING_DELEGATION', 'LIVE')).toBe(true)
  })
  it('CLOSED is terminal', () => {
    expect(canTransition('CLOSED', 'DRAFT')).toBe(false)
  })
})

describe('assessTapRound (D-14)', () => {
  const human = Array.from({ length: 40 }, (_, i) => 120 + i * 140 + ((i * 53) % 70))
  it('accepts human-like timings', () => {
    expect(assessTapRound(human, 40, 10)).toEqual({ ok: true })
  })
  it('rejects a count that does not match, out-of-round or unordered times', () => {
    expect(assessTapRound(human, 41, 10)).toMatchObject({ reason: 'COUNT_MISMATCH' })
    expect(assessTapRound([...human.slice(0, 39), 11_000], 40, 10)).toMatchObject({ reason: 'OUT_OF_ROUND' })
    expect(assessTapRound([300, 200], 2, 10)).toMatchObject({ reason: 'OUT_OF_ORDER' })
  })
  it('tolerates an odd double-thumb tap but rejects repeated finger-impossible gaps and bursts', () => {
    const oneDouble = [...human.slice(0, 20), human[19]! + 10, ...human.slice(20).map((t) => t + 10)].slice(0, 40)
    expect(assessTapRound(oneDouble, 40, 10)).toEqual({ ok: true })
    expect(assessTapRound([100, 110, 120, 130], 4, 10)).toMatchObject({ reason: 'TOO_FAST' })
    expect(assessTapRound(Array.from({ length: 22 }, (_, i) => 100 + i * 40 + (i % 3) * 3), 22, 10)).toMatchObject({ reason: 'BURST' })
  })
  it('rejects metronome-perfect intervals', () => {
    expect(assessTapRound(Array.from({ length: 30 }, (_, i) => 100 + i * 150), 30, 10)).toMatchObject({ reason: 'ROBOTIC' })
  })
})

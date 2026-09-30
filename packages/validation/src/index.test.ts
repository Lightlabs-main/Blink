import { canTransition } from '@blink/domain'
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
    expect(createCampaignRequest.safeParse({ type: 'REFERRAL', mint, allowanceRaw: '100' }).success).toBe(true)
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
  it('finish needs a session id and a sane integer tap count', () => {
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 40 }).success).toBe(true)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: -1 }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 1.5 }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: id, taps: 100_000 }).success).toBe(false)
    expect(finishTapRushRequest.safeParse({ sessionId: 'x', taps: 1 }).success).toBe(false)
  })
  it('claim accepts only an optional session id', () => {
    expect(claimRequest.safeParse({}).success).toBe(true)
    expect(claimRequest.safeParse({ tapSessionId: id }).success).toBe(true)
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

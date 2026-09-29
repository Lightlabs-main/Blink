import { canTransition } from '@blink/domain'
import { describe, expect, it } from 'vitest'

import { createCampaignRequest, rawAmount } from './index.ts'

const mint = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'

describe('createCampaignRequest', () => {
  it('accepts a minimal valid request', () => {
    expect(createCampaignRequest.parse({ type: 'TAP_RUSH', mint, allowanceRaw: '1000000' })).toEqual({
      type: 'TAP_RUSH',
      mint,
      allowanceRaw: '1000000',
    })
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

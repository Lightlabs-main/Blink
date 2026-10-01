import { address, none, some } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import { isSeekerGenesisMint, SGT_GROUP_MINT_ADDRESS, SGT_METADATA_ADDRESS, SGT_MINT_AUTHORITY } from './seeker.ts'

const MINT = address('11111111111111111111111111111112')
const OTHER = address('11111111111111111111111111111113')

function mint(over: { authority?: typeof SGT_MINT_AUTHORITY | null; pointerAuthority?: typeof OTHER; metadata?: typeof OTHER; group?: typeof OTHER; memberMint?: typeof OTHER; extensions?: boolean } = {}) {
  const extensions = [
    { __kind: 'MetadataPointer' as const, authority: some(over.pointerAuthority ?? SGT_MINT_AUTHORITY), metadataAddress: some(over.metadata ?? SGT_METADATA_ADDRESS) },
    { __kind: 'TokenGroupMember' as const, mint: over.memberMint ?? MINT, group: over.group ?? SGT_GROUP_MINT_ADDRESS, memberNumber: 7n },
  ]
  return {
    mintAuthority: over.authority === null ? none() : some(over.authority ?? SGT_MINT_AUTHORITY),
    extensions: over.extensions === false ? none() : some(extensions),
  } as never
}

describe('isSeekerGenesisMint (official checks, D-17)', () => {
  it('accepts a mint with the SGT authority, metadata pointer and group membership', () => {
    expect(isSeekerGenesisMint(MINT, mint())).toBe(true)
  })
  it('rejects look-alikes', () => {
    expect(isSeekerGenesisMint(MINT, mint({ authority: null }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ authority: OTHER as never }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ pointerAuthority: OTHER }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ metadata: OTHER }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ group: OTHER }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ memberMint: OTHER }))).toBe(false)
    expect(isSeekerGenesisMint(MINT, mint({ extensions: false }))).toBe(false)
  })
})

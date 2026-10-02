import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { describe, expect, it } from 'vitest'

import { sameIntentAllowingWalletAdditions } from './wallet-additions.ts'

const PAYER = address('GXi7r4s9ci3oqhmKvDSmc6wvDZLUJSyL6acpyfDhx3yW')
const OTHER = address('So11111111111111111111111111111111111111112')
const TOKEN = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const blockhash = { blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi' as Blockhash, lastValidBlockHeight: 100n }

const transfer: Instruction = {
  programAddress: TOKEN,
  accounts: [
    { address: OTHER, role: AccountRole.WRITABLE },
    { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
  ],
  data: Uint8Array.from([12, 1, 2, 3]),
}
const priorityFee: Instruction = { programAddress: address('ComputeBudget111111111111111111111111111111'), data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) }
const lighthouse: Instruction = {
  programAddress: address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),
  accounts: [{ address: OTHER, role: AccountRole.READONLY }],
  data: Uint8Array.from([2, 9]),
}
const sneaky: Instruction = {
  programAddress: address('11111111111111111111111111111111'),
  accounts: [
    { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
    { address: OTHER, role: AccountRole.WRITABLE },
  ],
  data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
}

function message(instructions: Instruction[]) {
  return Uint8Array.from(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(PAYER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    ).messageBytes,
  )
}

describe('sameIntentAllowingWalletAdditions (D-28)', () => {
  const prepared = message([transfer])

  it('accepts the exact transaction', () => {
    expect(sameIntentAllowingWalletAdditions(prepared, prepared)).toEqual({ ok: true, added: [] })
  })

  it('accepts Phantom-style priority fee and Lighthouse additions', () => {
    const r = sameIntentAllowingWalletAdditions(prepared, message([priorityFee, transfer, lighthouse]))
    expect(r.ok).toBe(true)
  })

  it('refuses any other added instruction', () => {
    const r = sameIntentAllowingWalletAdditions(prepared, message([transfer, sneaky]))
    expect(r).toEqual({ ok: false, reason: 'wallet added instructions for 11111111111111111111111111111111' })
  })

  it('refuses changed instruction data', () => {
    const r = sameIntentAllowingWalletAdditions(prepared, message([{ ...transfer, data: Uint8Array.from([12, 9, 9, 9]) }]))
    expect(r.ok).toBe(false)
  })
})

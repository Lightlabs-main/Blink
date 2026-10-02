import { type Address, getCompiledTransactionMessageDecoder } from '@solana/kit'

/*
 * D-28: some wallets change a transaction before signing it. Phantom adds priority-fee (Compute Budget) and
 * "Lighthouse" assertion instructions. Neither can move the creator's tokens or change what Blink asked for:
 * Compute Budget only sets the fee the creator pays, and Lighthouse only asserts on-chain state (the transaction
 * fails if an assertion fails). Every other difference is refused, and the funded account is still verified
 * on-chain before a drop goes LIVE.
 */
export const WALLET_ADDED_PROGRAMS: ReadonlySet<string> = new Set([
  'ComputeBudget111111111111111111111111111111',
  // Lighthouse (assertion program Phantom and other wallets append for transaction guarding).
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
])

type Resolved = { program: Address; accounts: Address[]; data: string }

/** Legacy and v0 messages only (Blink builds v0; v1 is refused). */
function decode(messageBytes: Uint8Array) {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes)
  if (m.version === 1) throw new Error('unsupported transaction version')
  return m
}

function hex(data: ArrayLike<number> | undefined) {
  return data ? Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('') : ''
}

export type SameIntent = { ok: true; added: string[] } | { ok: false; reason: string }

/** True when `signed` carries exactly `prepared`'s instructions, signers and fee payer, plus only allowlisted wallet additions. */
export function sameIntentAllowingWalletAdditions(prepared: Uint8Array, signed: Uint8Array): SameIntent {
  let p, s
  try {
    p = decode(prepared)
    s = decode(signed)
  } catch {
    return { ok: false, reason: 'could not read the transaction' }
  }
  if (p.version !== s.version) return { ok: false, reason: 'transaction version changed' }
  if ('addressTableLookups' in s && s.addressTableLookups?.length) return { ok: false, reason: 'wallet added address lookup tables' }
  if (s.staticAccounts[0] !== p.staticAccounts[0]) return { ok: false, reason: 'fee payer changed' }

  type Message = ReturnType<typeof decode>
  const signers = (m: Message) => m.staticAccounts.slice(0, m.header.numSignerAccounts).slice().sort().join(',')
  if (signers(s) !== signers(p)) return { ok: false, reason: 'signers changed' }

  const resolve = (m: Message): Resolved[] =>
    m.instructions.map((ix) => ({
      program: m.staticAccounts[ix.programAddressIndex]!,
      accounts: (ix.accountIndices ?? []).map((i) => m.staticAccounts[i]!),
      data: hex(ix.data),
    }))
  const added: string[] = []
  const keep = (list: Resolved[], record: boolean) =>
    list.filter((ix) => {
      if (!WALLET_ADDED_PROGRAMS.has(ix.program)) return true
      if (record) added.push(ix.program)
      return false
    })
  const pi = keep(resolve(p), false)
  const si = keep(resolve(s), true)
  if (JSON.stringify(pi) !== JSON.stringify(si)) {
    const extra = [...new Set(si.map((ix) => ix.program).filter((prog) => !pi.some((x) => x.program === prog)))]
    return { ok: false, reason: extra.length ? `wallet added instructions for ${extra.join(', ')}` : 'instructions changed' }
  }
  return { ok: true, added }
}

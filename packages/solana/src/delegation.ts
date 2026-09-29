import { type Address, type GetAccountInfoApi, isSome, type Rpc } from '@solana/kit'
import { AccountState, fetchMaybeToken } from '@solana-program/token-2022'

export type DelegationProblem =
  | 'ACCOUNT_MISSING'
  | 'WRONG_MINT'
  | 'WRONG_OWNER'
  | 'FROZEN'
  | 'NO_DELEGATE'
  | 'WRONG_DELEGATE'
  | 'ALLOWANCE_EXCEEDS_BALANCE'
  | 'ALLOWANCE_EXHAUSTED'

export interface DelegationStatus {
  account: Address
  valid: boolean
  problems: DelegationProblem[]
  balance: bigint
  delegatedAmount: bigint
  delegate: Address | null
  /** Amount Blink may still distribute: min(delegatedAmount, balance), 0 if invalid. */
  distributable: bigint
}

/**
 * MASTER_PROMPT §9: Blink pauses a campaign if funding/delegation becomes invalid.
 * Read-only check of the campaign token account against expected mint, creator authority and delegate.
 */
export async function checkCampaignDelegation(
  rpc: Rpc<GetAccountInfoApi>,
  expected: { account: Address; mint: Address; creator: Address; delegate: Address },
): Promise<DelegationStatus> {
  const maybe = await fetchMaybeToken(rpc, expected.account, { commitment: 'confirmed' })
  if (!maybe.exists) {
    return {
      account: expected.account,
      valid: false,
      problems: ['ACCOUNT_MISSING'],
      balance: 0n,
      delegatedAmount: 0n,
      delegate: null,
      distributable: 0n,
    }
  }
  const t = maybe.data
  const delegate = isSome(t.delegate) ? t.delegate.value : null
  return evaluateDelegation(expected, {
    mint: t.mint,
    owner: t.owner,
    amount: t.amount,
    delegate,
    delegatedAmount: t.delegatedAmount,
    frozen: t.state === AccountState.Frozen,
  })
}

/** Pure evaluation, separated for unit tests. */
export function evaluateDelegation(
  expected: { account: Address; mint: Address; creator: Address; delegate: Address },
  actual: {
    mint: Address
    owner: Address
    amount: bigint
    delegate: Address | null
    delegatedAmount: bigint
    frozen: boolean
  },
): DelegationStatus {
  const problems: DelegationProblem[] = []
  if (actual.mint !== expected.mint) problems.push('WRONG_MINT')
  if (actual.owner !== expected.creator) problems.push('WRONG_OWNER')
  if (actual.frozen) problems.push('FROZEN')
  if (actual.delegate === null) problems.push('NO_DELEGATE')
  else if (actual.delegate !== expected.delegate) problems.push('WRONG_DELEGATE')
  if (actual.delegate !== null && actual.delegatedAmount === 0n) problems.push('ALLOWANCE_EXHAUSTED')
  if (actual.delegatedAmount > actual.amount) problems.push('ALLOWANCE_EXCEEDS_BALANCE')

  // Allowance above balance is a funding problem but not a security one; distributable is capped by balance.
  const blocking = problems.filter((p) => p !== 'ALLOWANCE_EXCEEDS_BALANCE')
  const valid = blocking.length === 0
  const distributable = valid ? (actual.delegatedAmount < actual.amount ? actual.delegatedAmount : actual.amount) : 0n
  return {
    account: expected.account,
    valid,
    problems,
    balance: actual.amount,
    delegatedAmount: actual.delegatedAmount,
    delegate: actual.delegate,
    distributable,
  }
}

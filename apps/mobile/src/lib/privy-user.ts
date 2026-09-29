import type { usePrivy } from '@privy-io/expo'

type PrivyUser = NonNullable<ReturnType<typeof usePrivy>['user']>

// Display-only helpers. Authorization decisions always come from the backend (/v1/me), never from these.
type Linked = { type?: string; address?: string; chain_type?: string; wallet_client?: string; connector_type?: string }

function accounts(user: PrivyUser | null): Linked[] {
  return ((user as unknown as { linked_accounts?: Linked[] } | null)?.linked_accounts ?? []) as Linked[]
}

export function userEmail(user: PrivyUser | null): string | null {
  return accounts(user).find((a) => a.type === 'email')?.address ?? null
}

export function embeddedSolanaAddress(user: PrivyUser | null): string | null {
  return (
    accounts(user).find(
      (a) => a.type === 'wallet' && a.chain_type === 'solana' && (a.wallet_client === 'privy' || a.connector_type === 'embedded'),
    )?.address ?? null
  )
}

export function externalSolanaAddresses(user: PrivyUser | null): string[] {
  return accounts(user)
    .filter((a) => a.type === 'wallet' && a.chain_type === 'solana' && a.wallet_client !== 'privy' && a.connector_type !== 'embedded')
    .map((a) => a.address)
    .filter((a): a is string => typeof a === 'string')
}

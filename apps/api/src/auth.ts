import { PrivyClient } from '@privy-io/node'

/** A request authenticated by a verified Privy access token (MASTER_PROMPT §24). */
export interface AuthContext {
  privyUserId: string
  sessionId: string
}

/**
 * Verifies Privy sessions and resolves creator wallets.
 * Creator auth (MASTER_PROMPT §25, owner correction 2): the mobile app runs Privy's SIWS flow
 * (`useLoginWithSiws` + MWA `signMessages`). Privy issues the nonce, verifies the signed payload and links the
 * wallet to the user. The backend trusts only wallets Privy reports as linked + verified for the token's user.
 */
export interface AuthVerifier {
  verifyAccessToken(token: string): Promise<AuthContext>
  /** External (non-embedded) Solana wallets Privy has verified for this user via SIWS. */
  getVerifiedExternalSolanaWallets(privyUserId: string): Promise<string[]>
  /** Privy embedded Solana wallets (where recipients receive stock). Display/holdings only — never creator auth. */
  getEmbeddedSolanaWallets(privyUserId: string): Promise<string[]>
}

export class AuthError extends Error {
  override name = 'AuthError'
}

export function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer ([A-Za-z0-9._-]+)$/)
  if (!match?.[1]) throw new AuthError('missing or malformed Authorization header')
  return match[1]
}

/**
 * VERIFIED 2026-09-29 against @privy-io/node@0.35.0 type definitions:
 *  - new PrivyClient({ appId, appSecret, jwtVerificationKey? })
 *  - privy.utils().auth().verifyAccessToken(token) → { app_id, user_id, session_id, ... }; throws if invalid
 *  - privy.users()._get(userId) → User { linked_accounts }
 *  - LinkedAccountSolana: { type: 'wallet', chain_type: 'solana', wallet_client: 'unknown', address, verified_at }
 *    LinkedAccountSolanaEmbeddedWallet has wallet_client: 'privy' (excluded — not an MWA/SIWS wallet).
 */
export class PrivyAuthVerifier implements AuthVerifier {
  private readonly privy: PrivyClient

  constructor(options: { appId: string; appSecret: string; jwtVerificationKey?: string }) {
    this.privy = new PrivyClient(options)
  }

  async verifyAccessToken(token: string): Promise<AuthContext> {
    try {
      const claims = await this.privy.utils().auth().verifyAccessToken(token)
      return { privyUserId: claims.user_id, sessionId: claims.session_id }
    } catch {
      throw new AuthError('invalid or expired Privy access token')
    }
  }

  async getVerifiedExternalSolanaWallets(privyUserId: string): Promise<string[]> {
    const user = await this.privy.users()._get(privyUserId)
    return extractVerifiedExternalSolanaWallets(user.linked_accounts)
  }

  async getEmbeddedSolanaWallets(privyUserId: string): Promise<string[]> {
    const user = await this.privy.users()._get(privyUserId)
    return extractEmbeddedSolanaWallets(user.linked_accounts)
  }
}

/** LinkedAccountSolanaEmbeddedWallet: { type: 'wallet', chain_type: 'solana', wallet_client: 'privy', connector_type: 'embedded' }. */
export function extractEmbeddedSolanaWallets(linkedAccounts: readonly unknown[]): string[] {
  const out: string[] = []
  for (const account of linkedAccounts) {
    if (!account || typeof account !== 'object') continue
    const a = account as Record<string, unknown>
    if (
      a.type === 'wallet' &&
      a.chain_type === 'solana' &&
      (a.wallet_client === 'privy' || a.connector_type === 'embedded') &&
      typeof a.address === 'string'
    ) {
      out.push(a.address)
    }
  }
  return out
}

export function extractVerifiedExternalSolanaWallets(linkedAccounts: readonly unknown[]): string[] {
  const wallets: string[] = []
  for (const account of linkedAccounts) {
    if (!account || typeof account !== 'object') continue
    const a = account as Record<string, unknown>
    if (
      a.type === 'wallet' &&
      a.chain_type === 'solana' &&
      a.wallet_client !== 'privy' &&
      a.connector_type !== 'embedded' &&
      typeof a.address === 'string' &&
      typeof a.verified_at === 'number' &&
      a.verified_at > 0
    ) {
      wallets.push(a.address)
    }
  }
  return wallets
}

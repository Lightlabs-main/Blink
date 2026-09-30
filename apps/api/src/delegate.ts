import type { PrivyClient } from '@privy-io/node'

export interface CampaignDelegate {
  /** Solana address that receives the exact Token-2022 allowance for ONE campaign (MASTER_PROMPT §14). */
  address: string
  /** Provider reference (Privy wallet id) used for server-side signing later. */
  walletRef: string
}

export interface DelegateProvider {
  createForCampaign(campaignId: string): Promise<CampaignDelegate>
}

/** Server-side signing with a managed wallet (MASTER_PROMPT §3: prefer managed signing over raw keys). */
export interface ServerWalletSigner {
  /** Adds the wallet's signature to a base64 wire transaction, keeping existing signatures. */
  signTransaction(walletRef: string, transactionBase64: string): Promise<string>
  /** Creates a Solana server wallet for a Blink-operated role (e.g. the §16 fee payer). */
  createServiceWallet(role: string): Promise<CampaignDelegate>
}

/**
 * VERIFIED on devnet by SPIKE-1 (docs/SPIKES.md): wallets().solana().signTransaction(walletId, { transaction })
 * → { signed_transaction } signs a Token-2022 TransferChecked as delegate on a transaction already signed by the
 * fee payer.
 */
export class PrivyServerWalletSigner implements ServerWalletSigner {
  constructor(private readonly privy: PrivyClient) {}

  async signTransaction(walletRef: string, transactionBase64: string): Promise<string> {
    const res = await this.privy.wallets().solana().signTransaction(walletRef, { transaction: transactionBase64 })
    return res.signed_transaction
  }

  async createServiceWallet(role: string): Promise<CampaignDelegate> {
    // The address is stored in the ServiceWallet table on first use; the idempotency key only guards the race.
    const wallet = await this.privy.wallets().create({ chain_type: 'solana', display_name: `blink-${role}`, idempotency_key: `blink-service-${role}` })
    return { address: wallet.address, walletRef: wallet.id }
  }
}

/**
 * One Privy server wallet per campaign (§14). No owner is set, so the wallet is controlled by the app's
 * credentials (backend secret). PROVISIONAL (OQ-4, recommended option A): the exact onchain allowance is the
 * primary boundary; Privy policies are defense in depth once proven for Token-2022 (§15).
 * VERIFIED 2026-09-29 against @privy-io/node@0.35.0 types: wallets().create({ chain_type, display_name?, ... },
 * idempotency_key) → Wallet { id, address }.
 */
export class PrivyDelegateProvider implements DelegateProvider {
  constructor(private readonly privy: PrivyClient) {}

  async createForCampaign(campaignId: string): Promise<CampaignDelegate> {
    const wallet = await this.privy.wallets().create({
      chain_type: 'solana',
      display_name: `blink-campaign-${campaignId}`,
      // Retries for the same campaign return the same wallet instead of creating a second delegate.
      idempotency_key: `blink-campaign-delegate-${campaignId}`,
    })
    return { address: wallet.address, walletRef: wallet.id }
  }
}

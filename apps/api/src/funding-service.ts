import {
  buildFundingTransaction,
  checkCampaignDelegation,
  type DelegationStatus,
  FundingError,
  messageLifetimeToken,
  sameIntentAllowingWalletAdditions,
} from '@blink/solana'
import {
  address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  type IsBlockhashValidApi,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetSignatureStatusesApi,
  getTransactionDecoder,
  type Rpc,
  type SendTransactionApi,
  type Signature,
  type SimulateTransactionApi,
} from '@solana/kit'

import type { Asset } from './assets.ts'
import type { CampaignRepository, StoredCampaign } from './campaign-repo.ts'
import type { DelegateProvider } from './delegate.ts'

type ServiceRpc = Rpc<
  GetAccountInfoApi &
    GetLatestBlockhashApi &
    GetMinimumBalanceForRentExemptionApi &
    SimulateTransactionApi &
    SendTransactionApi &
    GetSignatureStatusesApi &
    IsBlockhashValidApi
>

const WRONG_NETWORK_MESSAGE =
  'Your wallet signed this for a different network. Switch your wallet to Devnet (Phantom: Settings → Developer Settings → Testnet Mode → Solana Devnet), then try again.'

export interface PreparedFunding {
  transaction: string
  minContextSlot: string
  summary: { campaignAccount: string; delegate: string; amountRaw: string; rentLamports: string; accountSpace: string }
}

export interface FundingVerification {
  live: boolean
  status: DelegationStatus
}

export interface FundingService {
  prepare(campaign: StoredCampaign): Promise<PreparedFunding>
  submit(campaign: StoredCampaign, signedTransactionBase64: string): Promise<{ signature: string }>
  verify(campaign: StoredCampaign): Promise<FundingVerification>
}

export class FundingRequestError extends Error {
  override name = 'FundingRequestError'
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 422,
  ) {
    super(message)
  }
}

const PENDING_TTL_MS = 120_000
const CONFIRM_TIMEOUT_MS = 60_000

/**
 * Prepare → creator signs in their wallet (MWA) → submit → verify onchain.
 * The server only relays a transaction whose message is byte-identical to the one it built and simulated, so a
 * client cannot swap instructions, amounts, accounts or the delegate.
 */
export class SolanaFundingService implements FundingService {
  private readonly pending = new Map<string, { messageBytes: Uint8Array; expiresAt: number }>()

  constructor(
    private readonly rpc: ServiceRpc,
    private readonly assets: Asset[],
    private readonly delegates: DelegateProvider,
    private readonly campaigns: CampaignRepository,
  ) {}

  async prepare(input: StoredCampaign): Promise<PreparedFunding> {
    const asset = this.assets.find((a) => a.mint === input.mint)
    if (!asset) throw new FundingRequestError('UNSUPPORTED_MINT', 'this stock is not available on the current network')

    let campaign = input
    if (!campaign.delegateAddress) {
      const delegate = await this.delegates.createForCampaign(campaign.id)
      campaign = await this.campaigns.setDelegate(campaign.id, delegate)
    }
    if (!campaign.delegateAddress) throw new FundingRequestError('NO_DELEGATE', 'could not provision the campaign delegate', 503)

    try {
      const plan = await buildFundingTransaction(this.rpc, {
        creator: address(campaign.creatorWallet),
        campaignSeed: campaign.campaignSeed,
        storedCampaignAccount: campaign.campaignTokenAccount,
        mint: address(campaign.mint),
        expectedDecimals: asset.decimals,
        amountRaw: campaign.allowanceRaw,
        delegate: address(campaign.delegateAddress),
      })
      const { messageBytes } = getTransactionDecoder().decode(Buffer.from(plan.transaction, 'base64'))
      this.pending.set(campaign.id, { messageBytes: Uint8Array.from(messageBytes), expiresAt: Date.now() + PENDING_TTL_MS })
      return {
        transaction: plan.transaction,
        minContextSlot: plan.minContextSlot.toString(),
        summary: {
          campaignAccount: plan.campaignAccount,
          delegate: plan.delegate,
          amountRaw: plan.amountRaw.toString(),
          rentLamports: plan.rentLamports.toString(),
          accountSpace: plan.accountSpace.toString(),
        },
      }
    } catch (err) {
      if (err instanceof FundingError) {
        throw new FundingRequestError(err.code, err.message, err.code === 'ACCOUNT_ALREADY_EXISTS' ? 409 : 422)
      }
      throw err
    }
  }

  async submit(campaign: StoredCampaign, signedTransactionBase64: string): Promise<{ signature: string }> {
    const pending = this.pending.get(campaign.id)
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(campaign.id)
      throw new FundingRequestError('EXPIRED', 'this funding request expired — please try again', 409)
    }

    let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>['decode']>
    try {
      decoded = getTransactionDecoder().decode(Buffer.from(signedTransactionBase64, 'base64'))
    } catch {
      throw new FundingRequestError('INVALID_TRANSACTION', 'could not read the signed transaction', 400)
    }
    // D-28: wallets such as Phantom add priority-fee / Lighthouse instructions; anything else is refused.
    const intent = sameIntentAllowingWalletAdditions(pending.messageBytes, Uint8Array.from(decoded.messageBytes))
    if (!intent.ok) {
      throw new FundingRequestError('TRANSACTION_MISMATCH', `the signed transaction differs from the one Blink prepared (${intent.reason})`, 400)
    }
    if (!decoded.signatures[address(campaign.creatorWallet)]) {
      throw new FundingRequestError('NOT_SIGNED', 'the creator wallet did not sign', 400)
    }

    // Some wallets (Phantom) replace the blockhash with their own. It must exist on THIS cluster; allow a few
    // seconds for RPC lag, otherwise the wallet signed for another network.
    const signedBlockhash = messageLifetimeToken(Uint8Array.from(decoded.messageBytes))
    if (signedBlockhash !== messageLifetimeToken(pending.messageBytes) && !(await this.blockhashKnown(signedBlockhash))) {
      throw new FundingRequestError('WRONG_NETWORK', WRONG_NETWORK_MESSAGE, 400)
    }

    // Preflight at 'processed': a wallet's fresh blockhash may not be 'confirmed' on our RPC yet. A
    // blockhash-not-found from a lagging node is retried a few times before giving up.
    let signature: Signature | undefined
    for (let attempt = 0; !signature; attempt++) {
      try {
        signature = await this.rpc
          .sendTransaction(signedTransactionBase64 as Base64EncodedWireTransaction, {
            encoding: 'base64',
            preflightCommitment: 'processed',
          })
          .send()
      } catch (err) {
        const text = String((err as Error)?.message ?? err)
        if (text.includes('#7050008') && attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        if (text.includes('#7050008')) throw new FundingRequestError('WRONG_NETWORK', WRONG_NETWORK_MESSAGE, 400)
        // Public data only: program logs and the error cause, so failures can be diagnosed.
        const e = err as { context?: { logs?: string[] }; cause?: { message?: string; context?: unknown } }
        const logs = e.context?.logs ?? []
        console.error(JSON.stringify({ msg: 'funding send failed', campaignId: campaign.id, added: intent.added, error: text.slice(0, 300), cause: e.cause?.message, causeContext: e.cause?.context, logs: logs.slice(-12) }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))
        const hint = logs.filter((l) => /error|failed|insufficient/i.test(l)).at(-1) ?? e.cause?.message ?? ''
        throw new FundingRequestError('SEND_FAILED', `the network rejected this transaction${hint ? `: ${hint.slice(0, 160)}` : ''}`, 422)
      }
    }
    this.pending.delete(campaign.id)
    await this.waitForConfirmation(signature)
    return { signature }
  }

  async verify(campaign: StoredCampaign): Promise<FundingVerification> {
    if (!campaign.delegateAddress) throw new FundingRequestError('NO_DELEGATE', 'campaign has no delegate yet', 409)
    const status = await checkCampaignDelegation(this.rpc, {
      account: address(campaign.campaignTokenAccount),
      mint: address(campaign.mint),
      creator: address(campaign.creatorWallet),
      delegate: address(campaign.delegateAddress),
    })
    // LIVE only when the exact approved allowance is in place and fully funded (§9).
    const live = status.valid && status.delegatedAmount === campaign.allowanceRaw && status.balance >= campaign.allowanceRaw
    return { live, status }
  }

  private async blockhashKnown(blockhash: string) {
    for (let i = 0; i < 6; i++) {
      const { value } = await this.rpc.isBlockhashValid(blockhash as Blockhash, { commitment: 'processed' }).send()
      if (value) return true
      await new Promise((r) => setTimeout(r, 1500))
    }
    return false
  }

  private async waitForConfirmation(signature: Signature) {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { value } = await this.rpc.getSignatureStatuses([signature]).send()
      const s = value[0]
      if (s?.err) throw new FundingRequestError('TRANSACTION_FAILED', `transaction failed onchain: ${JSON.stringify(s.err)}`)
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new FundingRequestError('CONFIRMATION_TIMEOUT', 'the network has not confirmed the transaction yet', 504)
  }
}

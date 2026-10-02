import type { BlinkEnv } from '@blink/config'
import type { PauseReason } from '@blink/domain'
import { buildPayoutTransaction, checkCampaignDelegation, type DelegationProblem, inspectMint, mintTransferBlockers, PayoutError } from '@blink/solana'
import {
  address,
  type Base64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetBlockHeightApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  getSignatureFromTransaction,
  type GetSignatureStatusesApi,
  getTransactionDecoder,
  lamports,
  type RequestAirdropApi,
  type Rpc,
  type SendTransactionApi,
  type Signature,
  type SimulateTransactionApi,
} from '@solana/kit'

import type { Asset } from './assets.ts'
import { BudgetExceededError, type BudgetLedger } from './budget-ledger.ts'
import type { CampaignRepository, StoredCampaign } from './campaign-repo.ts'
import type { ClaimRepository, ServiceWalletStore, StoredClaim } from './claim-repo.ts'
import type { ServerWalletSigner } from './delegate.ts'
import type { Notifier } from './push.ts'

export type PayoutRpc = Rpc<
  GetAccountInfoApi &
    GetBalanceApi &
    GetBlockHeightApi &
    GetLatestBlockhashApi &
    GetMinimumBalanceForRentExemptionApi &
    GetSignatureStatusesApi &
    RequestAirdropApi &
    SendTransactionApi &
    SimulateTransactionApi
>

/** Error surfaced to the client with a stable code (claims and Tap Rush). */
export class ClaimError extends Error {
  override name = 'ClaimError'
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409,
  ) {
    super(message)
  }
}

export interface PayoutService {
  /** Pays a RESERVED claim. Returns it PAID, still SENDING (confirmation pending) or FAILED. */
  pay(campaign: StoredCampaign, claim: StoredClaim): Promise<StoredClaim>
  /** Updates a SENDING claim from the chain: PAID, FAILED once its blockhash expired unseen, or unchanged. */
  reconcile(claim: StoredClaim): Promise<StoredClaim>
  feePayerAddress(): Promise<string>
  /** §16 monitoring: the fee payer and whether its balance is below FEE_PAYER_LOW_LAMPORTS. */
  feePayerStatus(): Promise<{ address: string; balanceLamports: bigint; low: boolean }>
  /** §9: can this campaign pay at least one more reward right now? Used to resume a PAUSED drop. */
  checkReady(campaign: StoredCampaign): Promise<{ ok: true } | { ok: false; reason: PauseReason; detail: string[] }>
}

const CONFIRM_TIMEOUT_MS = 30_000
const EXPIRY_MARGIN_BLOCKS = 32n
/** Devnet only: request an airdrop when the fee payer drops below this. */
const DEVNET_FEE_PAYER_LOW_LAMPORTS = 50_000_000n
const DEVNET_AIRDROP_LAMPORTS = 1_000_000_000n

const PAUSE_FOR: Partial<Record<DelegationProblem, PauseReason>> = {
  NO_DELEGATE: 'DELEGATION_REVOKED',
  WRONG_DELEGATE: 'DELEGATE_CHANGED',
  ALLOWANCE_EXHAUSTED: 'ALLOWANCE_EXHAUSTED',
  FROZEN: 'ACCOUNT_FROZEN',
}

/**
 * Reward payouts (MASTER_PROMPT §8, §9, §16; DECISIONS D-13). Per claim:
 *   re-check the onchain delegation → build + simulate → reserve budget → fee payer signs → campaign delegate signs
 *   → record the signature (SENDING) → send → confirm (PAID) or leave SENDING for reconcile().
 * The signature is stored before sending, so no retry ever builds a second transfer for a claim that might land.
 */
export class SolanaPayoutService implements PayoutService {
  private feePayer: Promise<{ address: string; walletRef: string }> | null = null

  constructor(
    private readonly deps: {
      env: BlinkEnv
      rpc: PayoutRpc
      assets: Asset[]
      campaigns: CampaignRepository
      claims: ClaimRepository
      serviceWallets: ServiceWalletStore
      signer: ServerWalletSigner
      ledger: BudgetLedger
      log: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void }
      /** D-24: tells the recipient their reward arrived. */
      notifier?: Notifier
    },
  ) {}

  async feePayerAddress() {
    return (await this.getFeePayer()).address
  }

  async pay(campaign: StoredCampaign, claim: StoredClaim): Promise<StoredClaim> {
    const { rpc, claims } = this.deps
    if (!this.deps.env.PAYOUTS_ENABLED) {
      await claims.markFailed(claim.id, 'PAYOUTS_PAUSED')
      throw new ClaimError('PAYOUTS_PAUSED', 'Blink has paused payouts for now. Please try again later.', 503)
    }
    const asset = this.deps.assets.find((a) => a.mint === campaign.mint)
    if (!asset || !campaign.delegateAddress || !campaign.delegateWalletRef) {
      await claims.markFailed(claim.id, 'CAMPAIGN_NOT_READY')
      throw new ClaimError('CAMPAIGN_NOT_READY', 'this drop is not ready to pay out')
    }

    // §9: the creator can revoke or move stock at any time. Pause instead of attempting a doomed transfer.
    const status = await checkCampaignDelegation(rpc, {
      account: address(campaign.campaignTokenAccount),
      mint: address(campaign.mint),
      creator: address(campaign.creatorWallet),
      delegate: address(campaign.delegateAddress),
    })
    if (!status.valid || status.distributable < claim.amountRaw) {
      await claims.markFailed(claim.id, 'CAMPAIGN_NOT_DISTRIBUTABLE')
      const reason = status.problems.map((p) => PAUSE_FOR[p]).find(Boolean) ?? 'INSUFFICIENT_BALANCE'
      await this.deps.campaigns.transitionStatus(campaign.id, 'LIVE', 'PAUSED', reason)
      this.deps.log.warn({ campaignId: campaign.id, problems: status.problems }, 'campaign paused: delegation no longer covers payouts')
      throw new ClaimError('CAMPAIGN_PAUSED', 'This drop was paused because its stock is no longer available.')
    }

    const feePayer = await this.getFeePayer()
    let plan: Awaited<ReturnType<typeof buildPayoutTransaction>>
    try {
      plan = await buildPayoutTransaction(rpc, {
        campaignAccount: address(campaign.campaignTokenAccount),
        mint: address(campaign.mint),
        expectedDecimals: asset.decimals,
        delegate: address(campaign.delegateAddress),
        recipient: address(claim.recipientWallet),
        feePayer: address(feePayer.address),
        amountRaw: claim.amountRaw,
      })
    } catch (err) {
      await claims.markFailed(claim.id, err instanceof PayoutError ? err.code : 'BUILD_FAILED')
      if (err instanceof PayoutError && err.code === 'MINT_BLOCKED') {
        await this.deps.campaigns.transitionStatus(campaign.id, 'LIVE', 'PAUSED', 'MINT_STATE_CHANGED')
        throw new ClaimError('CAMPAIGN_PAUSED', 'This stock cannot be transferred right now, so the drop is paused.')
      }
      this.deps.log.warn({ err, claimId: claim.id }, 'payout build failed')
      throw new ClaimError('PAYOUT_FAILED', 'Blink could not prepare your reward. Please try again.', 502)
    }

    await this.ensureFeePayerFunded(feePayer.address, plan.estimatedLamports, claim)

    const ledgerKey = `payout:${claim.id}:${plan.lastValidBlockHeight}`
    try {
      await this.deps.ledger.reserve({ idempotencyKey: ledgerKey, kind: 'PAYOUT', lamports: plan.estimatedLamports, campaignId: campaign.id })
    } catch (err) {
      await claims.markFailed(claim.id, 'BUDGET_EXHAUSTED')
      if (err instanceof BudgetExceededError) {
        await this.deps.campaigns.transitionStatus(campaign.id, 'LIVE', 'PAUSED', 'BUDGET_EXHAUSTED')
        throw new ClaimError('CAMPAIGN_PAUSED', 'Blink has paused payouts for now. Please try again later.', 503)
      }
      throw err
    }

    let signed: string
    let signature: Signature
    try {
      const byFeePayer = await this.deps.signer.signTransaction(feePayer.walletRef, plan.transaction)
      signed = await this.deps.signer.signTransaction(campaign.delegateWalletRef, byFeePayer)
      signature = getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(signed, 'base64')))
    } catch (err) {
      await claims.markFailed(claim.id, 'SIGNING_FAILED')
      await this.deps.ledger.settle(ledgerKey, 'RELEASED')
      this.deps.log.warn({ err, claimId: claim.id }, 'payout signing failed')
      throw new ClaimError('PAYOUT_FAILED', 'Blink could not sign your reward. Please try again.', 502)
    }

    // Compare-and-set: only a claim still RESERVED may be sent. If the sweep released it while we were signing,
    // sending now could pay a claim whose pool share was already freed — abort instead.
    if (!(await claims.markSending(claim.id, signature, plan.lastValidBlockHeight))) {
      await this.deps.ledger.settle(ledgerKey, 'RELEASED')
      this.deps.log.warn({ claimId: claim.id }, 'claim was no longer reserved after signing; not sent')
      throw new ClaimError('PAYOUT_FAILED', 'Your claim timed out. Please try again.', 409)
    }
    try {
      await rpc.sendTransaction(signed as Base64EncodedWireTransaction, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
    } catch (err) {
      // The node may or may not have accepted it; reconcile() decides once the blockhash expires.
      this.deps.log.warn({ err, claimId: claim.id, signature }, 'payout send returned an error; will reconcile')
    }

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS
    let current: StoredClaim = { ...claim, status: 'SENDING', txSignature: signature, lastValidBlockHeight: plan.lastValidBlockHeight }
    while (Date.now() < deadline) {
      current = await this.reconcile(current)
      if (current.status !== 'SENDING') break
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (current.status === 'PAID') await this.endIfExhausted(campaign.id)
    return current
  }

  async feePayerStatus() {
    const { address: feePayer } = await this.getFeePayer()
    const { value } = await this.deps.rpc.getBalance(address(feePayer), { commitment: 'confirmed' }).send()
    return { address: feePayer, balanceLamports: value, low: value < this.deps.env.FEE_PAYER_LOW_LAMPORTS }
  }

  async checkReady(campaign: StoredCampaign): Promise<{ ok: true } | { ok: false; reason: PauseReason; detail: string[] }> {
    if (!campaign.delegateAddress || campaign.rewardPerClaimRaw === null) return { ok: false, reason: 'DELEGATION_REVOKED', detail: ['NO_DELEGATE'] }
    const mint = await inspectMint(this.deps.rpc, address(campaign.mint))
    const blockers = mintTransferBlockers(mint)
    if (blockers.length) return { ok: false, reason: 'MINT_STATE_CHANGED', detail: blockers }
    const status = await checkCampaignDelegation(this.deps.rpc, {
      account: address(campaign.campaignTokenAccount),
      mint: address(campaign.mint),
      creator: address(campaign.creatorWallet),
      delegate: address(campaign.delegateAddress),
    })
    if (!status.valid || status.distributable < campaign.rewardPerClaimRaw) {
      const reason = status.problems.map((p) => PAUSE_FOR[p]).find(Boolean) ?? 'INSUFFICIENT_BALANCE'
      return { ok: false, reason, detail: status.problems }
    }
    return { ok: true }
  }

  async reconcile(claim: StoredClaim): Promise<StoredClaim> {
    if (claim.status !== 'SENDING' || !claim.txSignature || claim.lastValidBlockHeight === null) return claim
    const { rpc, claims, ledger } = this.deps
    const ledgerKey = `payout:${claim.id}:${claim.lastValidBlockHeight}`
    const signature = claim.txSignature as Signature
    const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()
    const s = value[0]
    if (s?.err) {
      await claims.markFailed(claim.id, `TRANSACTION_FAILED ${JSON.stringify(s.err, bigintReplacer)}`)
      await ledger.settle(ledgerKey, 'SPENT', signature)
      return { ...claim, status: 'FAILED', failureReason: 'TRANSACTION_FAILED', txSignature: null }
    }
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      const paid = await claims.markPaid(claim.id)
      await ledger.settle(ledgerKey, 'SPENT', signature)
      this.deps.log.info({ claimId: claim.id, signature }, 'payout confirmed')
      // Only the first confirmation notifies (markPaid is compare-and-set).
      if (paid) void this.notifyPaid(paid)
      return paid ?? { ...claim, status: 'PAID' }
    }
    if (!s) {
      const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send()
      // Margin for a lagging RPC node before declaring that the transaction can never land.
      if (height > claim.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
        // Not found and its blockhash can no longer be used: it will never land. Safe to release and retry.
        await claims.markFailed(claim.id, 'EXPIRED')
        await ledger.settle(ledgerKey, 'RELEASED')
        return { ...claim, status: 'FAILED', failureReason: 'EXPIRED', txSignature: null }
      }
    }
    return claim
  }

  private async notifyPaid(claim: StoredClaim) {
    if (!this.deps.notifier) return
    const campaign = await this.deps.campaigns.findById(claim.campaignId).catch(() => null)
    const symbol = campaign?.xstockSymbol ?? 'stock'
    await this.deps.notifier.notify(
      claim.privyUserId,
      claim.kind === 'REFERRAL_BONUS'
        ? { title: 'Invite bonus received', body: `A friend claimed through your link. Your ${symbol} bonus is in your stock wallet.`, url: '/home' }
        : { title: 'Your stock arrived', body: `Your ${symbol} reward is in your stock wallet.`, url: '/home' },
    )
  }

  private async endIfExhausted(campaignId: string) {
    const c = await this.deps.campaigns.findById(campaignId)
    if (c?.status === 'LIVE' && c.rewardPerClaimRaw !== null && c.allowanceRaw - c.claimedRaw < c.rewardPerClaimRaw) {
      await this.deps.campaigns.transitionStatus(c.id, 'LIVE', 'ENDED')
    }
  }

  private getFeePayer() {
    // One separate low-balance fee payer per cluster (§16), created once and stored.
    this.feePayer ??= (async () => {
      const role = `fee-payer-${this.deps.env.SOLANA_CLUSTER}`
      const stored = await this.deps.serviceWallets.get(role)
      if (stored) return stored
      const created = await this.deps.signer.createServiceWallet(role)
      const kept = await this.deps.serviceWallets.putIfAbsent(role, created)
      this.deps.log.info({ role, address: kept.address }, 'fee payer wallet created')
      return kept
    })().catch((err: unknown) => {
      this.feePayer = null
      throw err
    })
    return this.feePayer
  }

  private async ensureFeePayerFunded(feePayer: string, needed: bigint, claim: StoredClaim) {
    const { rpc, env } = this.deps
    let { value: balance } = await rpc.getBalance(address(feePayer), { commitment: 'confirmed' }).send()
    if (env.SOLANA_CLUSTER === 'devnet' && balance < DEVNET_FEE_PAYER_LOW_LAMPORTS) {
      try {
        await rpc.requestAirdrop(address(feePayer), lamports(DEVNET_AIRDROP_LAMPORTS)).send()
        this.deps.log.info({ feePayer }, 'requested devnet airdrop for the fee payer')
      } catch (err) {
        this.deps.log.warn({ err, feePayer }, 'devnet airdrop failed; fund the fee payer at faucet.solana.com')
      }
    }
    if (balance < needed) {
      // An airdrop may still be landing; one short re-check before giving up.
      await new Promise((r) => setTimeout(r, 3000))
      balance = (await rpc.getBalance(address(feePayer), { commitment: 'confirmed' }).send()).value
    }
    if (balance < needed) {
      await this.deps.claims.markFailed(claim.id, 'FEE_PAYER_EMPTY')
      this.deps.log.warn({ feePayer, balance: balance.toString(), needed: needed.toString() }, 'fee payer cannot cover the payout')
      throw new ClaimError('PAYOUTS_UNAVAILABLE', 'Blink’s network-fee wallet needs topping up. Please try again soon.', 503)
    }
  }
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

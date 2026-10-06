import type { BlinkEnv } from '@blink/config'
import { buildSendTransaction, SendError, type SendAsset } from '@blink/solana'
import {
  address,
  type Base64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetSignatureStatusesApi,
  getSignatureFromTransaction,
  type GetTokenAccountsByOwnerApi,
  getTransactionDecoder,
  type Rpc,
  type SendTransactionApi,
  type Signature,
  type SimulateTransactionApi,
} from '@solana/kit'
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

import type { Asset } from './assets.ts'
import type { AuthVerifier } from './auth.ts'
import { type BudgetLedger, BudgetExceededError } from './budget-ledger.ts'
import { ClaimError } from './payout-service.ts'
import type { ServiceWalletStore } from './claim-repo.ts'
import type { ServerWalletSigner } from './delegate.ts'
import type { EligibilityService } from './eligibility.ts'
import type { TransferStore } from './history.ts'

type SendRpc = Rpc<
  GetAccountInfoApi &
    GetBalanceApi &
    GetLatestBlockhashApi &
    GetMinimumBalanceForRentExemptionApi &
    SimulateTransactionApi &
    SendTransactionApi &
    GetSignatureStatusesApi &
    GetTokenAccountsByOwnerApi
>

const PENDING_TTL_MS = 60_000
const CONFIRM_TIMEOUT_MS = 30_000

export interface WalletBalances {
  wallet: string
  solLamports: string
  assets: { mint: string; symbol: string; decimals: number; logo: string | null; isTest: boolean; raw: string }[]
}

/**
 * D-32: Send from the user's Blink stock wallet (the Privy embedded wallet). Blink's fee payer pays the network
 * fee and any recipient token-account rent; the user's wallet signs only its own transfer, in the app. The server
 * accepts back exactly the transaction it prepared for that user, adds the fee-payer signature and sends it.
 */
export class SendService {
  private readonly pending = new Map<
    string,
    {
      messageBytes: Uint8Array
      expiresAt: number
      from: string
      estimatedLamports: bigint
      lastValidBlockHeight: bigint
      record: { asset: string; symbol: string; decimals: number; amountRaw: bigint; toAddress: string }
    }
  >()

  constructor(
    private readonly deps: {
      env: BlinkEnv
      rpc: SendRpc
      assets: Asset[]
      auth: AuthVerifier
      signer: ServerWalletSigner
      serviceWallets: ServiceWalletStore
      ledger: BudgetLedger
      /** D-38: records each send for the user's history and receipts. */
      transfers?: TransferStore
      eligibility?: EligibilityService
      log?: { warn: (o: object, msg: string) => void }
    },
  ) {}

  private async stockWallet(privyUserId: string) {
    const [wallet] = await this.deps.auth.getEmbeddedSolanaWallets(privyUserId)
    if (!wallet) throw new ClaimError('NO_STOCK_WALLET', 'your Blink stock wallet is still being created — try again in a moment', 409)
    return wallet
  }

  async balances(privyUserId: string): Promise<WalletBalances> {
    const wallet = await this.stockWallet(privyUserId)
    const [{ value: sol }, { value: accounts }] = await Promise.all([
      this.deps.rpc.getBalance(address(wallet), { commitment: 'confirmed' }).send(),
      this.deps.rpc.getTokenAccountsByOwner(address(wallet), { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send(),
    ])
    const totals = new Map<string, bigint>()
    for (const { account } of accounts) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info
      if (info?.mint && info.tokenAmount?.amount && /^\d+$/.test(info.tokenAmount.amount)) {
        totals.set(info.mint, (totals.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount))
      }
    }
    return {
      wallet,
      solLamports: sol.toString(),
      assets: this.deps.assets.map((a) => ({ mint: a.mint, symbol: a.symbol, decimals: a.decimals, logo: a.logo, isTest: a.isTest, raw: (totals.get(a.mint) ?? 0n).toString() })),
    }
  }

  async prepare(privyUserId: string, ip: string, input: { asset: string; to: string; amountRaw: bigint }) {
    if (!this.deps.env.PAYOUTS_ENABLED) throw new ClaimError('PAYOUTS_PAUSED', 'Sending is paused for now. Please try again later.', 503)
    const from = await this.stockWallet(privyUserId)
    let asset: SendAsset
    let label = { symbol: 'SOL', decimals: 9 }
    if (input.asset === 'SOL') {
      asset = { kind: 'SOL' }
    } else {
      const known = this.deps.assets.find((a) => a.mint === input.asset)
      if (!known) throw new ClaimError('UNSUPPORTED_ASSET', 'this stock can’t be sent from Blink', 400)
      // D-20: moving xStocks through Blink follows the same eligibility gate as receiving them.
      if (!known.isTest) await this.deps.eligibility?.requireEligible(privyUserId, ip)
      asset = { kind: 'TOKEN', mint: address(known.mint), decimals: known.decimals }
      label = { symbol: known.symbol, decimals: known.decimals }
    }
    const feePayer = await this.deps.serviceWallets.get(`fee-payer-${this.deps.env.SOLANA_CLUSTER}`)
    if (!feePayer) throw new ClaimError('SEND_UNAVAILABLE', 'sending is not available yet', 503)

    let plan
    try {
      plan = await buildSendTransaction(this.deps.rpc, { from: address(from), to: address(input.to), feePayer: address(feePayer.address), asset, amountRaw: input.amountRaw })
    } catch (err) {
      if (err instanceof SendError) {
        if (err.code === 'SIMULATION_FAILED') this.deps.log?.warn({ logs: err.logs.slice(-8) }, 'send simulation failed')
        throw new ClaimError(`SEND_${err.code}`, err.message, err.code === 'SIMULATION_FAILED' ? 422 : err.code === 'ASSET_UPDATING' ? 503 : 400)
      }
      throw err
    }
    const { messageBytes } = getTransactionDecoder().decode(Buffer.from(plan.transaction, 'base64'))
    this.pending.set(privyUserId, {
      messageBytes: Uint8Array.from(messageBytes),
      expiresAt: Date.now() + PENDING_TTL_MS,
      from,
      estimatedLamports: plan.estimatedLamports,
      lastValidBlockHeight: plan.lastValidBlockHeight,
      record: { asset: input.asset, ...label, amountRaw: input.amountRaw, toAddress: input.to },
    })
    return { transaction: plan.transaction, from, createsRecipientAccount: plan.createsRecipientAccount }
  }

  async submit(privyUserId: string, signedTransactionBase64: string): Promise<{ signature: string; confirmed: boolean }> {
    const pending = this.pending.get(privyUserId)
    this.pending.delete(privyUserId)
    if (!pending || pending.expiresAt < Date.now()) throw new ClaimError('EXPIRED', 'this transfer expired — please try again', 409)

    let decoded
    try {
      decoded = getTransactionDecoder().decode(Buffer.from(signedTransactionBase64, 'base64'))
    } catch {
      throw new ClaimError('INVALID_TRANSACTION', 'could not read the signed transfer', 400)
    }
    const same = decoded.messageBytes.length === pending.messageBytes.length && decoded.messageBytes.every((b, i) => b === pending.messageBytes[i])
    if (!same) throw new ClaimError('TRANSACTION_MISMATCH', 'the signed transfer differs from the one Blink prepared', 400)
    if (!decoded.signatures[address(pending.from)]) throw new ClaimError('NOT_SIGNED', 'your stock wallet did not sign', 400)

    const feePayer = await this.deps.serviceWallets.get(`fee-payer-${this.deps.env.SOLANA_CLUSTER}`)
    if (!feePayer) throw new ClaimError('SEND_UNAVAILABLE', 'sending is not available yet', 503)
    const { value: balance } = await this.deps.rpc.getBalance(address(feePayer.address), { commitment: 'confirmed' }).send()
    if (balance < pending.estimatedLamports) throw new ClaimError('SEND_UNAVAILABLE', 'Blink’s network-fee wallet needs topping up. Please try again soon.', 503)

    const ledgerKey = `send:${privyUserId}:${pending.lastValidBlockHeight}`
    try {
      await this.deps.ledger.reserve({ idempotencyKey: ledgerKey, kind: 'SEND', lamports: pending.estimatedLamports })
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new ClaimError('PAYOUTS_PAUSED', 'Sending is paused for now. Please try again later.', 503)
      throw err
    }

    let signed: string
    let signature: Signature
    try {
      signed = await this.deps.signer.signTransaction(feePayer.walletRef, signedTransactionBase64)
      signature = getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(signed, 'base64')))
      await this.deps.rpc.sendTransaction(signed as Base64EncodedWireTransaction, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
    } catch (err) {
      await this.deps.ledger.settle(ledgerKey, 'RELEASED')
      this.deps.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'send failed')
      throw new ClaimError('SEND_FAILED', 'the network did not accept this transfer — please try again', 422)
    }

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS
    while (Date.now() < deadline) {
      const { value } = await this.deps.rpc.getSignatureStatuses([signature]).send()
      const s = value[0]
      if (s?.err) {
        await this.deps.ledger.settle(ledgerKey, 'SPENT', signature)
        await this.remember(privyUserId, pending.record, signature, 'FAILED')
        throw new ClaimError('SEND_FAILED', 'the transfer failed on the network', 422)
      }
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        await this.deps.ledger.settle(ledgerKey, 'SPENT', signature)
        await this.remember(privyUserId, pending.record, signature, 'CONFIRMED')
        return { signature, confirmed: true }
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    // Still pending: report the signature; the explorer link shows the final state.
    await this.remember(privyUserId, pending.record, signature, 'PENDING')
    return { signature, confirmed: false }
  }

  /** History is best-effort: a failed write never turns a completed transfer into an error. */
  private async remember(privyUserId: string, r: { asset: string; symbol: string; decimals: number; amountRaw: bigint; toAddress: string }, signature: string, status: 'CONFIRMED' | 'PENDING' | 'FAILED') {
    try {
      await this.deps.transfers?.record({ privyUserId, cluster: this.deps.env.SOLANA_CLUSTER, ...r, signature, status })
    } catch (err) {
      this.deps.log?.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not record transfer')
    }
  }
}

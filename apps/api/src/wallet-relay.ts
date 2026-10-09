import { messageLifetimeToken, sameIntentAllowingWalletAdditions } from '@blink/solana'
import {
  address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  getBase58Decoder,
  type GetSignatureStatusesApi,
  type GetTransactionApi,
  getTransactionDecoder,
  type IsBlockhashValidApi,
  type Rpc,
  type SendTransactionApi,
  type Signature,
} from '@solana/kit'

import { ClaimError } from './payout-service.ts'

type RelayRpc = Rpc<SendTransactionApi & GetSignatureStatusesApi & IsBlockhashValidApi & GetTransactionApi>

const PENDING_TTL_MS = 120_000
const CONFIRM_TIMEOUT_MS = 60_000
const EXPIRED_MESSAGE = 'This approval took too long and expired on the network (Solana transactions last about a minute). Please try again and approve straight away.'
const WRONG_NETWORK_MESSAGE = 'Your wallet signed this for a different network. Make sure your wallet is on Solana Mainnet, then try again.'

/**
 * Relays user-signed transactions for SKR tips, SKR boosts and ORE deploys (D-49/D-50/D-51), with the same rules
 * as the funding relay (funding-service.ts): only a transaction whose message is byte-identical to the one Blink
 * built (wallet-added priority-fee / guard instructions allowed, D-28) and signed by the expected wallet is sent;
 * success is only ever reported after the network confirms it. Blink never signs these transactions.
 */
export class WalletTxRelay {
  private readonly pending = new Map<string, { messageBytes: Uint8Array; signer: string; expiresAt: number }>()

  constructor(private readonly rpc: RelayRpc) {}

  /** Remembers the transaction Blink prepared under `key` (e.g. `tip:<id>`), for `signer` to sign. */
  remember(key: string, transactionBase64: string, signer: string) {
    const { messageBytes } = getTransactionDecoder().decode(Buffer.from(transactionBase64, 'base64'))
    this.pending.set(key, { messageBytes: Uint8Array.from(messageBytes), signer, expiresAt: Date.now() + PENDING_TTL_MS })
  }

  forget(key: string) {
    this.pending.delete(key)
  }

  /** The signature a signed transaction will land under (first signature = fee payer), without sending it. */
  static signatureOf(signedTransactionBase64: string): string | null {
    try {
      const decoded = getTransactionDecoder().decode(Buffer.from(signedTransactionBase64, 'base64'))
      const first = Object.values(decoded.signatures)[0]
      return first ? getBase58Decoder().decode(first) : null
    } catch {
      return null
    }
  }

  /** Sends exactly the prepared transaction and waits for 'confirmed'. Throws ClaimError on any refusal or failure. */
  async relay(key: string, signedTransactionBase64: string): Promise<Signature> {
    const pending = this.pending.get(key)
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(key)
      throw new ClaimError('EXPIRED', 'this request expired — please try again', 409)
    }
    let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>['decode']>
    try {
      decoded = getTransactionDecoder().decode(Buffer.from(signedTransactionBase64, 'base64'))
    } catch {
      throw new ClaimError('INVALID_TRANSACTION', 'could not read the signed transaction', 400)
    }
    const intent = sameIntentAllowingWalletAdditions(pending.messageBytes, Uint8Array.from(decoded.messageBytes))
    if (!intent.ok) throw new ClaimError('TRANSACTION_MISMATCH', `the signed transaction differs from the one Blink prepared (${intent.reason})`, 400)
    if (!decoded.signatures[address(pending.signer)]) throw new ClaimError('NOT_SIGNED', 'your wallet did not sign', 400)

    const signedBlockhash = messageLifetimeToken(Uint8Array.from(decoded.messageBytes))
    const walletReplacedBlockhash = signedBlockhash !== messageLifetimeToken(pending.messageBytes)
    if (walletReplacedBlockhash && !(await this.blockhashKnown(signedBlockhash))) throw new ClaimError('WRONG_NETWORK', WRONG_NETWORK_MESSAGE, 400)

    let signature: Signature | undefined
    for (let attempt = 0; !signature; attempt++) {
      try {
        signature = await this.rpc.sendTransaction(signedTransactionBase64 as Base64EncodedWireTransaction, { encoding: 'base64', preflightCommitment: 'processed' }).send()
      } catch (err) {
        const text = String((err as Error)?.message ?? err)
        const e = err as { context?: { logs?: string[] }; cause?: { message?: string; context?: { __code?: number } } }
        if (e.cause?.context?.__code === 7050008 || text.includes('#7050008')) {
          if (!walletReplacedBlockhash) {
            this.pending.delete(key)
            throw new ClaimError('EXPIRED', EXPIRED_MESSAGE, 409)
          }
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 2000))
            continue
          }
          throw new ClaimError('WRONG_NETWORK', WRONG_NETWORK_MESSAGE, 400)
        }
        const logs = e.context?.logs ?? []
        console.error(JSON.stringify({ msg: 'wallet relay send failed', key, error: text.slice(0, 300), cause: e.cause?.message, logs: logs.slice(-12) }))
        throw new ClaimError('SEND_FAILED', friendlyFailure(logs, e.cause?.message), 422)
      }
    }
    this.pending.delete(key)
    await this.waitForConfirmation(signature)
    return signature
  }

  /** The confirmed transaction (json, any version), retried briefly because RPC nodes can lag the status. */
  async confirmedTransaction(signature: string): Promise<unknown> {
    for (let i = 0; i < 8; i++) {
      const tx = await this.rpc
        // Mainnet carries version-1 transactions; kit 8.4 types only know 0, the RPC accepts 1 (same json fields).
        .getTransaction(signature as Signature, { encoding: 'json', maxSupportedTransactionVersion: 1 as unknown as 0, commitment: 'confirmed' })
        .send()
      if (tx) return tx
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new ClaimError('CONFIRMATION_TIMEOUT', 'the network has not confirmed the transaction yet', 504)
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
      if (s?.err) throw new ClaimError('TRANSACTION_FAILED', 'the transaction failed onchain — nothing was taken except the network fee', 422)
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return
      await new Promise((r) => setTimeout(r, 1500))
    }
    throw new ClaimError('CONFIRMATION_TIMEOUT', 'the network has not confirmed the transaction yet', 504)
  }
}

/** Consumer wording for a rejected send; raw program logs stay in the server log. */
function friendlyFailure(logs: string[], cause?: string): string {
  const all = `${logs.join(' ')} ${cause ?? ''}`
  if (/insufficient (funds|lamports)/i.test(all)) return 'your wallet doesn’t have enough SOL or SKR for this'
  if (/Miner has not checkpointed/i.test(all)) return 'your last ORE round isn’t settled yet — try again in a moment'
  if (/AccountNotFound|could not find account/i.test(all)) return 'your wallet has no SOL on Solana Mainnet yet'
  return 'the network rejected this transaction'
}

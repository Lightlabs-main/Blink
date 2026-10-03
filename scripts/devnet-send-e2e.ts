/**
 * DEVNET ONLY — end-to-end test for Send from the Blink stock wallet (D-32), using the production SendService:
 *  1. A throwaway "stock wallet" (stands in for the Privy embedded wallet) holds test stock and NO SOL.
 *  2. It sends test stock to a brand-new wallet: Blink's fee payer (a Privy server wallet) pays the fee and the
 *     recipient's token-account rent; the stock wallet signs only the message bytes (as Privy's provider does).
 *  3. A tampered transaction is refused, and a send of more than the balance is refused before signing.
 *
 * Requires .secrets/devnet-authority.key, .secrets/devnet-test-mint.json and PRIVY_APP_ID / PRIVY_APP_SECRET.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { loadEnv } from '@blink/config'
import { PrivyClient } from '@privy-io/node'
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  type SignatureBytes,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import type { AuthVerifier } from '../apps/api/src/auth.ts'
import { InMemoryBudgetLedger } from '../apps/api/src/budget-ledger.ts'
import { InMemoryCampaignRepository } from '../apps/api/src/campaign-repo.ts'
import { InMemoryClaimRepository } from '../apps/api/src/claim-repo.ts'
import { PrivyServerWalletSigner } from '../apps/api/src/delegate.ts'
import { ClaimError } from '../apps/api/src/payout-service.ts'
import { SendService } from '../apps/api/src/send-service.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}
const RPC_URL = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (!/devnet/.test(RPC_URL)) throw new Error('Refusing: devnet only.')
const rpc = createSolanaRpc(RPC_URL)
const DECIMALS = 8
const HELD = 5_00000000n
const SEND = 1_25000000n

const log = (msg: string, data?: unknown) => console.log('✔', msg, data === undefined ? '' : JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))

async function authorityTx(authority: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(authority.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await partiallySignTransaction([authority.keyPair], compileTransaction(message))
  const wire = getBase64EncodedWireTransaction(signed)
  const sig = await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send()
    if (value[0]?.err) throw new Error(`tx failed ${JSON.stringify(value[0].err)}`)
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return sig
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('tx not confirmed')
}

/** Signs only the message bytes, exactly like Privy's embedded-wallet provider, and attaches the signature. */
async function signLikePrivy(wallet: KeyPairSigner, base64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
  const signature = (await signBytes(wallet.keyPair.privateKey, tx.messageBytes)) as SignatureBytes
  const signed = { ...tx, signatures: { ...tx.signatures, [wallet.address]: signature } }
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64')
}

async function main() {
  const env = loadEnv({ ...process.env, SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: RPC_URL, MAINNET_ENABLED: 'false', MAINNET_GO_APPROVED: 'false', XSTOCK_COMPLIANCE: 'off' })
  const authority = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(readFileSync('.secrets/devnet-authority.key', 'utf8').trim(), 'hex')))
  const mint = address((JSON.parse(readFileSync('.secrets/devnet-test-mint.json', 'utf8')) as { mint: string }).mint)
  const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! })
  const signer = new PrivyServerWalletSigner(privy)

  // The stock wallet: test stock, zero SOL (like a fresh Blink user).
  const stock = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
  const recipient = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
  const [stockAta] = await findAssociatedTokenPda({ owner: stock.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  log('stock wallet seeded with test stock (no SOL)', await authorityTx(authority, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(authority.address), ata: stockAta, owner: stock.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToCheckedInstruction({ mint, token: stockAta, mintAuthority: createNoopSigner(authority.address), amount: HELD, decimals: DECIMALS }),
  ]))

  const claims = new InMemoryClaimRepository(new InMemoryCampaignRepository())
  const feePayer = await claims.putIfAbsent('fee-payer-devnet', await signer.createServiceWallet(`fee-payer-devnet-send-e2e-${randomUUID()}`))
  log('fee payer (Privy server wallet) funded', await authorityTx(authority, [
    getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: address(feePayer.address), amount: 30_000_000n }),
  ]))

  const auth: AuthVerifier = {
    verifyAccessToken: async () => ({ privyUserId: 'did:privy:send-e2e', sessionId: 's' }),
    getVerifiedExternalSolanaWallets: async () => [],
    getEmbeddedSolanaWallets: async () => [stock.address],
  }
  const send = new SendService({
    env,
    rpc,
    assets: [{ symbol: 'tNVDAx', name: 'Test NVIDIA', mint, decimals: DECIMALS, logo: null, isTest: true }],
    auth,
    signer,
    serviceWallets: claims,
    ledger: new InMemoryBudgetLedger(env),
    log: { warn: (o, m) => console.warn('!', m, JSON.stringify(o)) },
  })
  const user = 'did:privy:send-e2e'

  const before = await send.balances(user)
  if (before.assets[0]?.raw !== HELD.toString() || before.solLamports !== '0') throw new Error(`unexpected balances ${JSON.stringify(before)}`)
  log('balances read', { tNVDAx: before.assets[0].raw, sol: before.solLamports })

  try {
    await send.prepare(user, '127.0.0.1', { asset: mint, to: recipient.address, amountRaw: HELD + 1n })
    throw new Error('over-balance send was prepared')
  } catch (err) {
    if (!(err instanceof ClaimError) || err.code !== 'SEND_INSUFFICIENT_BALANCE') throw err
    log('sending more than the balance refused before signing', { code: err.code })
  }

  const tampered = await send.prepare(user, '127.0.0.1', { asset: mint, to: recipient.address, amountRaw: SEND })
  const bytes = getBase64Encoder().encode(tampered.transaction)
  const flipped = Uint8Array.from(bytes)
  flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1
  try {
    await send.submit(user, await signLikePrivy(stock, Buffer.from(flipped).toString('base64')))
    throw new Error('tampered transfer accepted')
  } catch (err) {
    if (!(err instanceof ClaimError) || !['TRANSACTION_MISMATCH', 'INVALID_TRANSACTION'].includes(err.code)) throw err
    log('tampered transfer refused', { code: err.code })
  }

  const prepared = await send.prepare(user, '127.0.0.1', { asset: mint, to: recipient.address, amountRaw: SEND })
  if (!prepared.createsRecipientAccount) throw new Error('expected the recipient account to be created')
  const { signature } = await send.submit(user, await signLikePrivy(stock, prepared.transaction))
  const [recipientAta] = await findAssociatedTokenPda({ owner: recipient.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const got = await fetchMaybeToken(rpc, recipientAta, { commitment: 'confirmed' })
  if (!got.exists || got.data.amount !== SEND) throw new Error('recipient did not receive the stock')
  const after = await send.balances(user)
  if (after.assets[0]?.raw !== (HELD - SEND).toString() || after.solLamports !== '0') throw new Error(`unexpected balances after ${JSON.stringify(after)}`)
  log('sent 1.25 tNVDAx to a new wallet; Blink paid the fee and account rent; sender still has 0 SOL', { signature })

  console.log('\nSend devnet end-to-end test: PASSED')
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('✘', err)
    process.exit(1)
  },
)

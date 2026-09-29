/**
 * DEVNET ONLY — SPIKE-1 live test (MASTER_PROMPT §14/§15, docs/SPIKES.md).
 *
 * Proves, with real devnet transactions:
 *  1. Blink's funding builder produces a transaction that creates the seed-derived campaign account, funds it and
 *     approves an exact allowance to a per-campaign Privy server wallet (creator = throwaway devnet keypair).
 *  2. checkCampaignDelegation sees the exact allowance onchain.
 *  3. The Privy server wallet can sign a Token-2022 TransferChecked as DELEGATE (fee paid by the separate
 *     devnet authority key, never by the delegate — §16).
 *  4. A transfer above the remaining allowance is rejected onchain.
 *
 * Requires: .secrets/devnet-authority.key and .secrets/devnet-test-mint.json (scripts/devnet-test-mint.ts init),
 * PRIVY_APP_ID / PRIVY_APP_SECRET in .env. Prints only public data.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

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
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
  type TransactionSigner,
  partiallySignTransaction,
  type Base64EncodedWireTransaction,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import {
  buildFundingTransaction,
  campaignSeedFromUuid,
  checkCampaignDelegation,
  deriveCampaignTokenAccount,
} from '../packages/solana/src/index.ts'

const RPC_URL = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (!/devnet/.test(RPC_URL)) {
  console.error('Refusing: devnet only.')
  process.exit(1)
}
try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}

const rpc = createSolanaRpc(RPC_URL)
const DECIMALS = 8
const FUND_RAW = 1_000_000n // 0.01 test shares
const PAYOUT_RAW = 250_000n // 0.0025 test shares

function log(step: string, detail: unknown = '') {
  console.log(`✔ ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

async function sendWire(wire: string): Promise<string> {
  const sig = await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send()
    const s = value[0]
    if (s?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(s.err)}`)
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`tx ${sig} not confirmed in time`)
}

async function buildWire(feePayer: TransactionSigner['address'], instructions: Instruction[]): Promise<Transaction> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  return compileTransaction(message)
}

async function main() {
  const authority = await createKeyPairSignerFromPrivateKeyBytes(
    Uint8Array.from(Buffer.from(readFileSync('.secrets/devnet-authority.key', 'utf8').trim(), 'hex')),
  )
  const { mint: mintStr } = JSON.parse(readFileSync('.secrets/devnet-test-mint.json', 'utf8')) as { mint: string }
  const mint = address(mintStr)
  const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! })

  // Throwaway creator + recipient for this run only (never persisted).
  const creator = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
  const recipient = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
  log('throwaway creator', creator.address)

  // Seed the creator with devnet SOL + test stock (authority pays).
  const [creatorAta] = await findAssociatedTokenPda({ owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const seedTx = await buildWire(authority.address, [
    getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: creator.address, amount: 20_000_000n }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(authority.address), ata: creatorAta, owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToCheckedInstruction({ mint, token: creatorAta, mintAuthority: createNoopSigner(authority.address), amount: FUND_RAW, decimals: DECIMALS }),
  ])
  log('seeded creator', await sendWire(getBase64EncodedWireTransaction(await partiallySignTransaction([authority.keyPair], seedTx))))

  // 1. Per-campaign Privy delegate.
  const campaignId = randomUUID()
  const wallet = await privy.wallets().create({ chain_type: 'solana', display_name: `blink-spike-${campaignId}`, idempotency_key: `blink-spike-${campaignId}` })
  const delegate = address(wallet.address)
  log('privy server wallet created (delegate)', { id: wallet.id, address: delegate })

  // 2. Funding transaction from the production builder, signed by the creator.
  const seed = campaignSeedFromUuid(campaignId)
  const account = await deriveCampaignTokenAccount({ creator: creator.address, campaignSeed: seed })
  const plan = await buildFundingTransaction(rpc, {
    creator: creator.address,
    campaignSeed: seed,
    storedCampaignAccount: account,
    mint,
    expectedDecimals: DECIMALS,
    amountRaw: FUND_RAW,
    delegate,
  })
  log('funding tx built + simulated', { account, rentLamports: plan.rentLamports, space: plan.accountSpace })
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(plan.transaction))
  const fundSig = await sendWire(getBase64EncodedWireTransaction(await partiallySignTransaction([creator.keyPair], unsigned)))
  log('funding confirmed', fundSig)

  const status = await checkCampaignDelegation(rpc, { account, mint, creator: creator.address, delegate })
  if (!status.valid || status.delegatedAmount !== FUND_RAW) throw new Error(`delegation not as expected: ${JSON.stringify(status.problems)}`)
  log('onchain exact allowance verified', { balance: status.balance, delegatedAmount: status.delegatedAmount })

  // 3. Delegate payout signed by Privy; authority is the separate fee payer (§16).
  const [recipientAta] = await findAssociatedTokenPda({ owner: recipient.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const payout = (amount: bigint) =>
    buildWire(authority.address, [
      getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(authority.address), ata: recipientAta, owner: recipient.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      getTransferCheckedInstruction({ source: account, mint, destination: recipientAta, authority: createNoopSigner(delegate), amount, decimals: DECIMALS }),
    ])

  async function signWithPrivyAndSend(tx: Transaction) {
    const feePaid = await partiallySignTransaction([authority.keyPair], tx)
    const res = await privy.wallets().solana().signTransaction(wallet.id, { transaction: getBase64EncodedWireTransaction(feePaid) })
    return sendWire(res.signed_transaction)
  }

  log('privy-signed delegated TransferChecked confirmed', await signWithPrivyAndSend(await payout(PAYOUT_RAW)))
  const after = await checkCampaignDelegation(rpc, { account, mint, creator: creator.address, delegate })
  log('allowance decreased', { balance: after.balance, delegatedAmount: after.delegatedAmount })

  // 4. Over-allowance transfer must fail onchain.
  try {
    await signWithPrivyAndSend(await payout(after.delegatedAmount + 1n))
    throw new Error('UNEXPECTED: over-allowance transfer succeeded')
  } catch (e) {
    if ((e as Error).message.startsWith('UNEXPECTED')) throw e
    log('over-allowance transfer rejected', (e as Error).message.slice(0, 160))
  }
  console.log('\nSPIKE-1 devnet live test: PASSED')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('SPIKE-1 devnet live test FAILED:', (e as Error).message)
    process.exit(1)
  },
)

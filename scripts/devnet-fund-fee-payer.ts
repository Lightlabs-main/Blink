/**
 * DEVNET ONLY — tops up the API's payout fee payer (§16) from the devnet authority key when the public faucet is
 * unavailable. Usage: npx tsx scripts/devnet-fund-fee-payer.ts <fee-payer-address> [lamports=200000000]
 * The address is logged by blink-api at startup ("payout fee payer ready"). Prints only public data.
 */
import { readFileSync } from 'node:fs'

import {
  address,
  appendTransactionMessageInstructions,
  type Base64EncodedWireTransaction,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'

const RPC_URL = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (!/devnet/.test(RPC_URL)) {
  console.error('Refusing: devnet only.')
  process.exit(1)
}
const [target, amountArg] = process.argv.slice(2)
if (!target) {
  console.error('Usage: npx tsx scripts/devnet-fund-fee-payer.ts <fee-payer-address> [lamports]')
  process.exit(1)
}
const amount = BigInt(amountArg ?? '200000000')
// A fee payer holds minimal SOL (§16); refuse accidental large transfers.
if (amount <= 0n || amount > 1_000_000_000n) {
  console.error('Amount must be between 1 lamport and 1 SOL.')
  process.exit(1)
}

const rpc = createSolanaRpc(RPC_URL)
const authority = await createKeyPairSignerFromPrivateKeyBytes(
  Uint8Array.from(Buffer.from(readFileSync('.secrets/devnet-authority.key', 'utf8').trim(), 'hex')),
)
const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
const tx = compileTransaction(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(authority.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: address(target), amount })], m),
  ),
)
const signature = await rpc
  .sendTransaction(getBase64EncodedWireTransaction(await partiallySignTransaction([authority.keyPair], tx)) as Base64EncodedWireTransaction, {
    encoding: 'base64',
    preflightCommitment: 'confirmed',
  })
  .send()
for (let i = 0; i < 40; i++) {
  const { value } = await rpc.getSignatureStatuses([signature]).send()
  if (value[0]?.err) throw new Error(`transfer failed: ${JSON.stringify(value[0].err)}`)
  if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') break
  await new Promise((r) => setTimeout(r, 1500))
}
const { value: balance } = await rpc.getBalance(address(target), { commitment: 'confirmed' }).send()
console.log(`✔ sent ${amount} lamports to ${target} (${signature}); balance now ${balance}`)

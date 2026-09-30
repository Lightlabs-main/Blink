/**
 * DEVNET ONLY — end-to-end payout test for claims (DECISIONS D-13), using the production services:
 *  1. A throwaway creator funds a campaign (production funding builder) with an exact allowance to a new
 *     per-campaign Privy delegate (§14).
 *  2. Two recipients claim through ClaimRepository.reserve + SolanaPayoutService.pay: a Privy server wallet pays
 *     fees and the recipient account rent (§8, §16), the Privy delegate signs the TransferChecked.
 *  3. Recipient balances, the remaining onchain allowance and the pool accounting are checked; a third claim that
 *     does not fit the pool is refused before anything is signed.
 *
 * Requires .secrets/devnet-authority.key, .secrets/devnet-test-mint.json and PRIVY_APP_ID / PRIVY_APP_SECRET in .env.
 * Prints only public data. The fee payer is a Privy server wallet created for this run only.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { loadEnv } from '@blink/config'
import { buildFundingTransaction, campaignSeedFromUuid, checkCampaignDelegation, deriveCampaignTokenAccount } from '@blink/solana'
import { PrivyClient } from '@privy-io/node'
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
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import { InMemoryBudgetLedger } from '../apps/api/src/budget-ledger.ts'
import { InMemoryCampaignRepository } from '../apps/api/src/campaign-repo.ts'
import { InMemoryClaimRepository } from '../apps/api/src/claim-repo.ts'
import { PrivyDelegateProvider, PrivyServerWalletSigner } from '../apps/api/src/delegate.ts'
import { SolanaPayoutService } from '../apps/api/src/payout-service.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // rely on process env
}
const RPC_URL = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (!/devnet/.test(RPC_URL)) {
  console.error('Refusing: devnet only.')
  process.exit(1)
}

const rpc = createSolanaRpc(RPC_URL)
const DECIMALS = 8
const POOL_RAW = 250_000n
const REWARD_RAW = 100_000n

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

async function authorityTx(authority: Awaited<ReturnType<typeof createKeyPairSignerFromPrivateKeyBytes>>, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(authority.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  )
  return sendWire(getBase64EncodedWireTransaction(await partiallySignTransaction([authority.keyPair], tx)))
}

async function main() {
  const env = loadEnv({ ...process.env, SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: RPC_URL, MAINNET_ENABLED: 'false', MAINNET_GO_APPROVED: 'false' })
  const authority = await createKeyPairSignerFromPrivateKeyBytes(
    Uint8Array.from(Buffer.from(readFileSync('.secrets/devnet-authority.key', 'utf8').trim(), 'hex')),
  )
  const { mint: mintStr } = JSON.parse(readFileSync('.secrets/devnet-test-mint.json', 'utf8')) as { mint: string }
  const mint = address(mintStr)
  const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! })
  const signer = new PrivyServerWalletSigner(privy)

  // Throwaway creator with devnet SOL + test stock.
  const creator = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
  const [creatorAta] = await findAssociatedTokenPda({ owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  log('seeded creator', await authorityTx(authority, [
    getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: creator.address, amount: 20_000_000n }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(authority.address), ata: creatorAta, owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToCheckedInstruction({ mint, token: creatorAta, mintAuthority: createNoopSigner(authority.address), amount: POOL_RAW, decimals: DECIMALS }),
  ]))

  // Campaign stored exactly as the API would store it.
  const campaigns = new InMemoryCampaignRepository()
  const claims = new InMemoryClaimRepository(campaigns)
  const id = randomUUID()
  const campaignSeed = campaignSeedFromUuid(id)
  const campaignTokenAccount = await deriveCampaignTokenAccount({ creator: creator.address, campaignSeed })
  await campaigns.create({
    id,
    type: 'GIFT',
    cluster: 'devnet',
    creatorPrivyUserId: 'did:privy:e2e-creator',
    creatorWallet: creator.address,
    mint,
    xstockSymbol: 'tNVDAx',
    campaignSeed,
    campaignTokenAccount,
    allowanceRaw: POOL_RAW,
    rewardPerClaimRaw: REWARD_RAW,
    tapRush: null,
  })
  const delegate = await new PrivyDelegateProvider(privy).createForCampaign(id)
  await campaigns.setDelegate(id, delegate)
  log('campaign + per-campaign Privy delegate', { id, campaignTokenAccount, delegate: delegate.address })

  const plan = await buildFundingTransaction(rpc, {
    creator: creator.address,
    campaignSeed,
    storedCampaignAccount: campaignTokenAccount,
    mint,
    expectedDecimals: DECIMALS,
    amountRaw: POOL_RAW,
    delegate: address(delegate.address),
  })
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(plan.transaction))
  log('funding confirmed', await sendWire(getBase64EncodedWireTransaction(await partiallySignTransaction([creator.keyPair], unsigned))))
  await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
  await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
  await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')

  const payouts = new SolanaPayoutService({
    env,
    rpc,
    assets: [{ symbol: 'tNVDAx', name: 'Test NVIDIA', mint, decimals: DECIMALS, logo: null, isTest: true }],
    campaigns,
    claims,
    serviceWallets: claims,
    signer,
    ledger: new InMemoryBudgetLedger(env),
    log: { info: (o, m) => log(m, o), warn: (o, m) => console.warn('!', m, JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) },
  })
  // A fee payer for this run only (never the API's), funded from the devnet authority (no airdrop dependency).
  await claims.putIfAbsent('fee-payer-devnet', await signer.createServiceWallet(`fee-payer-devnet-e2e-${id}`))
  const feePayer = address(await payouts.feePayerAddress())
  log('fee payer (Privy server wallet) funded', await authorityTx(authority, [
    getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: feePayer, amount: 60_000_000n }),
  ]))

  for (const who of ['recipient-1', 'recipient-2']) {
    const recipient = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
    const reserved = await claims.reserve({ campaignId: id, privyUserId: `did:privy:${who}`, recipientWallet: recipient.address, amountRaw: REWARD_RAW, tapSessionId: null })
    if (!reserved.ok) throw new Error(`reserve failed: ${reserved.reason}`)
    const campaign = (await campaigns.findById(id))!
    const paid = await payouts.pay(campaign, reserved.claim)
    if (paid.status !== 'PAID') throw new Error(`${who} payout ended ${paid.status} (${paid.failureReason ?? ''})`)
    const [ata] = await findAssociatedTokenPda({ owner: recipient.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
    const account = await fetchMaybeToken(rpc, ata, { commitment: 'confirmed' })
    if (!account.exists || account.data.amount !== REWARD_RAW) throw new Error(`${who} balance is not ${REWARD_RAW}`)
    log(`${who} paid ${REWARD_RAW} raw (recipient account created by the fee payer)`, { recipient: recipient.address, signature: paid.txSignature })
  }

  const status = await checkCampaignDelegation(rpc, { account: campaignTokenAccount, mint, creator: creator.address, delegate: address(delegate.address) })
  if (status.delegatedAmount !== POOL_RAW - 2n * REWARD_RAW) throw new Error(`allowance left ${status.delegatedAmount}, expected ${POOL_RAW - 2n * REWARD_RAW}`)
  log('onchain allowance decreased exactly', { delegatedAmount: status.delegatedAmount, balance: status.balance })

  const third = await claims.reserve({ campaignId: id, privyUserId: 'did:privy:recipient-3', recipientWallet: authority.address, amountRaw: REWARD_RAW, tapSessionId: null })
  if (third.ok || third.reason !== 'EXHAUSTED') throw new Error('third claim should not fit the pool')
  const final = (await campaigns.findById(id))!
  log('third claim refused before signing (pool used up)', { claimedRaw: final.claimedRaw, status: final.status })

  console.log('\nClaims devnet end-to-end test: PASSED')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('Claims devnet end-to-end test FAILED:', (e as Error).message)
    process.exit(1)
  },
)

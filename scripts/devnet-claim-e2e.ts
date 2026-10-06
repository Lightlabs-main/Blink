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
import { campaignSeedFromUuid, checkCampaignDelegation, deriveCampaignTokenAccount } from '@blink/solana'
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
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
  pipe,
  prependTransactionMessageInstructions,
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
import { FundingRequestError, SolanaFundingService } from '../apps/api/src/funding-service.ts'
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

  // Funding through the API's own service (prepare -> wallet signs -> submit -> verify), signed the way Phantom
  // signs: it prepends Compute Budget (priority fee) instructions (D-28). Any other change must be refused.
  const assets = [{ symbol: 'tNVDAx', name: 'Test NVIDIA', mint, decimals: DECIMALS, logo: null, isTest: true }]
  const funding = new SolanaFundingService(rpc, assets, new PrivyDelegateProvider(privy), campaigns)
  const sneaky = await walletSigned(creator, (await funding.prepare((await campaigns.findById(id))!)).transaction, [
    getTransferSolInstruction({ source: createNoopSigner(creator.address), destination: authority.address, amount: 1_000n }),
  ])
  try {
    await funding.submit((await campaigns.findById(id))!, sneaky)
    throw new Error('a transaction with an extra transfer was accepted')
  } catch (err) {
    if (!(err instanceof FundingRequestError) || err.code !== 'TRANSACTION_MISMATCH') throw err
    log('wallet-modified funding with an extra transfer refused', { code: err.code })
  }
  const prepared = await funding.prepare((await campaigns.findById(id))!)
  const phantomStyle = await walletSigned(creator, prepared.transaction, [
    { programAddress: address('ComputeBudget111111111111111111111111111111'), data: Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]) },
    { programAddress: address('ComputeBudget111111111111111111111111111111'), data: Uint8Array.from([3, 0x10, 0x27, 0, 0, 0, 0, 0, 0]) },
  ])
  const { signature: fundingSignature } = await funding.submit((await campaigns.findById(id))!, phantomStyle)
  const verified = await funding.verify((await campaigns.findById(id))!)
  if (!verified.live) throw new Error(`funding not verified onchain: ${JSON.stringify(verified.status.problems)}`)
  log('funding (Phantom-style priority fee) accepted, confirmed and verified onchain', fundingSignature)
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
  const final = (await campaigns.findById(id))!
  // The payout that left less than one reward in the pool ends the drop, so a third claim finds it closed.
  if (third.ok || third.reason !== 'NOT_LIVE' || final.status !== 'ENDED') throw new Error('third claim should be refused by an ENDED drop')
  log('drop ENDED when the pool could not fit another reward; third claim refused before signing', { claimedRaw: final.claimedRaw, status: final.status })

  // W-1 creator wind-down: revoke the delegate, return the unused stock, close the account, rent back to the creator.
  const [creatorAta] = await findAssociatedTokenPda({ owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const ataBefore = (await fetchMaybeToken(rpc, creatorAta, { commitment: 'confirmed' }))
  const heldBefore = ataBefore.exists ? ataBefore.data.amount : 0n
  const solBefore = (await rpc.getBalance(creator.address, { commitment: 'confirmed' }).send()).value
  const closePrep = await funding.prepareClose(final)
  const leftRaw = POOL_RAW - 2n * REWARD_RAW
  if (closePrep.summary.returnRaw !== leftRaw.toString() || !closePrep.summary.revokesDelegate) throw new Error(`close plan ${JSON.stringify(closePrep.summary)}`)
  const sneakyClose = await walletSigned(creator, closePrep.transaction, [
    getTransferSolInstruction({ source: createNoopSigner(creator.address), destination: authority.address, amount: 1_000n }),
  ])
  try {
    await funding.submitClose(final, sneakyClose)
    throw new Error('a close transaction with an extra transfer was accepted')
  } catch (err) {
    if (!(err instanceof FundingRequestError) || err.code !== 'TRANSACTION_MISMATCH') throw err
    log('wallet-modified close refused', { code: err.code })
  }
  const closeAgain = await funding.prepareClose(final)
  const closed = await funding.submitClose(final, await walletSigned(creator, closeAgain.transaction, []))
  if (!closed.closed) throw new Error('campaign account still exists after close')
  const ataAfter = await fetchMaybeToken(rpc, creatorAta, { commitment: 'confirmed' })
  const heldAfter = ataAfter.exists ? ataAfter.data.amount : 0n
  if (heldAfter - heldBefore !== leftRaw) throw new Error(`creator got ${heldAfter - heldBefore} raw back, expected ${leftRaw}`)
  const solAfter = (await rpc.getBalance(creator.address, { commitment: 'confirmed' }).send()).value
  const refund = BigInt(closeAgain.summary.rentLamports)
  if (!(solAfter > solBefore) || solAfter - solBefore > refund) throw new Error(`rent refund ${solAfter - solBefore} lamports, expected about ${refund} minus fees`)
  const gone = await rpc.getAccountInfo(campaignTokenAccount, { encoding: 'base64', commitment: 'confirmed' }).send()
  if (gone.value !== null) throw new Error('campaign account still exists')
  log('creator closed the drop: delegate revoked, unused stock returned, account closed, rent refunded', {
    signature: closed.signature, returnedRaw: leftRaw, rentRefundLamports: (solAfter - solBefore).toString(),
  })

  console.log('\nClaims devnet end-to-end test: PASSED')
}

/** Signs `base64` as a wallet would after prepending `extra` instructions (same blockhash and fee payer). */
async function walletSigned(signer: KeyPairSigner, base64: string, extra: Instruction[]) {
  const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(messageBytes))
  const changed = compileTransaction(prependTransactionMessageInstructions(extra, message))
  return getBase64EncodedWireTransaction(await partiallySignTransaction([signer.keyPair], changed))
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('Claims devnet end-to-end test FAILED:', (e as Error).message)
    process.exit(1)
  },
)

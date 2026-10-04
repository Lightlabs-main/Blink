/**
 * DEVNET ONLY — creates a real, funded, LIVE test drop in the server's database so testers can try the participant
 * side (claim, Tap Rush, notifications, Send) without funding one themselves. The creator is a throwaway keypair
 * funded with test stock from the devnet authority; funding goes through the API's own SolanaFundingService.
 *
 *   npx tsx scripts/devnet-seed-drop.ts [TAP_RUSH|GIFT|EARLY_CLAIM] [shares] [perPerson]
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { loadEnv } from '@blink/config'
import { campaignSeedFromUuid, deriveCampaignTokenAccount } from '@blink/solana'
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
  type KeyPairSigner,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getMintToCheckedInstruction, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022'

import { PrivyDelegateProvider } from '../apps/api/src/delegate.ts'
import { SolanaFundingService } from '../apps/api/src/funding-service.ts'
import { createPrismaClient, PrismaCampaignRepository } from '../apps/api/src/prisma-campaign-repo.ts'

process.loadEnvFile('.env')
const env = loadEnv()
if (env.SOLANA_CLUSTER !== 'devnet' || !env.DATABASE_URL) throw new Error('Refusing: devnet server with a database only.')
const rpc = createSolanaRpc(env.SOLANA_RPC_URL)
const DECIMALS = 8
const type = (process.argv[2] ?? 'TAP_RUSH') as 'TAP_RUSH' | 'GIFT' | 'EARLY_CLAIM'
const shares = BigInt(process.argv[3] ?? '10')
const per = BigInt(process.argv[4] ?? '1')
const SCALE = 10n ** BigInt(DECIMALS)

async function send(payer: KeyPairSigner, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const wire = getBase64EncodedWireTransaction(await partiallySignTransaction([payer.keyPair], compileTransaction(message)))
  const sig = await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send()
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send()
    if (value[0]?.err) throw new Error(`tx failed ${JSON.stringify(value[0].err)}`)
    if (value[0]?.confirmationStatus === 'confirmed' || value[0]?.confirmationStatus === 'finalized') return sig
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('not confirmed')
}

const authority = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(Buffer.from(readFileSync('.secrets/devnet-authority.key', 'utf8').trim(), 'hex')))
const mint = address((JSON.parse(readFileSync('.secrets/devnet-test-mint.json', 'utf8')) as { mint: string }).mint)
const creator = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(randomBytes(32)))
const [creatorAta] = await findAssociatedTokenPda({ owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
await send(authority, [
  getTransferSolInstruction({ source: createNoopSigner(authority.address), destination: creator.address, amount: 20_000_000n }),
  getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(authority.address), ata: creatorAta, owner: creator.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
  getMintToCheckedInstruction({ mint, token: creatorAta, mintAuthority: createNoopSigner(authority.address), amount: shares * SCALE, decimals: DECIMALS }),
])

const prisma = createPrismaClient(env.DATABASE_URL)
const campaigns = new PrismaCampaignRepository(prisma)
const id = randomUUID()
const campaignSeed = campaignSeedFromUuid(id)
await campaigns.create({
  id,
  type,
  cluster: 'devnet',
  creatorPrivyUserId: 'did:privy:blink-test-creator',
  creatorWallet: creator.address,
  mint,
  xstockSymbol: 'tNVDAx',
  campaignSeed,
  campaignTokenAccount: await deriveCampaignTokenAccount({ creator: creator.address, campaignSeed }),
  allowanceRaw: shares * SCALE,
  rewardPerClaimRaw: per * SCALE,
  tapRush: type === 'TAP_RUSH' ? { goal: 30, seconds: 10 } : null,
})
await campaigns.transitionStatus(id, 'DRAFT', 'AWAITING_FUNDING')
const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! })
const funding = new SolanaFundingService(rpc, [{ symbol: 'tNVDAx', name: 'Test NVIDIA', mint, decimals: DECIMALS, logo: null, isTest: true }], new PrivyDelegateProvider(privy), campaigns)
const prepared = await funding.prepare((await campaigns.findById(id))!)
const signed = await partiallySignTransaction([creator.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction)))
await funding.submit((await campaigns.findById(id))!, getBase64EncodedWireTransaction(signed))
const { live } = await funding.verify((await campaigns.findById(id))!)
if (!live) throw new Error('funding not verified')
await campaigns.transitionStatus(id, 'AWAITING_FUNDING', 'AWAITING_DELEGATION')
await campaigns.transitionStatus(id, 'AWAITING_DELEGATION', 'LIVE')
console.log(`LIVE ${type} drop: ${shares} tNVDAx, ${per} per person → https://blinksol.site/c/${id}`)
await prisma.$disconnect()
process.exit(0)

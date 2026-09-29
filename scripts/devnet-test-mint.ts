/**
 * DEVNET ONLY. Creates a Token-2022 test mint that mirrors the reviewed xStock extension set, and funds test
 * wallets with devnet SOL + test stock. Real xStocks exist only on mainnet; this lets the funding/delegation flow
 * be exercised with zero real value at stake.
 *
 * Usage (on the VPS, from the repo root):
 *   npx tsx scripts/devnet-test-mint.ts init
 *   npx tsx scripts/devnet-test-mint.ts fund <walletAddress> <shares>
 *
 * The throwaway devnet authority key lives in .secrets/ (git-ignored, mode 600). It controls nothing of value
 * and must never be used on mainnet. The script refuses to run against any non-devnet RPC.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import {
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  type Instruction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit'
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system'
import {
  AccountState,
  type ExtensionArgs,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getPreInitializeInstructionsForMintExtensions,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022'

import { uiSharesToRawFloor } from '../packages/xstocks/src/index.ts'

const RPC_URL = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
const WS_URL = RPC_URL.replace(/^http/, 'ws')
const SECRETS = '.secrets'
const KEY_FILE = `${SECRETS}/devnet-authority.key`
const MINT_FILE = `${SECRETS}/devnet-test-mint.json`
const DECIMALS = 8
/** "None" for OptionalNonZeroPubkey fields (all-zero pubkey), as observed on real xStocks' TransferHook. */
const ZERO_PUBKEY = address('11111111111111111111111111111111')

if (!/devnet/.test(RPC_URL)) {
  console.error(`Refusing: ${RPC_URL} is not a devnet RPC. This script is devnet-only.`)
  process.exit(1)
}

const rpc = createSolanaRpc(RPC_URL)
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL)
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })

async function loadAuthority(): Promise<TransactionSigner> {
  if (!existsSync(SECRETS)) mkdirSync(SECRETS, { mode: 0o700 })
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
    console.log('Generated a new throwaway devnet authority key (.secrets/, git-ignored).')
  }
  chmodSync(KEY_FILE, 0o600)
  const bytes = Uint8Array.from(Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex'))
  return createKeyPairSignerFromPrivateKeyBytes(bytes)
}

async function send(payer: TransactionSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' })
  return getSignatureFromTransaction(signed)
}

async function ensureSol(target: TransactionSigner['address'], min: bigint) {
  const { value } = await rpc.getBalance(target, { commitment: 'confirmed' }).send()
  if (value >= min) return value
  console.log(`Requesting devnet airdrop for ${target}…`)
  await airdropFactory({ rpc, rpcSubscriptions })({
    recipientAddress: target,
    lamports: lamports(1_000_000_000n),
    commitment: 'confirmed',
  })
  return (await rpc.getBalance(target, { commitment: 'confirmed' }).send()).value
}

async function init() {
  if (existsSync(MINT_FILE)) {
    console.log(`Test mint already exists: ${JSON.parse(readFileSync(MINT_FILE, 'utf8')).mint}`)
    return
  }
  const authority = await loadAuthority()
  console.log(`Authority: ${authority.address}`)
  console.log(`Balance: ${await ensureSol(authority.address, 500_000_000n)} lamports`)

  const mint = await generateKeyPairSigner()
  // Mirrors the xStock extensions that affect transfers and token-account size (docs/DEPENDENCIES.md).
  const extensions: ExtensionArgs[] = [
    { __kind: 'PermanentDelegate', delegate: authority.address },
    { __kind: 'DefaultAccountState', state: AccountState.Initialized },
    {
      __kind: 'ScaledUiAmountConfig',
      authority: authority.address,
      multiplier: 1,
      newMultiplierEffectiveTimestamp: 0n,
      newMultiplier: 1,
    },
    { __kind: 'PausableConfig', authority: authority.address, paused: false },
    { __kind: 'TransferHook', authority: authority.address, programId: ZERO_PUBKEY },
  ]
  const space = BigInt(getMintSize(extensions))
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send()

  const signature = await send(authority, [
    getCreateAccountInstruction({
      payer: authority,
      newAccount: mint,
      lamports: rent,
      space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    ...getPreInitializeInstructionsForMintExtensions(mint.address, extensions),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: DECIMALS,
      mintAuthority: authority.address,
      freezeAuthority: authority.address,
    }),
  ])
  writeFileSync(MINT_FILE, JSON.stringify({ mint: mint.address, symbol: 'tNVDAx', decimals: DECIMALS, signature }, null, 2), { mode: 0o600 })
  console.log(`Created devnet test mint ${mint.address}`)
  console.log(`Signature: ${signature}`)
}

async function fund(wallet: string, shares: string) {
  if (!existsSync(MINT_FILE)) throw new Error('Run `init` first')
  const { mint } = JSON.parse(readFileSync(MINT_FILE, 'utf8')) as { mint: string }
  const authority = await loadAuthority()
  const owner = address(wallet)
  const mintAddress = address(mint)
  const amount = uiSharesToRawFloor(shares, DECIMALS, 1)

  const { value: walletSol } = await rpc.getBalance(owner, { commitment: 'confirmed' }).send()
  const topUp = walletSol < 100_000_000n ? 200_000_000n : 0n
  await ensureSol(authority.address, topUp + 50_000_000n)

  const [ata] = await findAssociatedTokenPda({ owner, mint: mintAddress, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })
  const instructions: Instruction[] = []
  if (topUp > 0n) instructions.push(getTransferSolInstruction({ source: authority, destination: owner, amount: topUp }))
  instructions.push(
    getCreateAssociatedTokenIdempotentInstruction({
      payer: authority,
      ata,
      owner,
      mint: mintAddress,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getMintToCheckedInstruction({ mint: mintAddress, token: ata, mintAuthority: authority, amount, decimals: DECIMALS }),
  )
  const signature = await send(authority, instructions)
  console.log(`Funded ${wallet}: ${shares} test shares (${amount} raw) into ${ata}${topUp ? ' + 0.2 devnet SOL' : ''}`)
  console.log(`Signature: ${signature}`)
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (cmd === 'init') await init()
  else if (cmd === 'fund' && args[0] && args[1]) await fund(args[0], args[1])
  else {
    console.error('Usage: tsx scripts/devnet-test-mint.ts init | fund <wallet> <shares>')
    process.exit(1)
  }
  process.exit(0)
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

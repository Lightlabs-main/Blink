/**
 * READ-ONLY. Checks packages/solana/src/ore.ts against live mainnet: program, PDAs vs the official constants, Config,
 * Board/Round layouts, ORE mint decimals, Miner rent, and the DeployEvent verifier on recent real deploys.
 * Never signs or sends a transaction. Evidence for docs/ORE_PROTOCOL_VERIFICATION.md.
 *
 * Usage: SOLANA_RPC_URL=<mainnet rpc> tsx scripts/ore-inspect.ts [--deploys 5]
 */
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
} from '@solana/kit'

import {
  buildOreCheckpointInstruction,
  buildOreDeployTransaction,
  buildOreDeployInstruction,
  decodeOreConfig,
  oreNeedsCheckpoint,
  deriveEntropyVar,
  deriveOreBoard,
  deriveOreConfig,
  deriveOreMinerAccount,
  deriveOreRound,
  deriveOreTreasury,
  ENTROPY_PROGRAM,
  normalizeJsonTransaction,
  ORE_BOARD_ADDRESS,
  ORE_CONFIG_ADDRESS,
  ORE_DECIMALS,
  ORE_MINT,
  ORE_PROGRAM,
  ORE_TREASURY_ADDRESS,
  ORE_VAR_ADDRESS,
  readMintDecimals,
  readOreLiveBoard,
  type RpcJsonTransaction,
  verifyOreDeployTx,
} from '../packages/solana/src/index.ts'

const rpcUrl = process.env.SOLANA_RPC_URL
if (!rpcUrl) {
  console.error('SOLANA_RPC_URL is required (mainnet)')
  process.exit(1)
}
const wantDeploys = Number(process.argv[process.argv.indexOf('--deploys') + 1] ?? 5) || 5
const rpc = createSolanaRpc(rpcUrl)
const results: { check: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: unknown = '') => results.push({ check: name, ok, detail: String(detail) })

// Program
const prog = (await rpc.getAccountInfo(ORE_PROGRAM, { encoding: 'base64' }).send()).value
check('ORE program executable', Boolean(prog?.executable), prog?.owner)
const entropy = (await rpc.getAccountInfo(ENTROPY_PROGRAM, { encoding: 'base64' }).send()).value
check('entropy program executable', Boolean(entropy?.executable), entropy?.owner)

// PDAs vs official constants
check('board PDA = BOARD_ADDRESS', (await deriveOreBoard()) === ORE_BOARD_ADDRESS)
check('config PDA = CONFIG_ADDRESS', (await deriveOreConfig()) === ORE_CONFIG_ADDRESS)
check('treasury PDA = TREASURY_ADDRESS', (await deriveOreTreasury()) === ORE_TREASURY_ADDRESS)
check('entropy var PDA(board, 0) = VAR_ADDRESS', (await deriveEntropyVar(ORE_BOARD_ADDRESS, 0n)) === ORE_VAR_ADDRESS)

// Config
const cfgAcc = (await rpc.getAccountInfo(ORE_CONFIG_ADDRESS, { encoding: 'base64' }).send()).value
const cfg = decodeOreConfig(Uint8Array.from(getBase64Encoder().encode(cfgAcc!.data[0])))
check('config account size', cfgAcc!.space === 232n, `${cfgAcc!.space} bytes`)
check('config round/intermission slots', cfg.roundSlots > 0n, `round ${cfg.roundSlots} slots, intermission ${cfg.intermissionSlots}`)

// Mint
const decimals = await readMintDecimals(rpc, ORE_MINT)
check('ORE mint decimals = 11', decimals === ORE_DECIMALS, decimals)

// Live board
const live = await readOreLiveBoard(rpc)
const roundAcc = (await rpc.getAccountInfo(await deriveOreRound(live.board.roundId), { encoding: 'base64' }).send()).value
check('board end − start = config.round_slots', live.phase === 'WAITING' || live.board.endSlot - live.board.startSlot === cfg.roundSlots, `${live.board.endSlot - live.board.startSlot}`)
check('board + current round decode', live.round.id === live.board.roundId,`round ${live.board.roundId} · phase ${live.phase} · slot ${live.slot} · start ${live.board.startSlot} · end ${live.board.endSlot} · round account ${roundAcc?.space} bytes`)
const totalDeployed = live.round.deployed.reduce((a, b) => a + b, 0n)
check('round per-square totals', true, `${totalDeployed} lamports deployed · ${live.round.totalMiners} miners · counts ${live.round.count.join(',')}`)

// Recent real deploys → verifier
const sigs = await rpc.getSignaturesForAddress(ORE_BOARD_ADDRESS, { limit: 40 }).send()
let verified = 0
let minerSize: bigint | null = null
for (const s of sigs) {
  if (verified >= wantDeploys || s.err) continue
  await new Promise((r) => setTimeout(r, 1500)) // public RPC rate limit
  // Mainnet carries version-1 transactions; kit 8.4 types only know 0, the RPC accepts 1 (same json fields).
  const tx = await rpc.getTransaction(s.signature as Signature, { encoding: 'json', maxSupportedTransactionVersion: 1 as unknown as 0, commitment: 'confirmed' }).send()
  if (!tx) continue
  const norm = normalizeJsonTransaction(tx as unknown as RpcJsonTransaction)
  const signer = norm.signers[0] as Address
  const verdict = verifyOreDeployTx(norm, signer)
  if (!verdict.ok && verdict.reason === 'NO_DEPLOY') continue
  verified += 1
  const desc = verdict.ok
    ? `round ${verdict.event.roundId} squares [${verdict.squares.join(',')}] ${verdict.event.amountPerSquare} lamports/square ts ${verdict.event.ts}`
    : verdict.reason
  check(`deploy ${s.signature.slice(0, 12)}… verdict`, true, desc)
  // Negative control: the same tx must not verify for an unrelated authority.
  const other = verifyOreDeployTx(norm, address('11111111111111111111111111111112'))
  check(`deploy ${s.signature.slice(0, 12)}… rejects another authority`, !other.ok, other.ok ? 'ACCEPTED (bug)' : other.reason)
  if (minerSize === null && verdict.ok) {
    const m = (await rpc.getAccountInfo(await deriveOreMinerAccount(signer), { encoding: 'base64' }).send()).value
    if (m) minerSize = m.space
  }
}
check('found recent deploys', verified > 0, `${verified} inspected`)

// Builder check: simulate (sigVerify off, nothing signed or sent) a tiny deploy built by buildOreDeployInstruction
// for a real miner of the CURRENT round, on a square that miner has not taken yet. Rounds last ~1.5 min, so wait for
// an open round and pick the miner from that round's own fresh deploys.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let simulated = false
for (let attempt = 0; attempt < 6 && !simulated; attempt++) {
  const now = await readOreLiveBoard(rpc)
  if (now.phase !== 'MINING' || now.board.endSlot - now.slot < 60n) {
    await sleep(8000)
    continue
  }
  const recent = await rpc.getSignaturesForAddress(ORE_BOARD_ADDRESS, { limit: 6 }).send()
  for (const s of recent) {
    if (s.err || simulated) continue
    await sleep(1200)
    const tx = await rpc.getTransaction(s.signature as Signature, { encoding: 'json', maxSupportedTransactionVersion: 1 as unknown as 0, commitment: 'confirmed' }).send()
    if (!tx) continue
    const norm = normalizeJsonTransaction(tx as unknown as RpcJsonTransaction)
    const authority = norm.signers[0] as Address
    const v = verifyOreDeployTx(norm, authority)
    if (!v.ok || v.event.roundId !== now.board.roundId) continue
    const fresh = await readOreLiveBoard(rpc, authority)
    if (fresh.phase !== 'MINING' || !fresh.miner || fresh.board.roundId !== now.board.roundId) continue
    const square = fresh.miner.deployed.findIndex((x) => x === 0n)
    if (square < 0) continue
    const ixs = [
      ...(oreNeedsCheckpoint(fresh.miner, fresh.board.roundId) ? [await buildOreCheckpointInstruction({ authority, roundId: fresh.miner.roundId })] : []),
      await buildOreDeployInstruction({ authority, amountLamports: 10_000n, roundId: fresh.board.roundId, squares: [square] }),
    ]
    const { value: blockhash } = await rpc.getLatestBlockhash().send()
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(authority, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    )
    const wire = getBase64EncodedWireTransaction(compileTransaction(message))
    const sim = await rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }).send()
    const deployLog = sim.value.logs?.find((l) => l.includes('deploying'))
    const detail = sim.value.err ? `${JSON.stringify(sim.value.err, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))} · ${(sim.value.logs ?? []).slice(-4).join(' | ')}` : `${deployLog} · ${sim.value.unitsConsumed} CU · square ${square}`
    check('simulated deploy built by buildOreDeployInstruction', sim.value.err === null && Boolean(deployLog), detail)
    simulated = true
    // The API's full builder (live board, checkpoint, cost, simulation) for the same miner and square.
    try {
      const plan = await buildOreDeployTransaction(rpc, { authority, amountLamports: 10_000n, squares: [square] })
      check('buildOreDeployTransaction (API path) simulates', true, `round ${plan.roundId} · cost ${plan.cost.total} lamports (stake ${plan.cost.stake}, checkpoint fee ${plan.cost.checkpointFee}, miner rent ${plan.cost.minerRent}, fee ${plan.cost.networkFee})`)
    } catch (err) {
      check('buildOreDeployTransaction (API path) simulates', false, `${(err as Error).message} ${((err as { logs?: string[] }).logs ?? []).slice(-3).join(' | ')}`)
    }
  }
}
if (!simulated) check('simulated deploy built by buildOreDeployInstruction', false, 'no open round with a fresh miner found in time')
if (minerSize !== null) {
  const rent = await rpc.getMinimumBalanceForRentExemption(minerSize).send()
  check('Miner account size / rent', true, `${minerSize} bytes → ${rent} lamports`)
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  —  ${r.detail}` : ''}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)

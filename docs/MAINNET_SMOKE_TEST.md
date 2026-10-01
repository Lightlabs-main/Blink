# Mainnet smoke test

`scripts/smoke-mainnet.ts` proves one real payout end to end before any public mainnet drop
(MASTER_PROMPT §7, §22).

## Before you start

- **Owner approval:** Maris has approved mainnet spending.
- **Server environment:**
  - `SOLANA_CLUSTER=mainnet-beta`
  - a dedicated `SOLANA_RPC_URL` (OQ-6)
  - `MAINNET_ENABLED=true` and `MAINNET_GO_APPROVED=true`
  - `MAINNET_BUDGET_LAMPORTS` within the 0.10 SOL hard ceiling
- **A LIVE mainnet campaign** funded from the app by a creator wallet holding real xStocks, with a
  small `rewardPerClaimRaw`.
- **Fee payer** (logged by blink-api as "payout fee payer ready"; also at `GET /v1/status`) funded
  with a small amount of SOL.

## 1. Dry run (read-only, safe to repeat)

```bash
npx tsx scripts/smoke-mainnet.ts --campaign <campaign-id> --recipient <your wallet>
```

It checks, in order:
- the RPC is mainnet-beta, by genesis hash;
- the campaign is LIVE on mainnet;
- the mint is transferable, with no pause or transfer hook;
- the onchain delegation covers one reward;
- the fee payer can pay;
- the §7 budget has room;
- the exact payout transaction simulates.

Nothing is signed or sent.

## 2. Execute (real SOL and real stock move)

```bash
npx tsx scripts/smoke-mainnet.ts --campaign <campaign-id> --recipient <your wallet> --execute
```

This pays ONE reward to `--recipient` through the production payout path: Privy fee payer plus the
per-campaign Privy delegate, with a budget ledger entry. It then checks the recipient's balance
onchain and prints the explorer link.

## Record the result

Record the signature and outcome in `docs/DEPENDENCIES.md` (status vocabulary §5.4). Never write
"Mainnet works" without the signature.

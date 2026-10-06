# Mainnet go-live checklist

Prepared 2026-10-06 while devnet testing continues. Nothing here has switched the server to mainnet or sent a
mainnet transaction. Each step marked **Maris** needs an explicit go from the owner (MASTER_PROMPT §46 stop conditions).

## Done (read-only, safe)

| Item | Result |
|---|---|
| Dedicated mainnet RPC (OQ-6) | Helius mainnet, same account as the devnet key. Genesis `5eykt4Us…` verified. |
| Mainnet reads switched to Helius | `SEEKER_RPC_URL` and `XSTOCK_READ_RPC_URL` on the server (2026-10-06, `.env` backed up first). Seeker, SKR (balance + stake across pools), ORE (board round, miner round, stake) all read in < 1 s. OG marks, club rules and quests no longer hit the public RPC. |
| Mainnet preflight (`scripts/mainnet-preflight.ts`) | NVDAx, TSLAx, AAPLx, SPYx: mint found, 8 decimals, no transfer blockers. New recipient ≤ 0.001570 SOL (179-byte account rent + 2 signatures); existing holder 0.00001 SOL. |
| Budget maths | 0.02 SOL target → 12 new recipients; 0.05 → 31; 0.10 hard ceiling → 63. |

## Decided (D-46)

Self-declared eligibility with the IP-country check · disclosure wording approved · budget 0.02 SOL · switch only after
devnet testing.

## Staged on the server (2026-10-06)

- `.env.devnet` (the current settings) and `.env.mainnet` (cluster `mainnet-beta`, Helius mainnet RPC,
  `MAINNET_ENABLED` / `MAINNET_GO_APPROVED` true, budget 20,000,000 lamports, compliance `enforce`). Both pass
  `npx tsx scripts/check-env.ts`. Git-ignored, mode 600.
- **Mainnet fee payer created (empty):** `5WeRQjURUrgJBEMP91ndv4dnmFjpcYWETMPDnxXHaKhu` (role
  `fee-payer-mainnet-beta`, a Privy server wallet; `scripts/prepare-mainnet-fee-payer.ts`). The API uses this exact
  wallet on mainnet. It can be funded before the switch.

## Go-live (when Maris says go)

1. **Maris:** send ~0.03 SOL to the fee payer above (0.02 budget + margin). Real mainnet transfer.
2. On the server, from the repo root: `bash scripts/switch-network.sh mainnet`. It validates `.env.mainnet`, backs up
   `.env` and the database, switches, restarts `blink-api`, and waits for `/health` to report `mainnet-beta`; if not,
   it restores the previous `.env` by itself.
3. **Smoke test** (`docs/MAINNET_SMOKE_TEST.md`): a creator wallet with a little real NVDAx funds a tiny drop from the
   app (e.g. 0.01 NVDAx, 0.001 per person); `npx tsx scripts/smoke-mainnet.ts --campaign <id> --recipient <wallet>`
   (dry run), then `--execute` (**Maris**). Record the signature in DEPENDENCIES.md.
4. After a recorded successful payout: open public mainnet drops.

Back to devnet any time: `bash scripts/switch-network.sh devnet`.

## What changes for people

- **The app needs no rebuild.** It reads the network from the API (`/health`) and labels it "Solana" instead of "devnet
  (test)"; the asset list becomes the four real xStocks.
- Everyone confirms xStocks eligibility (country + not a U.S. person) before receiving, sending, gifting or funding.
- Creators need real xStocks and a little SOL in their own wallet (Phantom/Solflare on **Mainnet**).
- Devnet drops stop working (claims answer `WRONG_NETWORK`); clubs, chat, profiles, Passport and OG marks carry over
  (they are offchain).

## Rollback

Restore the `.env` backup and `pm2 restart blink-api --update-env`. Mainnet transactions already sent are final; the
budget ledger and claims keep their records.

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

## Decisions still open (Maris)

1. **xStocks eligibility method (OQ-9).** Today: self-declaration + IP-country cross-check, enforced on mainnet (the
   server refuses to start on mainnet with `XSTOCK_COMPLIANCE=off`). Confirm this is acceptable for the launch, or name a
   KYC provider. Until then `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION = BLOCKED` (SECURITY.md).
2. **Issuer-control disclosure wording (OQ-5).** A draft is shipped in the app; approve or edit it.
3. **Budget.** Pick `MAINNET_BUDGET_LAMPORTS` (suggest 0.02 SOL = 20,000,000 to start; hard ceiling 0.10 SOL).
4. **When.** Switching ends devnet testing for everyone (the same server serves one network).

## The switch (Maris says go)

1. Back up `.env` and the database (`pg_dump`), as for every migration.
2. Server `.env` changes:
   - `SOLANA_CLUSTER=mainnet-beta`
   - `SOLANA_RPC_URL=` Helius **mainnet** URL (same key)
   - `MAINNET_ENABLED=true`, `MAINNET_GO_APPROVED=true`
   - `MAINNET_BUDGET_LAMPORTS=20000000` (or the chosen budget)
   - `XSTOCK_COMPLIANCE=enforce`
   - keep `PAYOUTS_ENABLED` on (it is the kill switch)
3. `pm2 restart blink-api --update-env`. The log prints the **mainnet fee payer** address
   (`fee-payer-mainnet-beta`, a Privy server wallet created on first boot). `GET /v1/status` shows it too.
4. **Maris:** send the fee payer ~0.03 SOL (budget + a small margin for fees). This is a real mainnet transfer.
5. **Smoke test** (`docs/MAINNET_SMOKE_TEST.md`): a creator wallet holding a little real NVDAx creates and funds a tiny
   drop from the app (e.g. 0.01 NVDAx, 0.001 per person), then
   `npx tsx scripts/smoke-mainnet.ts --campaign <id> --recipient <wallet>` (dry run, read-only), then with `--execute`
   (**Maris**: moves real stock and SOL). Record the signature in DEPENDENCIES.md.
6. Only after a recorded successful smoke payout: announce public mainnet drops.

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

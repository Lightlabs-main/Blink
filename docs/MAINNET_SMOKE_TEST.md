# Mainnet smoke test — plan (prepared, NOT executed)

Status 2026-10-07: **not started**. MAINNET_GO_NO_GO.md is NO-GO; this plan runs only after every critical gate is
VERIFIED, and it stops at step 21 for Maris's explicit approval. One xStock, one creator, one eligible controlled
recipient, one campaign, about $0.50–$1.

**Proposed values (owner to confirm):** asset NVDAx (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`); fund 0.01 NVDAx
(1,000,000 raw), reward 0.005 NVDAx (500,000 raw) per person; Blink budget 0.02 SOL (fee payer
`5WeRQjURUrgJBEMP91ndv4dnmFjpcYWETMPDnxXHaKhu`).

| # | Step | Tooling | Status |
|---|---|---|---|
| 1–5 | Verify mint, Token-2022, decimals, multiplier (incl. pending + activation), extensions | `scripts/inspect-xstock.ts`, `scripts/mainnet-preflight.ts`, api.xstocks.fi | Done read-only 2026-10-07; repeat on the day |
| 6 | Creator + recipient eligibility | App (eligibility screen) | Needs both people |
| 7 | Account sizes / rent | inspect-xstock: campaign account 175 bytes / 1,539,240 lamports; recipient ≤ 179 bytes / 0.001570 SOL | Done; repeat |
| 8–11 | Derive, create and fund the campaign account; approve the exact delegate amount | App: Create → Fund (one MWA transaction, server re-derives the account) | Ready |
| 12 | Verify balance / allowance | `POST /v1/campaigns/:id/funding/verify` (onchain re-check) + the dry run of `smoke-mainnet.ts` (delegation covers one reward) | Ready |
| 13–14 | Recipient signs in, eligibility rechecked at claim time | App + claim route (IP re-check) | Ready |
| 15–19 | Derive recipient account, sponsored cost, budget, build, resolve extensions | `scripts/smoke-mainnet.ts` (dry run) | Ready |
| 20 | Simulate | `npx tsx scripts/smoke-mainnet.ts --campaign <id> --recipient <wallet>` | Ready |
| **21** | **STOP — ask Maris for explicit mainnet approval** | — | — |
| 22–26 | Sign, persist signature, submit, confirm, reconcile | `smoke-mainnet.ts --execute` (production payout path, budget ledger) | After approval only |
| 27–29 | Recipient balance, campaign balance, allowance decreased exactly | explorer + `GET /v1/campaigns/:id` (claimedRaw) + onchain account read | Ready |
| 30–31 | Blink receipt, explorer link on mainnet | App → Receipts & Activity | Ready |
| 32 | Pause the campaign | Kill switch (`PAYOUTS_ENABLED=false`) or owner pause | Global only — no per-campaign pause button |
| 33 | Revoke the delegate | **No Blink tooling** (creator wallet must support revoke for a non-ATA account) | **BLOCKED** |
| 34 | Return unused stock | **No Blink tooling** | **BLOCKED** |
| 35–36 | Close the auxiliary account, recover rent | **No Blink tooling** | **BLOCKED** |
| 37 | Record everything here | — | — |

Steps 33–36 need a creator wind-down action (HANDOFF item W-1) before the smoke test can complete.

## Script reference

- Dry run (read-only): checks mainnet genesis, campaign LIVE on mainnet, mint transferable, delegation covers one
  reward, fee payer can pay, budget room, and simulates the exact payout. Nothing is signed.
- `--execute` (real SOL and stock): pays one reward through the production path (Privy fee payer + per-campaign Privy
  delegate, budget ledger), checks the recipient balance and prints the explorer link.

Never write "mainnet works" without the signature.

## Results

(none yet)

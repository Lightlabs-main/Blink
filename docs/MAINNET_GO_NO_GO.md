# MAINNET GO / NO-GO

Audit date: 2026-10-07 · auditor: Claude (Lead Architect + Mobile) · server state during the audit: **devnet** (no mainnet
write was made; no mainnet SOL, xStock, SKR or ORE was moved).

## MAINNET STATUS: **NO-GO**

Seven critical gates are not VERIFIED (below). Each has a concrete path to closure; none needs a redesign.

## Critical gates

| Gate | Status | Evidence / reason |
|---|---|---|
| Android release build | **FAILED** | Hosted APK `c5dc737a` (SHA-256 `716d6b24…8e4b60`) lacks CAMERA and RECORD_AUDIO: `expo-image-picker` options blocked them app-wide (manifest inspection + `expo config --type introspect`, 2026-10-06; reproduced on the owner's phone: Settings shows only "Files and media"). Fixed in `a06d8f7`; needs a new build + device test. |
| MWA | **FAILED (partial)** | Authorize + `signTransactions` proven on a real Android phone with Solflare on devnet: funding tx `3NUSYXvT…` confirmed 2026-10-05 for campaign `24c85536…` (server log + onchain). Phantom did not open (owner report; likely Testnet Mode); rejection, cancel, disconnect/reconnect and wallet-change not yet tested on a device. See MOBILE_STACK_VERIFICATION.md. |
| Auth / SIWS | VERIFIED | Privy `useLoginWithSiws` / `useLinkWithSiws` (installed `@privy-io/expo ^0.65.5`), Privy-generated SIWS message; device-verified 2026-09-29 (OQ-8); server only trusts SIWS-verified wallets (`POST /v1/campaigns` tests: client-supplied creator wallet / account refused). Nonce semantics of Privy remain ASSUMPTION (OQ-8). |
| Network separation | VERIFIED | Config guards (`loadEnv` tests: mainnet needs `MAINNET_ENABLED`, GO flag needs it, budget ceiling, compliance must be `enforce` on mainnet); `.env.mainnet` / `.env.devnet` validated by `scripts/check-env.ts`; per-cluster fee payer role (`fee-payer-devnet` vs `fee-payer-mainnet-beta`); every campaign stores `cluster`, claims/funding refuse `WRONG_NETWORK`; asset registry per cluster (`assetsForCluster`); mainnet readers check the genesis hash. |
| Target xStock mint / extensions | VERIFIED | NVDAx/TSLAx/AAPLx/SPYx mints match api.xstocks.fi (2026-10-07); onchain via Helius mainnet: Token-2022, 8 decimals, not paused, `TransferHook` with no program, `DefaultAccountState` Initialized, PermanentDelegate present (disclosed, OQ-5), multipliers' last activation in the past and equal to the API's current multiplier. |
| Raw / scaled amounts | VERIFIED | Transfers use `rewardPerClaimRaw` / raw u64 (bigint) end to end; display uses the multiplier (`rawToUiShares`, xstocks package tests). Devnet e2e paid exactly 100000 raw per recipient. |
| Corporate-action guard | **FAILED** | xStocks guidance: pause ~15 min around a multiplier activation. Blink reads `newMultiplier` / timestamp but has no activation-window pause before payouts. Raw payouts are unaffected, but the guidance is not implemented. |
| Campaign treasury | VERIFIED (devnet) | `devnet-claim-e2e` 2026-10-07: creator-owned auxiliary Token-2022 account (CreateAccountWithSeed, server-derived), exact allowance to a per-campaign delegate, wallet-tampered funding refused (`TRANSACTION_MISMATCH`), funding `2p8t7cnp…` verified onchain. Real creator funding on device (2026-10-05) left 20 + 10 tNVDAx in two creator-owned accounts with exactly matching delegated amounts. |
| Delegate cap | VERIFIED (devnet) | Per-campaign Privy delegate; native Token-2022 allowance decreased exactly (e2e: 50000 left of 250000 after two 100000 payouts); third claim refused before signing. Max loss on delegate compromise = that campaign's remaining allowance. |
| Payout simulation (mainnet target) | **BLOCKED** | Simulation passes on devnet (every payout simulates first). A mainnet simulation needs a funded mainnet campaign; it is step 20 of the smoke plan (dry run of `smoke-mainnet.ts`). |
| Idempotency | VERIFIED | Tests: second claim returns the same claim; sweep-released claim cannot be sent; double tap of 10 parallel claims on Postgres → one claim (`claims.prisma.test.ts`, run on the server 2026-10-07). Signature persisted before send (`markSending`). |
| Solvency | VERIFIED | Conditional `UPDATE … claimedRaw + amount <= allowanceRaw` + CHECK constraint; 20 parallel claims on a 5-reward drop → exactly 5, rest `EXHAUSTED`, `claimedRaw = 500 = allowance` (Postgres on the server). Note: through a high-latency tunnel the same test timed out to 1/5 reserved — fails safe (no overpay) but is a load-liveness risk. |
| Fee payer | VERIFIED (devnet) | Separate Privy server wallet per cluster, no token authority; balance shown in `/v1/status` with a low flag and hourly log warning; e2e paid fees and recipient rent. Mainnet fee payer `5WeRQjUR…HaKhu` created, unfunded. |
| Mainnet budget | **FAILED (minor)** | Real costs measured (new recipient ≤ 0.001570 SOL, holder 0.00001 SOL); budget 0.02 SOL configured and capped at 0.10 SOL. The required 25 % uncommitted buffer is **not enforced** (`checkBudget` allows spending up to the budget). Fix: enforce the buffer, or set the effective budget to 0.015 SOL. |
| Production RPC | VERIFIED (reads) | Helius mainnet: genesis verified; SKR stake (`getProgramAccounts`), ORE board/miner/stake, SGT and xStock mint reads succeed (< 1 s). Mainnet simulate/send/confirm through Helius not yet exercised (smoke plan). |
| Secrets audit | VERIFIED | Repo: no secrets tracked (git grep), `.env*` ignored. APK: PRIVY_APP_SECRET, DB password, Helius key, Expo token absent from every APK entry; only the public Privy app/client ids present; pattern hits were library constants. Server: `.env*` and backups mode 600, `.secrets` 700. |
| Payout kill switch | VERIFIED | `PAYOUTS_ENABLED=false` stops claims before any reservation (test), payouts (`payout-service`), sends and gifts (`send-service`); `/v1/status` shows it. Browsing unaffected. |
| Compliance approach | **NEEDS_OWNER_DECISION** | Owner chose self-declaration + IP-country check (D-46). Official Backed legal page: products prohibited for U.S. persons; it does not say whether a third-party distributor may rely on self-declaration. Legal sufficiency is unverified; `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION` stays **BLOCKED** until confirmed. Send to an arbitrary address cannot check the recipient. |
| Controlled-recipient eligibility | **BLOCKED** | Needs a named controlled recipient who confirms eligibility on mainnet (step 13–14 of the smoke plan). |
| Smoke-test plan | **FAILED (incomplete)** | Plan written (MAINNET_SMOKE_TEST.md), but steps 33–36 (revoke delegate, return unused stock, close the auxiliary account, recover rent) have **no Blink tooling**; creators cannot do them from the app. |

## What closes NO-GO

1. New APK with the permission fix → clean install on a real phone → run the device checklist (MOBILE_STACK_VERIFICATION.md), including MWA reject / cancel / disconnect and Phantom in Testnet/Mainnet mode.
2. Implement the corporate-action window guard (refuse payouts within ±15 min of a pending activation; retryable).
3. Enforce the 25 % budget buffer.
4. Add creator wind-down: build an unsigned revoke + transfer-back + close transaction for the creator's wallet (MWA), and a "Close drop" action.
5. Owner: confirm compliance sufficiency (legal) and name the controlled recipient + creator for the smoke test.
6. Then: fund the mainnet fee payer, switch, run the smoke plan to step 21 (simulate) and **stop for explicit approval**.

## Non-critical findings

| Item | Status | Note |
|---|---|---|
| SKR prize wording "staking integrations do not qualify" | ASSUMPTION | Not found on the official CLOCK IN blog (2026-10-07), which lists staking among example uses. Verify on the event's FAQ page. Blink's SKR today = holding/stake gating + in-app staking + OG mark; **no SKR-native social utility is live** (tips/club access in SKR not built) — do not claim the SKR prize on staking. |
| ORE | VERIFIED (verifier) / ASSUMPTION (prize) | `ORE_ACTIVITY` is campaign-bound (Miner.round_id > round recorded at creation; layout checked onchain, D-33). The OG "ORE miner" mark (ever mined) is a badge only, never a payout condition. Official ORE prize criteria not found; do not claim eligibility from balance checks. |
| X proof (oEmbed) | NEEDS_OWNER_DECISION | Reads X's official public embed: author, text, existence; time from the post-id snowflake. Not the X API. Owner accepted for devnet (D-39); decide whether X quests may pay real xStocks on mainnet or stay devnet-only. |
| Privy authorization-key blast radius (OQ-4) | NEEDS_OWNER_DECISION | A leaked app secret could drive every Privy server wallet (delegates + fee payers); native allowances still cap each campaign. |
| Gift recipient that confirms late | ASSUMPTION | Recorded PENDING, not posted to chat; no reconcile sweep yet. |

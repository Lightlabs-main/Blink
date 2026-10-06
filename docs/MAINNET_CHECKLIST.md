# Mainnet checklist (pre-mainnet verification gate)

Audit 2026-10-07. Summary and evidence for critical gates: MAINNET_GO_NO_GO.md (**NO-GO**). Mobile items:
MOBILE_STACK_VERIFICATION.md. Plan: MAINNET_SMOKE_TEST.md. Section numbers follow the gate brief.

| § | Area | Status | Evidence / gap |
|---|---|---|---|
| 2 | Hackathon requirements | FAILED until rebuild | APK permissions defect; everything else VERIFIED (MOBILE_STACK_VERIFICATION.md). |
| 3 | MWA | FAILED (partial) | Solflare authorize + sign on device VERIFIED; Phantom, reject, cancel, disconnect NOT TESTED. |
| 4 | Seed Vault | VERIFIED (design) · NOT TESTED (hardware) | MWA only; no direct Seed Vault API. No Seeker available. |
| 5 | SKR | VERIFIED (addresses, reads, gating) · ASSUMPTION (prize wording) | Official docs match code; Helius stake reads work. No SKR-native social utility built. |
| 6 | ORE | VERIFIED (campaign-bound mining verifier) · ASSUMPTION (prize criteria) | D-33 layout checked onchain; OG "ever mined" is a badge, never a payout condition. |
| 7 | xStocks token standard | VERIFIED | 4 mints match api.xstocks.fi; onchain extensions, decimals 8, campaign account 175 bytes / 1,539,240 lamports, recipient ≤ 179 bytes. |
| 8 | Corporate-action safety | **FAILED** | No ±15-min activation-window pause (xStocks guidance). HANDOFF W-2. |
| 9 | Compliance | **NEEDS_OWNER_DECISION** · `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION = BLOCKED` | Self-declaration + IP check enforced for creator funding, claim, Tap Rush start, Send, Gift (sender live check, recipient stored check). Legal sufficiency unverified; Send to an external address cannot check the recipient. |
| 10 | Creator-owned treasury | VERIFIED (devnet) | e2e + on-device funding; account owned by the creator, never the ATA, exact delegated amount. |
| 11 | Account derivation | VERIFIED | CreateAccountWithSeed, 32-char seed from the campaign UUID, re-derived server-side, pre-creation existence check (`409 DERIVED_ACCOUNT_EXISTS`), client-supplied accounts refused (tests). |
| 12 | Delegate security | VERIFIED · NEEDS_OWNER_DECISION (OQ-4) | Per-campaign Privy delegate; native allowance is the cap. Privy app-secret blast radius still open. |
| 13 | Fee payer | VERIFIED (devnet) | Separate per-cluster Privy server wallet, no token authority, monitored; mainnet one created, unfunded. |
| 14 | Cost / rent | VERIFIED (numbers) · **FAILED** (25 % buffer not enforced) | 0.02 SOL ≈ 12 new recipients; with a 25 % buffer ≈ 9. HANDOFF W-3. |
| 15 | Payout pipeline | VERIFIED (devnet) · BLOCKED (mainnet simulate) | devnet-claim-e2e PASSED 2026-10-07; every payout simulates before signing; signature persisted before send; SENDING ≠ PAID. |
| 16 | Idempotency | VERIFIED | Unit tests + Postgres double-tap test (one claim). |
| 17 | Solvency | VERIFIED · ASSUMPTION (heavy-load liveness) | Postgres 20-way concurrency: exactly 5 of 5. Timeouts under high latency fail safe. |
| 18 | Tap Rush | VERIFIED | Server session, server goal/timer, tap-time checks (too fast, robotic, count mismatch, early finish), attempt limit, session single-use (tests). Client cannot claim with a count alone. Goal bounds 10–1,000, default 1,000 in 120 s. |
| 19 | Social features offchain | VERIFIED | Clubs, chat, voice, reactions, squads, leaderboard, Passport, receipts, check-in, X proof, OG: Postgres only; none can pay without the claim service's qualification. |
| 20 | QR check-in | VERIFIED | 24 random bytes, campaign-bound, rotatable, one check-in per person (PK), LIVE + window enforced, no location (tests). A screenshot works until the creator rotates the code — by design. |
| 21 | X proof | NEEDS_OWNER_DECISION | oEmbed (official public embed, not the API) — keep devnet-only or accept for mainnet. |
| 22 | Receipts | VERIFIED | "Reward settled ✓" only when CONFIRMED; "Completed · reward sending" before; no email/country/compliance on receipts; explorer link uses the claim's cluster. |
| 23 | Send / Gift | VERIFIED (devnet) | devnet-send-e2e PASSED 2026-10-07 (balance cap, tamper refusal, sponsored fee + rent, 0-SOL sender); gifts resolve the recipient wallet server-side, 20/day, kill switch. |
| 24 | Privy | VERIFIED (client/server split) | Email + embedded wallets; secrets server-only (APK scan); SIWS for creators. Privy server-wallet policy features not used — native allowance is the cap. |
| 25 | RPC | VERIFIED (reads) | Helius mainnet for reads; RPC failures return ERROR / "Couldn't check right now", never "failed" (tests: fails closed). Mainnet send/confirm through Helius pending. |
| 26 | Network separation | VERIFIED | See GO/NO-GO. |
| 27 | Flags / kill switch | VERIFIED | Config tests + kill-switch test; enforced in claim, payout, send. |
| 28 | Secrets | VERIFIED | Repo + APK + server permissions (2026-10-06/07). Finding: `package.json` lists `verify-delegation` and `estimate-rent` scripts whose files do not exist. |
| 29 | VPS isolation | VERIFIED | Own directory, PM2 app `blink-api` only (no global PM2/docker commands used), own Postgres container `blink-postgres` on a loopback port, own DB `blink_to_stock` / user `blink_app`, own Caddy site blocks (backup + validate before reload), backups in the project folder (600/700). Details in the private inventory. |
| 30 | Android real-device test | **BLOCKED** | Needs the rebuilt APK; plan in MOBILE_STACK_VERIFICATION.md. |

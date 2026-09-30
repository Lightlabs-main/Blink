# Handoff

## 2026-09-29 — Claude → Codex: Codex-owned areas scaffolded at Maris's request

Maris asked Claude to start the non-Android work while the machine is prepared. Claude therefore
created initial code in Codex-owned paths. **Codex should review these and take ownership.**

| Path | Contents | Tests |
|---|---|---|
| `packages/config` | env schema; mainnet guards (§22); `checkBudget` (§7, hard ceiling 0.10 SOL) | yes |
| `packages/solana` | campaign seed (§11) and derivation; pre-creation existence check; mint inspection; Token-2022 rent estimator (§13); delegation validity check (§9) | yes |
| `packages/xstocks` | 4 verified mints; exact Scaled UI conversions (floor) | yes |
| `prisma/` | `schema.prisma`: Campaign, BudgetLedgerEntry, AuditLog | — |
| root `prisma.config.ts` | Prisma 7 config | — |
| `scripts/inspect-xstock.ts` | read-only mint inspection and rent estimate | — |
| `scripts/db-guard.ts` | refuses a migration unless `DATABASE_URL` names `blink_to_stock` | yes |
| `apps/api` | Fastify: `/health`, `GET /v1/xstocks`, `POST /v1/campaigns` (Privy-verified creator; server-derived seed and account; 409 if the derived account exists), `GET /v1/campaigns/:id` | yes |

`apps/api/src/main.ts` runs **in-memory only**, and refuses to start unless `BLINK_ENV=local`.
Wiring the Prisma repository is TODO.

**Not started (blocked on missing spec sections):** claims, Tap Rush sessions, payouts, fee payer,
Seeker verification, `smoke-mainnet.ts`, `devnet-test-mint.ts`, `verify-delegation.ts`,
`estimate-rent.ts` (`inspect-xstock.ts --fee-payer` covers rent for now).

## API contract v0 (owner: Claude) — 2026-09-29

- `POST /v1/campaigns`
  - Headers: `Authorization: Bearer <Privy access token>`, and optionally
    `X-Creator-Wallet: <address>`, which only selects among verified wallets.
  - Body (strict): `{ type, mint, allowanceRaw }`. `allowanceRaw` is a u64 decimal string > 0.
  - Response 201: `{ campaign: CampaignSummary }`.
  - Errors: 400 INVALID_REQUEST, 401 UNAUTHENTICATED, 403 CREATOR_WALLET_NOT_VERIFIED,
    409 DERIVED_ACCOUNT_EXISTS, 422 UNSUPPORTED_MINT.
- `GET /v1/campaigns/:id` → `{ campaign }` or 404.
- `GET /v1/xstocks` → `{ xstocks: [{ symbol, name, mint, decimals }] }`.

Schemas: `packages/validation/src/index.ts`. Types: `packages/domain/src/index.ts`.

## API contract v1 additions (owner: Claude) — 2026-09-29

These are additive and nothing existing changed.

- `GET /v1/xstocks`: each item now also carries `multiplier` (the effective Scaled UI multiplier
  at the mainnet cluster clock; display only), `paused` and `asOf` (cluster unix seconds). All three
  are `null` when `XSTOCK_READ_RPC_URL` is unset or the read fails.
- `GET /v1/campaigns`: public, LIVE campaigns only, newest first, maximum 50.
- `GET /v1/me` (auth): `{ privyUserId, verifiedCreatorWallets }`.
- `GET /v1/me/campaigns` (auth): the caller's campaigns, newest first, maximum 50.

The mobile app talks to `https://blink-api.38-49-209-149.sslip.io`, an interim hostname until there
is a real domain. It shares `packages/domain` and `packages/xstocks` through
`apps/mobile/src/shared`, so those two packages **must stay dependency-free** and avoid BigInt `**`
(use `pow10`).

## API contract v2: claims and Tap Rush (owner: Claude, 2026-09-30)

Built at Maris's request under the DECISIONS D-13 assumptions. **Codex should review:**
`apps/api` (claim-service, payout-service, budget-ledger, claim repositories), `packages/solana`
(payout.ts) and the `prisma/` migration `20260930000000_claims_tap_rush`.

- **`POST /v1/campaigns` (breaking):** GIFT, EARLY_CLAIM and TAP_RUSH now require
  `rewardPerClaimRaw` (u64 string, > 0, ≤ `allowanceRaw`). TAP_RUSH may also send
  `tapRush: { goal, seconds }`; defaults are `{ goal: 50, seconds: 10 }`.
- **`CampaignSummary`:** adds `rewardPerClaimRaw` (null for older drafts, which cannot be
  claimed), `claimedRaw` and `tapRush`.
- **`POST /v1/campaigns/:id/tap-rush/start`** (auth) → `{ session: { id, campaignId, goal,
  seconds, startedAt, attemptsLeft } }`.
  - Errors: 409 NOT_TAP_RUSH / ALREADY_CLAIMED / NOT_LIVE / EXHAUSTED, 403 OWN_CAMPAIGN,
    429 NO_ATTEMPTS_LEFT.
- **`POST /v1/campaigns/:id/tap-rush/finish`** (auth) `{ sessionId, taps }` →
  `{ qualified, taps, goal, attemptsLeft }`.
  - Errors: 422 ROUND_TIMING_INVALID / ROUND_REJECTED, 409 SESSION_FINISHED,
    404 SESSION_NOT_FOUND.
- **`POST /v1/campaigns/:id/claim`** (auth) `{ tapSessionId? }` → `{ claim: ClaimSummary }`.
  - Idempotent per user and campaign. It waits up to about 30 s for confirmation; a `SENDING`
    result means poll `GET …/claim`.
  - Errors: 403 OWN_CAMPAIGN / NOT_QUALIFIED; 409 NOT_LIVE / NOT_CLAIMABLE / EXHAUSTED /
    WALLET_ALREADY_CLAIMED / NO_STOCK_WALLET / CAMPAIGN_PAUSED; 503 PAYOUTS_UNAVAILABLE.
- **`GET /v1/campaigns/:id/claim`** (auth) → `{ claim | null }`. A SENDING claim is reconciled
  against the chain first.
- **`GET /v1/me/claims`** (auth) → `{ claims: ClaimSummary[] }`, newest first, maximum 50.

`ClaimSummary`: `{ id, campaignId, cluster, mint, xstockSymbol, amountRaw, recipientWallet,
status: RESERVED | SENDING | PAID | FAILED, txSignature, failureReason, createdAt }`.

**Devnet end-to-end check:** `npx tsx scripts/devnet-claim-e2e.ts`. It needs the same
`.secrets/` files and Privy credentials as SPIKE-1.

## API contract v3: Referral, Tap Rush timings, resume (owner: Claude, 2026-09-30)

Built under the DECISIONS D-14 assumptions. Migration: `20260930120000_referrals_tap_checks`.

- **`POST …/tap-rush/finish` (breaking):** the body is now `{ sessionId, taps, tapTimesMs }`,
  where `tapTimesMs` holds integer ms since the round started, one per tap. A round that fails the
  checks returns 422 ROUND_REJECTED.
- **`POST …/claim`:** also accepts `ref` (an 8-character invite code), which REFERRAL drops
  require. New errors: 403 NEEDS_INVITE / SELF_REFERRAL.
- **`GET …/referral`** (auth) → `{ referral: { campaignId, code, bonus: ClaimSummary | null } |
  null }`. **`POST …/referral`** creates the code if needed. The creator gets 403 OWN_CAMPAIGN.
- **`POST …/referral/bonus/retry`** (auth) → `{ claim }`. It resends a FAILED bonus once the
  friend is PAID; otherwise it returns 409 FRIEND_NOT_PAID.
- **`POST …/resume`** (creator) → `{ campaign }`: PAUSED → LIVE, or → ENDED when less than one
  reward is left. 409 STILL_NOT_READY means the onchain check still fails.
- **Summaries:** `ClaimSummary` adds `kind: CLAIM | REFERRAL_BONUS`; `CampaignSummary` adds
  `pauseReason`.

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

## API host (2026-09-30)

New app builds call `https://api.blinksol.site`. The sslip.io host remains an alias (DECISIONS D-15).

## API contract v4 (owner: Claude, 2026-10-01)

- **`GET /v1/status`** (public) → `{ cluster, payouts: { enabled, feePayer?, balanceLamports?,
  low? } }`.
- **Rate limits:** 429 `RATE_LIMITED` on mutating recipient routes, and 429 `IP_LIMIT` when
  `CLAIMS_PER_IP_PER_CAMPAIGN` is set (D-16).
- **SEEKER drops are claimable** (D-17). `POST …/claim` adds 403 `NEEDS_SEEKER`, 409
  `DEVICE_ALREADY_CLAIMED` and 503 `SEEKER_UNAVAILABLE`. Creating a SEEKER campaign now requires
  `rewardPerClaimRaw`.
- **Migration:** `20261001090000_seeker_claims` (`Claim.sgtMint`).
- **New env:** `FEE_PAYER_LOW_LAMPORTS`, `CLAIMS_PER_IP_PER_CAMPAIGN`, `SEEKER_RPC_URL`.

## API contract v5: xStocks eligibility and kill switch (owner: Claude, 2026-10-01)

- **`GET /v1/me/eligibility`** (auth) → `{ enforced, eligibility: XStockEligibilitySummary | null }`.
- **`POST /v1/me/eligibility`** (auth) with `{ country, notUsPerson, attestations? }` → `{ enforced,
  eligibility }`. The server decides, with the IP-country cross-check.
- **New errors** on claim, Tap Rush start, bonus retry and funding prepare:
  - 403 `NEEDS_ELIGIBILITY`: no current-policy decision;
  - 403 `NOT_ELIGIBLE`: restricted, or an unknown connection country;
  - 503 `ELIGIBILITY_UNAVAILABLE`: gate enforced but not configured (fails closed);
  - 503 `PAYOUTS_PAUSED`: kill switch.
- **`/v1/status`** adds `payouts.killSwitch` and `compliance.xstocks`.
- **Migration:** `20261001120000_xstock_eligibility`.
- **New env:** `XSTOCK_COMPLIANCE` (`enforce` | `off`; must be `enforce` on mainnet) and
  `PAYOUTS_ENABLED`.

## API contract v6: Verified Quests, room, window (owner: Claude, 2026-10-02)

- **`POST /v1/campaigns`** accepts:
  - `requirements` (required for `VERIFIED_QUEST`, refused otherwise; see `questRequirements` in
    `packages/validation`);
  - `startsAt` / `endsAt` (ISO).

  `tapRush` is accepted for a quest with a TAP_RUSH action (defaults applied).
- **`CampaignSummary`** adds `requirements`, `startsAt` and `endsAt`.
- **`POST /v1/campaigns/:id/verify`** (auth, throttled) → `{ evaluation: QuestEvaluation }`
  (statuses + raw amounts as strings).
- **`GET /v1/campaigns/:id/room`** (public) → `{ room: CampaignRoom }`.
- **Tap Rush start** is allowed for quests with a TAP_RUSH action.
- **New errors:** 403 `NOT_QUALIFIED` (quest), 409 `NOT_STARTED` / `CAMPAIGN_OVER`, 503
  `QUESTS_UNAVAILABLE`.
- **Migration:** `20261001150000_verified_quests`.

**Codex review requested:** `quest-service.ts`, `stake-readers.ts` (layouts and aggregation),
`roomData` queries.

## API contract v7: SKR staking and push (owner: Claude, 2026-10-02)

- **`GET /v1/skr/position?wallet=`** (auth; the wallet must be one of the caller's SIWS-verified wallets) →
  `{ position: { wallet, guardianPool, walletRaw, stakedRaw, unstakingRaw, minStakeRaw, cooldownSeconds,
  withdrawableAt } }`. Raw amounts are strings, 6 decimals. Mainnet reads.
- **`POST /v1/skr/prepare`** (auth, throttled) `{ wallet, action: 'stake'|'unstake'|'withdraw'|'cancel_unstake',
  amountRaw?, all? }` → `{ prepared: { transaction (unsigned v0, base64), minContextSlot, lastValidBlockHeight } }`.
  Simulated on mainnet first. The app signs and sends it with MWA on `solana:mainnet`.
- **`POST /v1/me/push-token`** (auth, throttled) `{ token: ExponentPushToken[…], platform }`;
  **`DELETE /v1/me/push-token`** `{ token }` removes only the caller's own token.
- **New errors:** 403 `WALLET_NOT_LINKED`; 400 `SKR_INVALID`, 422 `SKR_SIMULATION_FAILED` (human message from the
  program error); 503 `SKR_UNAVAILABLE` / `SKR_READ_FAILED` / `PUSH_UNAVAILABLE`.
- **Migration:** `20261002090000_push_tokens`. **Env:** optional `EXPO_ACCESS_TOKEN`.

**Codex review requested:** `packages/solana/src/skr-staking.ts` (account order and roles against the IDL),
`apps/api/src/push.ts`.

## API contract v8: clubs, chat, squads, event check-in, Passport (owner: Claude, 2026-10-05, D-40)

All routes need `Authorization: Bearer <Privy token>`; identity always comes from the token. Migration:
`20261005090000_clubs_social` (additive: 8 new tables + nullable `Campaign.clubId`).

- **Clubs:** `GET /v1/clubs?tab=discover|joined&q=` → `{ clubs: ClubSummary[] }`; `POST /v1/clubs` `{ name, slug?,
  description, category, tags[], visibility }` → 201 `{ club }` (409 `SLUG_TAKEN`, 400 `INVALID_NAME`, 429
  `RATE_LIMITED`); `GET /v1/clubs/:slugOrId[?invite=]` → `{ club: ClubDetail }` (404 for private without invite);
  `POST /v1/clubs/:slug/join` `{ invite? }` (409 `ALREADY_MEMBER`); `POST /v1/clubs/:slug/leave` (409
  `OWNER_CANNOT_LEAVE` / `NOT_A_MEMBER`).
- **Chat:** `GET /v1/clubs/:slug/messages?before=|after=` → `{ messages: ChatMessage[], serverTime }` (ascending, 30
  per page); `POST …/messages` `{ body, replyTo? }` → 201 `{ message }` (403 `NOT_A_MEMBER`, 429, 400
  `INVALID_REPLY`); `DELETE …/messages/:id` (author, owner or mod); `POST …/messages/:id/reactions` `{ emoji }` toggles.
- **Leaderboard:** `GET /v1/clubs/:slug/leaderboard?period=week|all` → `{ leaderboard: ClubLeaderboardEntry[], points }`.
- **Club drops:** `POST /v1/campaigns` accepts `clubId` (403 `NOT_A_MEMBER`); a `CLUB_MEMBER` requirement needs it.
  `CampaignSummary.clubId`.
- **Event check-in:** `GET|POST /v1/campaigns/:id/event-code` (creator; POST rotates) → `{ event: { token, link } }`;
  `POST /v1/checkin` `{ token }` → `{ checkin: { campaignId, alreadyCheckedIn } }` (404 `INVALID_CODE`, 409
  `NOT_LIVE` / `NOT_STARTED` / `CAMPAIGN_OVER`, 403 `OWN_CAMPAIGN`, 10 per hour).
- **Squads:** `GET /v1/campaigns/:id/squads` → `{ mine, squads }`; `POST /v1/campaigns/:id/squads` `{ name }`;
  `POST /v1/squads/join` `{ code }` (409 `SQUAD_FULL` / `ALREADY_IN_SQUAD`); `POST /v1/squads/:id/leave`.
- **Passport:** `GET /v1/me/passport` → `{ passport: { badges, rewards, checkins, clubs, squadWins } }`.
- **History:** items may have `kind: CHECKIN | CLUB_JOINED` with `title` / `clubSlug`, `amountRaw: "0"`, no signature.

**Codex review requested:** `apps/api/src/social-store.ts` (Prisma queries, the squad seat lock), `social-routes.ts`,
the migration.

## API contract v9: club rules and members-only drops (owner: Claude, 2026-10-05, D-41)

- `POST /v1/clubs` accepts `rules: QuestGroup[]` (verifiers: SEEKER_SGT, SKR_BALANCE, SKR_STAKED, SKR_TOTAL, ORE_BALANCE,
  ORE_STAKED). `ClubSummary.rules`. `PUT /v1/clubs/:slug/rules` `{ rules }` (owner only, 403 otherwise).
- `POST /v1/clubs/:slug/join` → 403 `{ error: { code: 'CLUB_RULES_NOT_MET' }, evaluation }` when rules fail; 503
  `RULES_UNAVAILABLE` without the quest service.
- `POST /v1/campaigns` accepts `membersOnly` (requires `clubId`); `CampaignSummary.membersOnly`. Participation routes
  return 403 `NOT_A_MEMBER` for non-members.
- Migration `20261005150000_club_rules` (additive: `Club.rulesJson`, `Campaign.membersOnly` default false).

## API contract v10: voice notes and club admin controls (owner: Claude, 2026-10-05, D-43)

- `POST /v1/clubs/:slug/voice` `{ audio (base64 M4A), durationMs ≤ 60000, replyTo? }` → 201 `{ message }`; 400
  `INVALID_AUDIO`, 413 `VOICE_TOO_LARGE`, 403 `MUTED` / `ADMINS_ONLY` / `NOT_A_MEMBER`, 429. `GET /v1/voice/:id` → audio/mp4.
- `ChatMessage` adds `kind: TEXT | VOICE` and `voice: { url, durationMs } | null`. `ClubDetail` adds `adminsOnly`,
  `pinned`, `myMutedUntil`. Text posts may now return 403 `MUTED` / `ADMINS_ONLY`; joins 403 `REMOVED`.
- `GET /v1/clubs/:slug/members` → `{ members: ClubMemberView[], removed: [...] | null (admins only) }`.
- `POST …/members/:id/role` `{ role: MOD | MEMBER }` (owner); `POST …/members/:id/mute` `{ minutes: 0|60|480|1440|10080 }`;
  `POST …/members/:id/remove`; `POST …/removed/:id/restore`; `PUT …/settings` `{ adminsOnly?, description? }`;
  `POST|DELETE …/messages/:mid/pin` (admins).
- Migration `20261005180000_club_admin_voice` (additive).

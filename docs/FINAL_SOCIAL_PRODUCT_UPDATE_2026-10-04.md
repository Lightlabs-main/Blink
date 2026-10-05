# Final social product update — audit (2026-10-05)

The mandate is dated 2026-10-04 and the audit ran on 2026-10-05; submission is 2026-10-08. No code has changed
for this update yet. This file records what exists, what the mandate adds, the owner's decisions and what was built (DECISIONS D-40).

## Baseline (before any change)

Commit `4b734d2` on `main` with a clean tree; the same commit is deployed on the VPS (`blink-api` restarted
2026-10-04 20:50 UTC; migration `20261004170000_username_claims` applied).

| Check | Command | Result |
|---|---|---|
| API + packages typecheck | `npm run typecheck` (root) | pass |
| Unit/integration tests | `npx vitest run` (root) | 13 files, 175 tests, all pass |
| Prisma schema | `npx prisma validate` | valid |
| Mobile typecheck | `npx tsc --noEmit` (apps/mobile) | pass |
| Mobile lint | `npx expo lint` (apps/mobile) | 0 errors, 3 warnings (unused imports in `(tabs)/profile.tsx`, `features/campaign/claim-panel.tsx`) |
| Mobile format | `npx prettier --check .` (apps/mobile) | 37 files not formatted (existing; not caused by this update) |
| Username claims on real Postgres | scratch DB on the VPS, migrate + `PrismaProfileStore` | pass (scratch DB dropped) |

Not run: Android build (no build until Maris says so; builds are batched), on-device test.

## What already exists vs the mandate

| Mandate item | State today | Where |
|---|---|---|
| §21 How Blink works opens | **Done.** Row pushes `/how`; 4 participant steps + wallet + creator + safety sections. Copy differs from the mandate's 6 steps | `app/how.tsx`, `(tabs)/profile.tsx:243` |
| §11 Custom Tap Rush | **Done** (D-36): goal 10–1,000, rounds 10 s–2 min, ≤12 taps/s average, server anti-cheat (D-14). Default is still 50 taps / 10 s, not 1,000. No squad mode | `create.tsx`, `TAP_RUSH_LIMITS`, `TAP_RUSH_DEFAULTS` |
| §12 X proof by link | **Done differently** (D-39, owner decision): personal code `BLINK-XXXXXX`, public post read via X oEmbed (no API key). Mandate asks for the official X API with `author_id`; oEmbed gives author handle, not id | `x-quest.ts`, `XTask` |
| §18–20 Receipts + activity | **Partly done** (D-38): `/v1/me/history` derived from claims, transfers and funded drops; branded receipt, PNG share via `react-native-view-shot` + `expo-sharing`. Missing: quest-completed-without-payout receipts, event/club entries, filters, pagination, non-guessable public receipt ids | `history.ts`, `app/history.tsx`, `app/receipt/[id].tsx`, `features/receipts/` |
| §13 Verified Quest engine | **Done** (D-21/D-33/D-39): ALL/ANY groups; Seeker SGT, SKR balance/staked/total, ORE balance/staked/activity, Tap Rush, X quest. No Club membership or QR check-in verifiers | `packages/domain` `VERIFIER_TYPES`, `quest-service.ts` |
| §14 SKR | **Done**: hold/stake/total verifiers, in-app staking (v7), addresses VERIFIED in DEPENDENCIES.md | `skr-service.ts`, `stake-readers.ts`, `skr-staking.ts` |
| §15 ORE | **Done**: balance, staked, mining-after-campaign-start (D-33, layout verified against mainnet) | `stake-readers.ts` |
| Usernames + avatars | **Done** (D-37, usernames permanent per first owner) | `profile.ts` |
| §28–30 payout rail, xStocks, compliance | **Done and locked**; untouched by this update | `payout-service.ts`, `eligibility.ts` |
| §2 Nav Home/Clubs/Scan/Drops/You | **Not done.** Tabs are home/drops/create/profile + Scan button in `BlinkTabBar` | `(tabs)/_layout.tsx`, `design/tab-bar.tsx` |
| §4–9 Clubs, chat, club campaigns, leaderboard | **Not started.** No tables, routes or screens | — |
| §10 Squads | **Not started**; listed under "Coming soon" | — |
| §16 QR event check-in | **Not started.** Scanner only parses campaign links (`parseCampaignLink`) | `app/scan.tsx`, `lib/format.ts` |
| §17 Stock Passport | **Not started**; listed under "Coming soon" | — |
| §22 Remove "Coming soon" | Profile `SOON` list (Squads, Clubs, Passport, QR) and create `COMING_SOON` (QR Event, Squad) | `(tabs)/profile.tsx:20`, `(tabs)/create.tsx:52` |

Realtime: none. The live room polls with React Query every 4 s while live (`features/campaign/live-room.tsx`).
No WebSocket/SSE package is installed in the API. Rate limiting exists (`apps/api/src/rate-limit.ts`).

## Proposed build (thinnest real version)

### Backend (new tables, additive migration only)

- `Club` (id, slug unique, name, description, category, tags[], visibility, ownerPrivyUserId, createdAt);
  `ClubMember` (clubId+privyUserId PK, role OWNER/MOD/MEMBER, joinedAt). Member count = `count(*)`.
- `ClubMessage` (id, clubId, authorPrivyUserId, body ≤500 chars plain text, replyToId?, deletedAt?, createdAt);
  `ClubMessageReaction` (messageId+privyUserId+emoji PK, fixed emoji set).
- `Campaign.clubId` nullable FK; `CLUB_MEMBER` verifier (server-side membership check; does not bypass compliance).
- `EventCheckin` + `QR_CHECKIN` action verifier: creator gets an HMAC-signed, expiring token per campaign
  (`blink://e/<token>` and `https://blinksol.site/e/<token>`); redemption unique per campaign+user.
- `Squad`, `SquadMember` (one squad per user per campaign, max size per campaign, invite code); scoring rule
  `COMBINED_TAPS` only (sum of each member's server-accepted Tap Rush taps).
- Leaderboard and Passport **derived**, not stored: points = paid/qualified claims + verified quests + check-ins in
  the club's campaigns, per week / all time. No balances.
- Chat transport: **short polling** (`GET /v1/clubs/:id/messages?after=<cursor>` every 3–4 s while the screen is
  focused), the same pattern as the live room. No new dependency; WebSocket can follow if time allows.
- Rate limits: messages 20/min/user, club creation 3/day/user, squad creation 5/day, check-in 10/hour.

### Mobile

- Tabs: `home`, `clubs` (new), Scan button, `drops`, `profile`. `create` stays as a route (pushed from Home quick
  action and a `+` on Drops/Clubs) so `/(tabs)/create` links keep working.
- Clubs: list (Discover/Joined, search), club page (Chat · Campaigns · Leaderboard · About), create-club form.
- Home: "Your clubs" row. Profile: Passport card, Receipts & Activity, drop the "Coming soon" section.
- Scan: recognise campaign, event check-in and club invite payloads; confirm before redeeming.
- Create: QR Event and Squad options become real; optional club picker.

### Seed data

Starter clubs (NVDA, Seeker, SKR, ORE Miners) created by a script with 0 members — no invented counts.
Wording "Community around NVDAx", never official.

## Owner decisions (2026-10-05)

Claude builds backend and mobile · keep the D-39 oEmbed X check · build all P0 items · any signed-in user may start
clubs (rate-limited). Still open: production migration + deploy, and the release APK (each on Maris's go).

## Built 2026-10-05 (D-40, API contract v8)

| Item | State |
|---|---|
| Nav Home / Clubs / Scan / Drops / You; Create via Home, + buttons | Implemented |
| Clubs: discover/joined/search, create, join/leave, private + invite | Implemented, API tests |
| Club chat: send, reply, reactions, delete, pagination, polling, rate limit | Implemented, API tests |
| Club drops (`clubId`), `CLUB_MEMBER` verifier, club leaderboard | Implemented, API tests |
| Squads (COMBINED_TAPS, size 4) | Implemented, API tests |
| QR event check-in (`QR_CHECKIN`, rotatable code), scanner targets | Implemented, API tests |
| Stock Passport (derived) | Implemented, API tests |
| Receipts & Activity: new kinds, filters, settled vs completed wording, BLK ref | Implemented |
| How Blink works: 6 steps + "Private identity. Transparent settlement." | Implemented |
| "Coming soon" removed from You and Create | Implemented |
| Seed starter clubs | `scripts/seed-clubs.ts` (not run) |
| Web pages for `/e/` and `/club/` links | Not done — needs a Caddy rule on the shared VPS |
| On-device test, release APK | Not done — waiting for Maris |

## Decisions that were needed from Maris (stop conditions §46)

1. **Who builds the backend?** The mandate assigns it to Codex, but every backend change in this repo so far was
   made by Claude at Maris's request (HANDOFF). Without an active Codex, Claude does both.
2. **X verification:** keep D-39 (oEmbed, no API key, working now) or switch to the paid official X API
   (`author_id`, needs credentials and possibly paid access)?
3. **Scope for 3 days:** recommended P0 = nav, Clubs + chat (polling) + club campaigns, Passport, QR check-in,
   receipts filters, remove "Coming soon". Squads and leaderboard are the first to cut if time runs short.
4. **Tap Rush default:** change the default from 50 taps/10 s to 1,000 taps/2 min (the only window that allows
   1,000 under the 12 taps/s rule)?
5. **Who may create clubs:** anyone signed in (rate-limited) or only accounts that have funded a drop?
6. **Production migration + deploy** to the VPS, and the **release APK** — each only on Maris's go.

## Risks

- Time: Clubs + chat + squads + QR + passport is a lot of new surface for ~2 build days plus 1 stabilisation day.
- Polling chat is fine for a demo, not for many concurrent users.
- No moderation beyond owner/mod delete and rate limits; usernames/avatars are not auto-moderated (D-37).
- Low disk on the build machine (OQ-3) and a rate-limited public RPC (OQ-6) are still open.

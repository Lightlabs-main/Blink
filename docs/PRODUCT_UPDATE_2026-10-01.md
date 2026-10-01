# Product update — 1 October 2026: programmable social stock campaigns

This is a delta on `docs/MASTER_PROMPT.md`, which stays authoritative for everything this update
doesn't change. This document records:
- what exists today (verified by reading the code at commit `aac11a1`);
- what the update changes;
- how we get there with the smallest clean changes.

Status words follow MASTER_PROMPT §5.4.

> **Input note.** The update arrived in two parts. Part 2 continues §19 but is cut off again inside
> §37 ("Do not casually rewrite Codex-owned: apps/api; packages/solana; packages/xstocks; Prisma
> persistence; -"). The rest of §37 and the build-order, testing and demo sections after it have not
> been received. Items that depend on them are marked **AWAITING REST OF UPDATE**.

## 1. New positioning

**Positioning:** "Blink turns tokenized stocks into programmable social campaigns."

**Core loop:** ELIGIBILITY → ACTION → VERIFICATION → STOCK REWARD.

**Rewards:** xStocks remain the primary reward. SKR, ORE, SGT and USDC act as eligibility or
identity primitives, not hero rewards (D-18).

## 2. What already exists

| Area | State | Where |
|---|---|---|
| Creator wallet auth (Privy SIWS via MWA), email login, embedded wallets | VERIFIED on device | `apps/mobile/src/app/login/*`, `apps/api/src/auth.ts` |
| Delegated campaign treasury: creator-owned Token-2022 campaign account, exact allowance, per-campaign Privy delegate, LIVE only after onchain verification | VERIFIED on devnet (SPIKE-1, e2e) | `packages/solana/src/funding.ts`, `apps/api/src/funding-service.ts` |
| Fixed amount per person, atomic pool accounting, payouts with a separate fee payer, reconciliation, sweep, budget ledger | VERIFIED on devnet (`scripts/devnet-claim-e2e.ts`) | `claim-service.ts`, `payout-service.ts`, `claim-repo.ts` |
| Mechanics: GIFT, EARLY_CLAIM (first come), TAP_RUSH (server-timed, tap-timing checks), REFERRAL (both paid), SEEKER (SGT, one per device) | Unit/API tested; **not yet tested on a phone** | `packages/domain`, `claim-service.ts` |
| Creator studio: 4 steps (mechanic → stock → amounts and Tap Rush goal → review) | Built | `apps/mobile/src/app/(tabs)/create.tsx` |
| Participant screen: claim card, Tap Rush game, invite panel, receipt with explorer link | Built | `campaign/[id].tsx`, `features/campaign/claim-panel.tsx`, `tap-rush/[id].tsx` |
| Sharing: native share sheet, https App Links `blinksol.site/c/<id>[?ref=]`, QR | Built (App Links not yet verified on device) | `lib/format.ts`, `apps/web` |
| Home "Your rewards", Drops tab | Built | `(tabs)/home.tsx`, `(tabs)/drops.tsx` |
| Realtime | **None.** The app polls (react-query `refetchInterval`); there is no WebSocket or SSE. | — |
| Campaign timing (start/end), max-winners field | **Not built.** Winners = floor(allowance / reward). | — |
| QR event, Squads, Stock Clubs, Passport | **Not built** | — |
| Jurisdiction / compliance controls | **Do not exist.** The received MASTER_PROMPT defines none; §3 only reserves compliance release decisions for Maris. | — |
| docs/ARCHITECTURE.md, SECURITY.md, DEMO_RUNBOOK.md | Missing | — |

## 3. What this update changes, and how

### 3.1 Campaign formats (backward compatible)

Existing enum values stay. New formats are added and labels updated.

| Consumer label | Stored type | Change |
|---|---|---|
| Tap Rush | `TAP_RUSH` | Unchanged; can also be an action inside Verified Quest |
| Flash Drop | `EARLY_CLAIM` | Relabel only (first qualified wins, while stock lasts); the stored value is kept |
| **Verified Quest** | `VERIFIED_QUEST` (new) | Eligibility groups + actions + reward |
| Gift | `GIFT` | Unchanged |
| QR Event | `QR_EVENT` | **DEFERRED**, shown as "coming soon": no check-in primitive exists |
| Referral | `REFERRAL` | Unchanged; can become an action module later |
| Seeker Drop | `SEEKER` | Unchanged for existing drops; new creators pick "Verified Seeker" eligibility in a Verified Quest |
| Squad | — | P1, documented only (§6) |

### 3.2 Verifier architecture (shared contract + backend)

Domain types in `packages/domain`:
- **`VerifierType`:** `SEEKER_SGT`, `SKR_BALANCE`, `SKR_STAKED`, `SKR_TOTAL`, `ORE_BALANCE`,
  `ORE_STAKED`, `ORE_ACTIVITY` (disabled), `TAP_RUSH` (action), `X_QUEST` (BLOCKED).
- **Definition registry:** each verifier has an id, version, description, config schema,
  authority/source, chain, and read-only vs user-transaction flag.
- **Requirements:** `{ eligibility: Group[], actions: Group[] }`, where `Group = { mode: 'ALL' |
  'ANY', conditions: Condition[] }`. All groups must pass, so there is one level of ALL/ANY inside
  an implicit AND. That's enough for "Seeker AND (hold ≥ X OR stake ≥ Y) AND Tap Rush", with no
  free nesting (§6 of the update).
- **Result:** `NOT_STARTED | CHECKING | PASSED | FAILED | PENDING | ERROR | STALE`, plus evidence:
  amounts as raw strings, slot, wallet, source, checkedAt, expiresAt, failure reason.

Backend (Claude does this here, since there is no separate Codex session; see HANDOFF):
- **Storage:** campaigns get `requirementsJson` + `requirementsVersion` + `requirementsHash`, frozen
  at creation and never edited after LIVE. A new `Verification` table holds per-user, per-condition
  results with evidence, plus a TTL.
- **Endpoint:** `POST /v1/campaigns/:id/verify` evaluates every condition server-side from
  canonical chain data for the caller's Privy-verified wallets (embedded + SIWS-linked). The client
  never sends "qualified".
- **Claims:** a claim on a Verified Quest requires every group to be PASSED and fresh.
  RPC/verifier errors produce ERROR and **fail closed**.
- **SGT:** the existing D-17 verifier, reused as a condition.

### 3.3 External protocol facts (all VERIFIED 2026-10-01; see DEPENDENCIES)

- **SKR.**
  - **Mint:** `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, classic SPL Token, **6 decimals**
    (read from the mint onchain; the official sample's comment says 9, but its constant and the
    mint say 6).
  - **Staking program:** `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` (executable).
  - **Stake config:** `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw` (StakeConfig discriminator
    matches the IDL).
  - **Guardian pool in the sample:** `DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr`.
  - **Staked amount:** `UserStake.shares × StakeConfig.share_price / 1e9` (raw SKR).
  - **UserStake PDA:** `["user_stake", stake_config, user, guardian_pool]`. There is **one per
    guardian pool**, so the total stake must sum every UserStake of the user (getProgramAccounts
    filtered by discriminator + `user` at byte offset 41). The sample only reads one pool.
  - **Unstaking:** amounts are excluded from "staked" (`unstaking_amount` is separate).
- **ORE.**
  - **Mint:** `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp`, classic SPL Token, **11 decimals**.
  - **ore-stake program:** `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH` (executable).
  - **Stake account:** PDA `["stake", authority]`, a steel account (8-byte discriminator, then
    `authority: Pubkey`, then `balance: u64` = staked ORE).
- **ORE activity:** **NOT VERIFIABLE YET** (update §9). The verifier exists only as a disabled,
  feature-flagged presentation and never reports success.
- **SGT:** D-17 (official Solana Mobile checks).

### 3.4 Creator Campaign Studio (mobile)

The studio is rebuilt around the update's 7 steps:
1. Experience
2. Eligibility: Everyone, Verified Seeker, SKR holders/stakers, ORE holders/stakers, Invite-only,
   or Advanced (ALL/ANY)
3. Action
4. Reward
5. Limits
6. Review, with a plain-English summary and the maximum liability
7. Fund & launch, which reuses the existing fund flow unchanged

Rules:
- Only modules whose verifier is enabled can be picked; the others say "Coming soon".
- Amounts are raw-unit bigint (D-6).

### 3.5 Live campaign room (P0, polling)

- **Endpoint:** `GET /v1/campaigns/:id/room` returns real aggregates and events derived from
  existing tables (claims, tap sessions, verifications). Mobile polls it every few seconds while
  the screen is open; there's no new realtime stack (update §14).
- **Aggregates:**
  - joined: distinct users with a session or verification;
  - qualified;
  - rewards remaining;
  - time remaining (once timing exists);
  - Tap Rush leaderboard of best qualified taps.
- **Event names:** `PARTICIPANT_JOINED`, `REQUIREMENT_VERIFIED`, `PARTICIPANT_QUALIFIED`,
  `PAYOUT_CONFIRMED`, `CAMPAIGN_PAUSED`, `CAMPAIGN_ENDED`, all derived from real rows.
- **Identity:** public payloads show only a privacy-safe truncated wallet: no email, Privy id,
  country, compliance data or invite codes. There are no display names until a user sets one.
- **No fabricated activity.** Fixtures are allowed only behind an explicit dev flag.

### 3.6 Share → challenge (P0, mobile)

- After a PAID claim (and after a Tap Rush win), a **Challenge a friend** button opens the native
  share sheet: "I completed NVIDIA Tap Rush on Blink. Think you can beat me? <link>".
- The share text never includes balances or portfolio values. For referral drops it includes the
  user's invite code.

### 3.7 Timing and limits (shared + backend)

- **Columns:** optional `startsAt` / `endsAt` on Campaign.
- **Enforcement:** claims and Tap Rush starts outside the window are refused server-side.
- **Max winners:** stays derived from the funded allowance, so it can never exceed inventory.

## 4. Reused unchanged

- Funding and the delegated treasury
- Payout, reconciliation, sweep and budget ledger
- Auth (Privy, SIWS, MWA)
- The SGT verifier
- Tap Rush timing and tap checks
- Referral mechanics
- Rate limits
- App Links
- The website

## 5. Explicitly deferred or blocked

- **X_QUEST:** BLOCKED / POLICY_REVIEW_REQUIRED (update §19). Only a disabled extension point
  exists; no like/repost/follow rewards, and no scraping or credentials.
- **ORE_ACTIVITY:** disabled until the exact onchain evidence is specified and tested (update §9).
- **In-app SKR staking:** P1, not in this pass.
- **Squads, Stock Clubs, Stock Passport:** P1/P2. Domain notes only; nothing is presented as
  functional.
- **QR Event:** deferred; there is no check-in primitive yet.
- **Compliance / jurisdiction controls:** **BLOCKED for mainnet.** The update says existing controls
  are mandatory, but none exist in the received spec or code. Verified Quest adds no route around
  them because there are none to route around. Mainnet distribution must wait until Maris defines
  them (the master-prompt sections are presumably still missing).
- **Fiat-equivalent input with snapshot rules:** the update refers to MASTER_PROMPT rules that are
  not in the received sections, so entry stays share-denominated.
- **SKR total-stake lookup across all guardian pools** uses getProgramAccounts. The public mainnet
  RPC rate-limits heavily (OQ-6), so a dedicated RPC is needed for reliable results. Until then the
  verifier returns ERROR, never a false PASS or FAIL.
- **Anything after the truncation point:** AWAITING REST OF UPDATE.

## 6. Part 2 (§19–§37): what it changes

### 6.1 Compliance (§21): the main new P0 blocker

- **Status:** `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION = BLOCKED` (SECURITY.md §1, D-19).
- **Restriction list:** re-verified 2026-10-01. US, US persons, the UK and "unlawful or
  unauthorized" jurisdictions are confirmed word for word on official xStocks pages. Canada,
  Australia and sanctioned jurisdictions are blocked conservatively but not yet seen word for word;
  the issuer's full list is at `assets.backed.fi/legal-documentation`.
- **To build:**
  - a server-side xStocks eligibility gate before **every** reward reservation and before creator
    funding;
  - a minimal eligibility record (normalized country result, eligible yes/no, policy id and
    version, timestamp, method, reason);
  - mobile UX to establish eligibility.
- **NEEDS_OWNER_DECISION:** the method for establishing eligibility. Options: self-declared
  country + not-a-US-person attestation; IP-country signal as a cross-check (no precise location);
  a third-party KYC provider. The update requires minimum data, so the method is Maris's call.

### 6.2 Verification timing (§20)

Current onchain state, evaluated immediately before reservation. No locking, no monitoring, and no
"hold for N days". Recorded in SECURITY.md §2.

### 6.3 Security additions (§22)

Recorded in SECURITY.md §2.

**Gap: there is no global payout kill switch.** The update calls one "existing" and mandatory. Today
the only off-switches are the mainnet flags (mainnet only) and the per-campaign PAUSED state. To
add: `PAYOUTS_ENABLED` (env, default true), checked before every reservation and send, reported in
`/v1/status`.

### 6.4 Payout architecture (§23) and treasury invariants (§24)

Unchanged (creator-owned delegated treasury, no program, same budget). How the invariants map to
the code:

- `reservedRaw + paidRaw` is stored as `Campaign.claimedRaw`, and the database CHECK keeps it at or
  below `allowanceRaw` (= the original delegated amount).
- `availableRaw = allowanceRaw − claimedRaw`. Dust is the leftover below one reward and is never
  paid.
- LIVE requires the onchain delegated amount to equal the allowance and the balance to cover it,
  so the maximum payout is fully funded.
- Verifiers only decide who may receive a reward; they never add inventory.

### 6.5 State names (§25, §26): preserve, map, don't fork

**Campaign.** Existing: `DRAFT → AWAITING_FUNDING → AWAITING_DELEGATION → LIVE ↔ PAUSED → ENDED →
CLOSED`. The update's names map like this:

| Update | Existing equivalent |
|---|---|
| VERIFYING_FUNDING | `AWAITING_DELEGATION` (the funding verify step) |
| UNDERFUNDED | `PAUSED` + `INSUFFICIENT_BALANCE` |
| DELEGATE_REVOKED | `PAUSED` + `DELEGATION_REVOKED` / `DELEGATE_CHANGED` |
| ASSET_PAUSED | `PAUSED` + `MINT_STATE_CHANGED` |
| FUNDING_FAILED | stays `AWAITING_FUNDING` with an error |
| SETTLING | not modelled; nothing to settle under the delegate model until revoke/close flows exist |
| CANCELLED | `CLOSED` from DRAFT |

Verified Quest uses the same machine.

**Claim.** Existing: `RESERVED → SENDING → PAID`, plus `FAILED` (released, retryable). The update's
names map like this:

| Update | Existing equivalent |
|---|---|
| ELIGIBLE | requirements PASSED (verification layer), before any claim row exists |
| BUILDING_TX | `RESERVED` |
| SUBMITTED / CONFIRMING | `SENDING` |
| CONFIRMED | `PAID` (confirmed commitment) |
| FINALIZED | not tracked separately |
| FAILED_RETRYABLE | `FAILED` |

**UI copy follows §26:** "Requirement complete", "Qualified", "Reward reserved", "Sending on
Solana…", "Received". The current "Sending X…" and "You got X" copy will be aligned.

### 6.6 Authentication (§27)

Unchanged. The UI will distinguish "wallet connected" from "wallet verified" (SIWS).

### 6.7 SKR and ORE notes (§28, §29)

Recorded in VERIFIER_ARCHITECTURE.md with source labels ([official], [onchain], [inference]):
- SKR decimals are read from the mint, not hardcoded;
- SKR stake is aggregated across all guardian pools, with the required tests listed;
- ORE stake checks owner program, PDA, authority, raw balance, decimals and network;
- ORE activity stays disabled.

### 6.8 UI (§30–§32)

- **Direction:** premium consumer and clean fintech. No neon, no dashboards. This lines up with
  Maris's earlier wish to restyle the app in the website's broadsheet style; the restyle can follow
  the same direction.
- **Home and Discover:** add filters only where backed by working functionality.
- **Verified Quest participant UX:** every requirement shown separately with its own state and
  call to action; "Qualified" only after the server says so.

### 6.9 Live room (§33) and share (§34)

Same as §3.5 and §3.6 above.

- **Polling is confirmed acceptable** for P0.
- **Links:** they use the existing `https://blinksol.site` origin (D-15). The Android App Links
  fingerprint in `assetlinks.json` was **read from the signed APK**, not fabricated. Custom-scheme
  links stay supported.

### 6.10 Squads, Clubs, Passport (§35)

Roadmap only until P0 is stable.

### 6.11 Shared domain types (§36)

Existing types are extended rather than duplicated:
- `CampaignType`, the claim types and `ClaimSummary`;
- new: `VerifierType`, condition/group/requirements, result + evidence summary, public participant
  identity, room DTO, campaign timing.

Sensitive evidence stays in backend-only types.

### 6.12 Ownership (§37, partial)

Part 2 says Codex owns `apps/api`, `packages/solana`, `packages/xstocks` and Prisma, and that
Claude must not casually rewrite them. **The rest of §37 hasn't been received.**

Context: no Codex session has worked in this repository. At Maris's direction (2026-09-30 →
10-01), Claude built the claims, payouts and Seeker backend in those directories, and each step is
recorded in HANDOFF.md. **Before more backend work in Codex-owned paths, the rest of §37 decides
whether Claude continues there or only writes HANDOFF specs.** AWAITING REST OF UPDATE.

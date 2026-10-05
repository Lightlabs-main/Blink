# Decisions

## D-1 — Mobile base = `sample-expo-kit-privy` (2026-09-29, Maris)

This is the official Solana Mobile Expo + Privy + Solana Kit + MWA sample, and the only CLI template
with Expo + Kit + Privy.

## D-2 — Android identity locked (2026-09-29)

- Package: `com.blinktostock.app`
- Scheme: `blinktostock`

The sample's placeholders were replaced:
- Privy SIWS `domain` is `blinktostock` and `uri` is `blinktostock://privy-login`.
- MWA identity is `{ name: 'Blink-to-Stock', uri: 'blinktostock://app' }`.

Do not rename after Privy registration.

## D-3 — Creator auth = Privy SIWS via MWA (2026-09-29, Maris correction)

The mobile app uses `useLoginWithSiws().generateMessage` → MWA `signMessages` → `login`. Privy owns
the nonce, expiry, domain and signature verification. The backend:
1. verifies the Privy access token (`utils().auth().verifyAccessToken`);
2. loads the user (`users()._get`);
3. accepts only linked accounts with `type=wallet`, `chain_type=solana`, `wallet_client≠privy` and
   `verified_at>0`.

The body never carries a creator wallet. The `X-Creator-Wallet` header only *selects* among
verified wallets.

- **Open (Codex, §25):** confirm that Privy's nonce is single-use and short-lived. If §25's
  requirements must be proven independently, that needs Privy documentation evidence.

## D-4 — Override `@privy-io/node`'s optional `@solana/kit` peer to 8.4.0 (2026-09-29)

Privy declares an optional peer `@solana/kit ^5.1.0`. npm installed 5.5.1 next to the API, which
broke type identity with our 8.4.0 RPC objects. We use only Privy's auth, users and wallet-RPC APIs,
which take serialized transactions rather than kit types, so root `overrides` pins kit to 8.4.0.

- **Risk:** Privy x402/Solana helpers built for kit 5 might misbehave. We don't use them.
- Re-check when upgrading Privy.

## D-5 — Rent estimation uses the Token-2022 program itself (2026-09-29)

The account size comes from simulating `GetAccountDataSize` (sigVerify=false,
replaceRecentBlockhash=true; nothing signed or sent), followed by `getMinimumBalanceForRentExemption`.
We don't maintain our own mint→account extension table. Result for NVDAx: 175 bytes.

## D-6 — Amounts are raw u64 bigint end-to-end (2026-09-29)

- API: decimal strings. DB: `Decimal(20,0)`. Code: `bigint`.
- Scaled UI conversion uses exact fractions and rounds **down**; it's display-only.
- The Token-2022 JS Scaled UI helpers use floats and must not feed transactions.
- Zod `rawAmount` uses a single guarded refine, because Zod 4 continues evaluating checks after a
  failure (`BigInt('1.5')` would otherwise throw).

## D-7 — Mobile is excluded from the npm workspaces for now (2026-09-29)

Installing mobile dependencies needs several GB; the disk has under 1 GB free. Revisit once the
machine is prepared. Expo supports npm workspaces.

## D-8 — API port default 4310, host 127.0.0.1 (2026-09-29)

Configurable via `API_PORT` / `API_HOST`. Check the VPS for collisions before deploying.

## D-9 — Build the APK with EAS Build, not on the VPS (2026-09-29)

The VPS has 2 vCPU, about 2.6 GiB of available RAM and no swap, and runs about 20 other services.
A Gradle Android build could exhaust memory and take other projects down, which violates VPS
isolation. The local PC has under 1 GB of disk. Expo's EAS Build compiles in the cloud.
(NEEDS_OWNER_DECISION: an Expo account is required.)

## D-10 — Runtime: Node 22 to match the VPS (2026-09-29)

The VPS global Node is v22.23.1, so `.nvmrc` is 22.23.1. All dependencies support
`^22.12` (vitest engines verified). Local development on Node 26 also works.

## D-11 — Expo / EAS project linkage (2026-09-29)

- Expo owner: `marisdigitals11s-team`
- Slug: `blink` (it must match the Expo project; it is independent of the Android package)
- projectId: `7dd3f562-b06d-4ec5-adb4-8f8a3f6bf90a`

The Privy App ID and Client ID are public identifiers, so they live in `apps/mobile/eas.json`
profile `env`. EAS builds don't rely on the git-ignored local `.env`.

`EXPO_TOKEN` (a personal access token) lives only in the VPS `.env`.

Build profiles: `development` (dev client APK), `preview` and `production` (APK). Free plan:
15 Android builds a month; the account is blocked, not billed, when they run out.

## D-12 — Wallet-facing transaction rules (2026-09-29, from on-device testing)

1. **Simulate before opening MWA.** Every Blink-built transaction is simulated server-side on the
   target cluster (sigVerify=false) and must succeed before the app asks the wallet to sign. A
   wallet preview error ("Unexpected error when analyzing the transaction") is treated as a UX bug.
2. **Cluster consistency.** The app's MWA cluster must match `SOLANA_CLUSTER` from the backend.
   The UI never infers it (§22).
3. **The MWA identity URI is the HTTPS origin `https://blinksol.site`**, with icon `icon.png`, so
   wallets display a real, verifiable origin. Done 2026-09-30 (D-15).

## D-13 — Claims, Tap Rush and payouts (2026-09-30, owner-approved ASSUMPTIONS)

The MASTER_PROMPT sections on claims, Tap Rush, FOMO ordering and payouts have not arrived. Maris
approved building them now on devnet with these rules. Each rule is an **ASSUMPTION** to replace
when the real sections arrive.

1. **Fixed amount per person.** The creator sets `rewardPerClaimRaw`. Claims are first come, first
   served until the pool (`allowanceRaw`) cannot fit another reward.
2. **One reward per Privy account and per recipient wallet per campaign.** The creator cannot claim
   their own drop, by Privy user or by wallet.
3. **Rewards go only to the caller's Privy embedded wallet.** Privy supplies the address, never the
   client.
4. **Claimable mechanics:** GIFT, EARLY_CLAIM and TAP_RUSH. REFERRAL and SEEKER can't be created
   in the app and return `NOT_CLAIMABLE` until their rules are specified.
5. **Tap Rush.** The server starts the round. A result counts only if it arrives at least
   `seconds − 0.5 s` and at most `seconds + 120 s` after the start, with no more than 20 taps per
   second. `goal` taps qualifies for one claim, and each qualifying round can be used once. There
   are 10 rounds per user per campaign. Defaults: 50 taps in 10 s; the app offers 30 / 50 / 80.
   **Known limit:** the tap count comes from the client, so a modified app could fake a result
   within these bounds. Before mainnet, Tap Rush needs a stronger proof or a lower-value design.
6. **Pool accounting.** `Campaign.claimedRaw` (reserved + paid) only moves through conditional
   updates in the same database transaction as the claim row. A `CHECK` constraint keeps it
   between 0 and `allowanceRaw`.
7. **Payout transaction.** CreateAssociatedTokenIdempotent (payer: fee payer) followed by
   TransferChecked from the campaign account, with the per-campaign Privy delegate as authority
   (§9, §14). It is simulated first (D-12).
8. **Fee payer (§16).** A separate Privy server wallet per cluster, created once and stored in
   `ServiceWallet`. It holds no stock and no delegate authority. On devnet the API requests an
   airdrop when it falls below 0.05 SOL.
9. **No double pay.** The fee payer's signature (the transaction id) is stored before sending. A
   SENDING claim becomes PAID when confirmed, or FAILED (releasing its reservation) only after its
   blockhash has expired unseen. Retries never build a second transfer for a claim that could
   still land.
10. **Budget (§7).** Each payout reserves its estimate in `BudgetLedgerEntry`: 10,000 lamports in
    fees, plus recipient-account rent when the account is created. On mainnet a reservation is
    refused above the budget, and the MAINNET flags are required. Other clusters are recorded
    only.
11. **Automatic pause (§9).** Before every payout the onchain delegation is re-checked, along with
    the mint's pause and transfer-hook state. A drop that can no longer pay out moves to PAUSED
    with a reason. There is no resume flow yet.

## D-14 — Tap Rush timing checks, Referral drops, resume and sweep (2026-09-30, owner-approved ASSUMPTIONS)

1. **Tap Rush anti-cheat.** The app sends each tap's time in ms since the round started, not just
   the count. The server rejects a round when any of these fail:
   - the count doesn't match the times;
   - a time falls outside the round, or the times are out of order;
   - more than 5% of the gaps between taps (minimum 1) are under 25 ms;
   - more than 20 taps land in any one second;
   - with 10 or more gaps, their coefficient of variation is under 0.05 (metronome-perfect).

   The rejection reason is stored on `TapRushSession.rejectReason`.
   **Limit:** this stops simple scripts. A determined attacker can still fake human-like timings.
   Real protection needs device attestation (Play Integrity), which is not built.
2. **Referral.** Anyone signed in except the creator can get a personal 8-character invite code
   (`?ref=` on the campaign link).
   - A friend can claim a REFERRAL drop only through someone else's code.
   - The friend and the referrer each get the fixed reward. The referrer is paid once, for the
     first friend. Later friends still get their own reward.
   - Both rewards are reserved together. If the pool can't fit both, the friend's claim is
     refused rather than overdrawing.
   - The bonus is paid only after the friend's reward is confirmed. A failed bonus can be resent
     by the referrer.
   - Anti-sybil is the same as other mechanics: one per Privy account and one per wallet.
3. **Resume.** The creator can put a PAUSED drop back to LIVE once the onchain delegation and mint
   checks pass again (§9). A paused drop with less than one reward left moves to ENDED instead.
4. **Sweep.** Every 60 s the API confirms SENDING payouts and releases RESERVED claims older than
   2 minutes, so claims don't get stuck when nobody is watching.

## D-15 — Domain blinksol.site (2026-09-30, Maris)

- **API:** `https://api.blinksol.site`. The interim sslip.io host stays as an alias so older
  builds keep working.
- **Website:** `https://blinksol.site`, served from `apps/web`.
  - `/` is the landing page.
  - `/c/<id>[?ref=CODE]` is the campaign page. It opens the app when installed and offers the APK
    otherwise.
  - `/api/*` proxies the API on the same origin, so the site needs no CORS.
  - `/download/blink-to-stock.apk` serves the current release APK. It is hosted on the server
    only, not in git.
- **Shareable links and QR codes** are now `https://blinksol.site/c/<id>`: verified Android App
  Links, via `/.well-known/assetlinks.json` with the SHA-256 of the EAS default keystore. The
  scanner still accepts the old `blinktostock://campaign/<id>` codes.
- **Caddy:** Blink added its own site blocks after backing up the shared Caddyfile, and
  validated the config before reloading.

## D-16 — Mainnet readiness: network from the server, monitoring, throttling, disclosure (2026-10-01)

1. **Network.** The app reads the cluster from `GET /health` and connects wallets to it (D-12). One
   APK follows the server from devnet to mainnet. If the server can't be reached, the app waits
   rather than guessing.
2. **Fee payer monitoring.** `GET /v1/status` shows the fee payer, its balance and a `low` flag
   (below `FEE_PAYER_LOW_LAMPORTS`, default 0.01 SOL). The API also logs "FEE PAYER LOW" at most
   once an hour.
3. **Throttling.** Mutating recipient routes are limited to 30 requests a minute per user and 120 a
   minute per IP, in memory. The real client IP comes from Caddy's X-Forwarded-For, trusted from
   loopback only.
   - **Optional anti-sybil cap:** `CLAIMS_PER_IP_PER_CAMPAIGN` limits successful claims per IP per
     drop within 24 h. It's off by default because demo rooms share one IP.
4. **Issuer disclosure (OQ-5, DRAFT wording).** `PRODUCT_COPY.issuerControlStatement` appears on
   the claim card, the creator review step and the website.
5. **Payout hardening, from self-review:**
   - A claim is only sent if it is still RESERVED when the signature is recorded (compare-and-set),
     so a reservation released as stale during slow signing can never also be paid.
   - "Never landed" now requires 32 blocks past `lastValidBlockHeight`.
6. **Smoke test and preflight.** `scripts/smoke-mainnet.ts` is a dry run by default and needs
   `--execute` plus the MAINNET flags to pay; see `docs/MAINNET_SMOKE_TEST.md`.
   `scripts/mainnet-preflight.ts` measures real recipient-account rent (OQ-7) but needs a dedicated
   RPC: the public one returns 429.

## D-17 — Seeker drops (2026-10-01)

- **Rule:** only Solana Seeker owners can claim, and each phone claims once per drop.
- **Proof of wallet control:** Privy SIWS, the wallet linked and verified to the user (same flow as
  creators; OQ-8 applies).
- **Proof of Seeker ownership:** an SGT in one of the user's verified external wallets. These
  checks were VERIFIED 2026-10-01 against Solana Mobile's official SGT page
  (docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) and its `solana-mobile-dev-skill`
  reference:
  - mint authority `GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4`;
  - MetadataPointer authority equals that authority, and the metadata address is
    `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`;
  - TokenGroupMember group is `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`, and its member
    record names the mint;
  - empty token accounts are skipped.

  Both GT2z and GT22 were confirmed to exist on mainnet (GT22 is a Token-2022 mint).
- **Lookups:** standard RPC (§20 option A), always on mainnet via `SEEKER_RPC_URL` →
  `XSTOCK_READ_RPC_URL` → the public endpoint. The verifier refuses a non-mainnet RPC.
- **Claims** store `sgtMint`, unique per campaign, so one device gets one claim. The reward still
  goes to the user's Blink (Privy embedded) wallet.

## D-18 — Product update: programmable social stock campaigns (2026-10-01, Maris)

Source: Maris's product + architecture update of 2026-10-01. The plan is in
`docs/PRODUCT_UPDATE_2026-10-01.md`.

1. **Positioning:** "Blink turns tokenized stocks into programmable social campaigns." Core loop:
   ELIGIBILITY → ACTION → VERIFICATION → STOCK REWARD. Never claim Blink invented stock gifting by
   link, and don't describe it as just a quest platform.
2. **xStocks remain the primary reward.** SKR is a membership/staking/eligibility primitive, ORE an
   onchain community/activity primitive, SGT a verified Seeker identity, and USDC at most a
   funding/accounting primitive. Use legally accurate xStocks wording: holding a token does not make
   someone the registered shareholder.
3. **Formats stay recognizable and backward compatible.** VERIFIED_QUEST is added. EARLY_CLAIM is
   presented as "Flash Drop" while keeping its stored value. QR Event and Squads are deferred.
4. **Verifiers are reusable server-side modules** with a type, version, config schema, source, chain
   and evidence. Requirements are groups of ALL or ANY conditions, all groups required, with no
   deeper nesting. A LIVE campaign's requirements are immutable (version + hash). The server is
   authoritative and **fails closed**.
5. **ORE_ACTIVITY is disabled** until deterministic, replay-safe evidence is specified and tested.
6. **X_QUEST is BLOCKED (policy review).** No like/repost/follow-for-stock, no scraping, and never
   ask for X credentials.
7. **Social P0:** a live campaign room (polling, real aggregates only, privacy-safe identities) and
   share → challenge. Squads, Stock Clubs and Passport are P1/P2, documented and not faked.
8. **No new compliance bypass.** No jurisdiction controls exist yet, so mainnet distribution stays
   BLOCKED until Maris defines them.

## D-19 — xStocks compliance gate; public mainnet distribution BLOCKED (2026-10-01, Maris update §21)

- **`MAINNET_PUBLIC_XSTOCK_DISTRIBUTION = BLOCKED`** until a Blink eligibility mechanism exists and
  Maris approves it. A controlled mainnet smoke test with one eligible participant still needs
  Maris's explicit approval.
- **Policy** `XSTOCKS-ELIGIBILITY-2026-10-01` v1 is in SECURITY.md §1, with each restriction's
  source and status. Re-verify it against the issuer's list before release.
- **The gate is separate and mandatory** for every recipient and creator path. No verifier
  (Seeker, SKR, ORE, Tap Rush) implies it.
- **Minimum data.** Compliance state never appears publicly.
- **The eligibility method is NEEDS_OWNER_DECISION** (PRODUCT_UPDATE §6.1).
- **Gap:** a global payout kill switch (`PAYOUTS_ENABLED`) is required and will be added
  (PRODUCT_UPDATE §6.3).

## D-20 — xStocks eligibility method: self-declaration + IP-country cross-check (2026-10-01, Maris chose option b)

- **Declaration.** The user declares their country of residence and attests "I am not a U.S.
  person and I am not in the United States". Ukraine adds "not in an occupied region".
- **Decision.** The server decides with `evaluateXStockEligibility` (`packages/domain`, policy
  `XSTOCKS-ELIGIBILITY` `2026-10-01.1`), cross-checking the country of the request IP. The lookup
  is offline (`geoip-country`), so no IP is stored or sent anywhere.
- **Stored per user:** declared country, attestations, IP country (code only), eligible yes/no,
  reason, policy id and version, method, and decision time.
- **Gate.** Before every reward reservation, every Tap Rush start, every bonus retry and creator
  funding, the stored decision must be current and eligible, **and** the current request's IP
  country must be allowed. An unknown IP country fails closed.
- **Referrers** need a stored eligible decision for their bonus; otherwise only the friend is paid.
- **Config.** `XSTOCK_COMPLIANCE=enforce` is the default and is mandatory on mainnet (refused at
  startup otherwise). Tests of claim mechanics run with `off`, and the gate has its own tests.
- **Restriction list** (SECURITY.md §1) comes from the issuer's restricted-countries page
  (assets.backed.fi, VERIFIED 2026-10-01) and xStocks disclaimers. Canada and Australia are blocked
  conservatively. **The issuer lists Nigeria as non-serviceable.**
- **Payout kill switch** `PAYOUTS_ENABLED` (default true): when false, no Tap Rush starts, no
  reservations and nothing sent. Shown in `/v1/status`.
- **Copy.** xStocks are described as tokenized tracker certificates giving economic exposure (no
  registered shares, no voting rights) across the app and website.

## D-21 — Verified Quests, live room, challenge sharing, campaign window (2026-10-02, product update P0)

- **`VERIFIED_QUEST`.**
  - Requirements are `{ eligibility[], actions[] }` groups of ALL/ANY allowlisted verifiers (registry
    in `packages/domain`).
  - Validated at creation: ENABLED verifiers only, kind-correct placement, positive raw minimums.
  - Frozen with a SHA-256 hash; there is no edit endpoint.
- **Evaluation** happens server-side in `QuestService`:
  - only Privy-verified wallets (SIWS-linked + embedded) are read;
  - SKR/ORE come from mainnet via `MainnetChainReader` (genesis check + mint-decimals check), and
    amounts are summed across the user's verified wallets;
  - Seeker uses D-17, Tap Rush uses an unused qualified round.
  - Any read error → `ERROR`, which never qualifies.
  - A claim re-evaluates immediately before reservation (update §20) and consumes the qualifying
    Tap Rush round.
- **Readers** (`packages/solana/stake-readers.ts`):
  - **SKR staked** sums every UserStake for the user across guardian pools (getProgramAccounts with
    a discriminator + config + user filter), checking owner program, user, config and the
    re-derived PDA for each.
  - **ORE staked** reads the `["stake", owner]` PDA, checking owner program and authority.
  - The StakeConfig offsets were validated against live mainnet: mint and vault match the docs.
- **ORE_ACTIVITY is DISABLED and X_QUEST BLOCKED.** Both are visible in the studio as
  "Soon"/"Unavailable" and refused by validation.
- **Campaign window.** `startsAt` / `endsAt` (the studio offers no end, 1 h, 24 h, 3 d, 7 d).
  Claims and Tap Rush outside the window get `NOT_STARTED` / `CAMPAIGN_OVER`.
- **Live room.** `GET /v1/campaigns/:id/room`, polled every 4 s, derived only from real rows (tap
  sessions, quest checks, claims):
  - joined, qualified, rewards remaining;
  - a Tap Rush leaderboard (best accepted score per player);
  - events.

  Identities are truncated Blink wallets; nothing else is public. Quests without a score have no
  leaderboard.
- **Challenge a friend.** A native share of an achievement plus the canonical `blinksol.site/c/<id>`
  link; balances are never shared.
- **Claim wording follows §26:** "Requirement complete", "Qualified", "Reward reserved", "Sending …
  on Solana", "Received".
- **Creator studio.**
  - Steps: experience → (quest: eligibility, action) → reward → limits → review → fund.
  - Flash Drop is the label for `EARLY_CLAIM`; QR Event and Squad show "Soon"; the legacy SEEKER
    type stays claimable but isn't offered for new drops (use a quest with Verified Seeker).
  - Drops filters list only formats that have live drops.

## D-22 — Nigeria allowed in the xStocks eligibility policy (2026-10-02, Maris — owner override)

- **The fact.** Backed's restricted-countries page lists Nigeria under "Non-Serviceable Countries"
  ("Backed does not service individuals or entities from these countries"). This was re-checked on
  2026-10-02.
- **Maris's decision:** allow Nigeria. His reasoning:
  - he is in Nigeria and holds xStocks on Solana without restriction;
  - onchain holding and trading is permissionless;
  - the update's own restriction list (§21) names the US, UK, Canada, Australia and sanctioned
    jurisdictions, not Nigeria;
  - Backed's list is read as applying to Backed's own services.
- **Risk.** Official docs make distributors responsible for compliance, and Maris accepts that risk.
  **Recommended before public mainnet launch:** written confirmation from xStocks or Backed.
- **Policy** version bumped to `2026-10-02.1`, so earlier decisions are outdated and users confirm
  again.
- **Devnet.** `XSTOCK_COMPLIANCE=off` on the devnet server only, because the test asset is not an
  xStock. Mainnet refuses to start unless the gate is `enforce` (D-20).

## D-23 — In-app SKR staking (2026-10-02, Maris: "in-app SKR staking (P1) … build this")

- **What:** stake, unstake, cancel unstake and withdraw SKR with Solana Mobile's guardian pool
  (`DPJ58…buqr`, the official sample's default) from a Blink screen (`/skr`). Entry points: Profile, and a
  "Stake SKR in Blink" action on a failed SKR_STAKED / SKR_TOTAL quest requirement.
- **Custody:** none. The server reads mainnet, builds the transaction from the official IDL and **simulates it**;
  the user's own wallet is fee payer and only signer and sends it through MWA `signAndSendTransactions` on
  `solana:mainnet`. Blink never holds, moves or sends SKR, and sends no mainnet transaction itself.
- **Which wallets:** only wallets Privy verified for the caller (SIWS-linked); anything else gets 403
  `WALLET_NOT_LINKED`. The app also refuses to continue if the wallet app authorizes a different account.
- **Mainnet always**, whatever cluster the drops run on, because SKR exists only there. The server checks the
  mainnet genesis hash and that the StakeConfig's mint and vault match before building anything.
- **Labelling:** the screen says "Mainnet · real SKR"; rewards and the 48 h cooldown are Solana Mobile's.
- Not built: choosing another guardian pool (there is one official default).

## D-24 — Push notifications (2026-10-02, Maris: "push notifications … build this")

- **Events:** reward received (claim PAID), invite bonus received (REFERRAL_BONUS PAID), the creator's drop
  went LIVE. Each fires once (on the compare-and-set transition), carries no wallet address or secret, and
  opens an in-app route only (`/home`, `/campaign/:id`).
- **Path:** app registers an Expo push token (permission asked once on sign-in) → `POST /v1/me/push-token`
  → `PushToken` table (one row per device; signing in elsewhere moves it) → server sends through the Expo push
  service. `DeviceNotRegistered` tokens are deleted. Sign-out deletes the device's token.
- **Failure never matters to money:** sending is fire-and-forget and swallows errors, so a push outage cannot
  affect a payout or a go-live.
- **Owner action needed (Android):** a Firebase project and its `google-services.json` + FCM v1 key in EAS
  (DEPENDENCIES.md). Without it the build still works; notifications show as unavailable.

## D-25 — The app adopts the broadsheet design (2026-10-02)

The app now uses the website's "financial broadsheet" system (D-18 follow-up): newsprint paper and ink,
Instrument Serif headlines, Newsreader text, IBM Plex Mono labels, square corners, lime only as a highlighter
(primary-button offset block, Scan button, Tap Rush target). Day or Night edition follows the system setting at
launch. Legacy token names were kept (`lime` = ink accent) so every screen follows without rewrites.
Announced-but-unbuilt features (Squads, Stock Clubs, Stock Passport, QR Event check-in, ORE mining checks) are
listed under Profile → "Coming soon" with a Soon badge and no actions.

## D-26 — Removing a linked Solana wallet goes through the server (2026-10-02)

Privy's Expo SDK (`@privy-io/expo` 0.65.5) only has `useUnlinkWallet`, which validates Ethereum addresses, so
removing a Solana creator wallet in the app failed with "Invalid Ethereum address". New route
`DELETE /v1/me/wallets/:address` (auth, throttled) unlinks one of the caller's own SIWS-linked wallets through the
Privy server API (`users().unlinkLinkedAccount`). The app uses it from the next build. Also: the most recently
linked wallet is now listed first, so Create funds from the newest wallet.

## D-27 — Funding always opens a fresh, network-named wallet session (2026-10-02)

Found on device: Solflare (also the Seeker wallet) showed "Network mismatch … this transaction is for mainnet" when
funding a devnet drop. With a saved auth token, the MWA library sends an older-protocol wallet a `reauthorize`
that carries no network, so the wallet assumes mainnet. Funding now runs `authorize({ chain, identity })` without
the saved token in the same session as `signTransactions`, and checks the authorized account is the campaign's
creator wallet. Ships with the next APK.

## D-28 — Accept harmless wallet additions to the funding transaction (2026-10-02)

Found on device: Phantom signed the funding transaction but changed it (it adds priority-fee and "Lighthouse"
assertion instructions), so the exact-bytes check refused it every time. The check now decodes both messages and
requires the same fee payer, the same signers, no address lookup tables and exactly Blink's instructions in
order; the only extra instructions allowed are Compute Budget and Lighthouse, which cannot move tokens. The
funded account is still verified on-chain before a drop goes LIVE.

## D-29 — Build the funding transaction at signing time (2026-10-02)

Root cause of the repeated "Blockhash not found" when funding with Phantom: the app built the transaction when the
creator tapped Fund and re-used it for every "Open wallet" tap. A Solana blockhash lasts about 60–90 s, so reading
the summary plus approving in the wallet expired it, and every retry re-sent the same expired transaction. The
app now prepares a fresh transaction inside the wallet session, after the connection is approved and right before
`signTransactions`. The server answers an expired Blink blockhash with `EXPIRED` (clear message) and only treats an
unknown wallet-replaced blockhash as RPC lag (retried) or a wrong network.

## D-30 — The Blink logo (2026-10-02, from Maris)

Source: `docs/brand/blink-logo-source.jpg`; transparent mark: `docs/brand/blink-mark.png`. Generated (script in
the session scratchpad, reproducible from the source): app icon (mark on ink `#141210`), Android adaptive icon
(foreground inside the safe zone, ink background, monochrome themed icon), splash, white notification icon, the
website icon/favicon (also the icon wallets show for Blink), and `logo-tile.png` for in-app use. The mark is
cream + lime, so it always sits on an ink tile, in both Day and Night editions. Ships to phones with the next APK;
the website and wallet pop-ups use it now. The developer-only "Wallet lab" row is hidden in release builds.

## D-31 — The app's look is built from the logo (2026-10-02, Maris: "Match the logo")

Replaces the broadsheet look in the app (D-25). Ink black `#0D0D0B`, cream `#F4F0E6` and the logo's lime
`#ABFF1A`; Night (ink) is the default and Day (cream, white cards) follows the system setting. Bricolage
Grotesque headlines, DM Sans text, DM Mono numbers (only the used weights are bundled). Soft rounded cards
(20 px), pill buttons and chips, round icon containers, sentence-case labels, no dashed boxes or offset shadows.
Lime is an accent only: the logo's dot on hero cards, the active-tab dot, the Scan button, completed steps and the
Tap Rush target. Primary buttons are cream on ink (ink on cream in Day). The website keeps the broadsheet design
for now.

## D-32 — Send and Receive in the Blink stock wallet, fees paid by Blink (2026-10-03, Maris)

- **Receive:** the stock wallet's address, QR code and share sheet (Profile → Stock wallet, Home → Wallet).
- **Send:** SOL or any supported xStock (devnet: tNVDAx) to any Solana address. Stock wallets usually hold no SOL,
  so Blink's fee payer (the §16 Privy server wallet) pays the network fee and, when needed, the recipient's
  token-account rent. The server builds and simulates the transfer (`POST /v1/me/send/prepare`); the app signs the
  message bytes with the Privy embedded wallet (exactly what Privy's provider does for a transaction); the server
  accepts back only the identical message for that user, adds the fee-payer signature and sends it
  (`POST /v1/me/send/submit`). `GET /v1/me/wallet` returns balances read live.
- **Guards:** the global kill switch (`PAYOUTS_ENABLED`) also pauses sends; 20 sends per user per day; budget
  ledger entries of kind `SEND` (mainnet budget cap applies); xStock sends follow the D-20 eligibility gate when
  enforced; frozen or paused mints are refused; SOL sends may not leave less than the rent-exempt minimum.
- **Verified on devnet** with `scripts/devnet-send-e2e.ts`: a wallet with 0 SOL sent test stock to a new wallet,
  Blink paid the fee and rent, and tampered or over-balance sends were refused.

## D-33 — ORE mining quest action (2026-10-03, Maris: "yes add it")

- **Rule:** "mined ORE after the campaign started". At creation the server reads the ORE `Board.round_id` (the
  round being mined) and stamps it on every `ORE_ACTIVITY` condition as `afterRound` before the requirements are
  hashed and frozen. A participant passes when any of their verified wallets has `Miner.round_id` (the last round it
  deployed in) greater than `afterRound`. Mining from before the campaign can never count, a wallet that never
  mined reads 0, and an unreadable chain is `ERROR` (fails closed). Creators cannot set `afterRound` (strict schema).
- **Source:** regolith-labs/ore (`api/src/lib.rs` program id, `state/mod.rs` discriminators Miner 103 / Board 105
  and seeds, `state/miner.rs`, `state/board.rs`). Layout VERIFIED against live mainnet accounts 2026-10-03
  (Miner 752 bytes, authority @8, round_id @664 matching the current board round for active miners).
- **Farming:** a wallet can only be linked to one Privy account, and each account claims once per drop.
- Profile no longer lists "ORE mining checks" under Coming soon.

## D-34 — The website matches the logo too (2026-10-03)

blinksol.site drops the broadsheet design (D-18) for the same system as the app (D-31): ink/cream with the lime
dot, Bricolage Grotesque, DM Sans, DM Mono, rounded cards and pill buttons, light/dark following the system with a
toggle. Content, live drops listing, campaign pages (`/c/:id`) and App Links are unchanged.

## D-35 — Never call Blink while the wallet app is on screen (2026-10-04)

Found on device with build f1860f62: funding failed on every wallet with "Could not reach Blink". D-29 had moved
the funding prepare call inside the MWA session; while the wallet app is in front, Blink is a background app and
many Android phones block background network access, so the request never left the phone (the server logged
none). The app now prepares the fresh transaction on each tap just before opening the wallet (a few seconds before
signing, well inside the ~60–90 s blockhash window), and nothing calls the network inside `transact`. An expired
approval gets a plain "tap again" message.

## D-36 — Custom Tap Rush goals up to 1,000 taps (2026-10-04, Maris)

Creators choose the round length (10 s, 30 s, 1 min, 2 min) and the goal: presets at about 3/5/8 taps a second or
any custom number from 10 to 1,000. A goal must be winnable: at most 12 taps a second on average (so 1,000 taps
needs a 2-minute round); the server enforces it. Tap anti-cheat (D-14) is unchanged; the finish route accepts a
64 KB body for up to 2,400 tap timings.

## D-37 — Usernames and profile pictures (2026-10-04, Maris)

Optional, per account (`Profile` table). Usernames: 3–20 of `a-z 0-9 _`, unique case-insensitively, with
Blink/staff/issuer-like names reserved. Pictures: the app crops to a square and resizes to 256 px JPEG; the server
accepts only real JPEG/PNG (magic bytes) up to 150 KB and serves them at `/v1/avatars/<random public id>?v=<n>`
(never the Privy id). Live rooms show `@username` and the picture when set, otherwise the truncated wallet; email
and wallets stay private. Not moderated automatically — a report/remove flow is a follow-up if needed.

## D-38 — Activity history and branded receipts (2026-10-04, Maris)

`GET /v1/me/history` merges rewards and invite bonuses (claims), sends from the stock wallet (new `Transfer`
table, written best-effort after each send) and drops the user funded, newest first. Every line opens a receipt:
an ink card with the Blink logo and lime dot (fixed colours so it looks the same when shared), amount, title,
@username, date, status, network and transaction. "Share receipt" captures it as a PNG
(react-native-view-shot) and opens the share sheet (X, WhatsApp, Photos…); "Post on X" opens the X composer with a
line and the drop or explorer link; "Explorer" opens the transaction. Entry points: Profile → History & receipts,
Home → Your rewards / All activity, and "View & share receipt" after a claim.

## D-39 — X tasks by personal code + public post check, no X login (2026-10-04, Maris: "Paste link + code")

Reverses the X_QUEST block (update §19, D-21) by owner decision. `X_QUEST` ("Post on X") is an action: each person
gets a personal code per campaign (`BLINK-XXXXXX`); they post on X (post, quote or reply) with it and paste the
link. The server reads the public post through X's official oEmbed endpoint (`publish.x.com/oembed`, no login, no
API key, no scraping) and requires: the post exists and is public, its text contains the person's code and the
creator's optional required text (`mustInclude`), it was posted after the campaign was created (post-id timestamp),
and that X account / post has not been used by anyone else in the same campaign (unique indexes). Verified tasks
make the requirement PASSED; X being unreachable returns a retryable error and never passes. 10 submissions per
hour per user. Not verifiable this way: likes, follows, reposts (nothing public to read).
**Risk accepted by the owner:** rewarding posts can conflict with X's rules on incentivised engagement; keep tasks
to genuine posts, one per person, and avoid follow/like-for-reward.

## D-40 — Clubs, chat, squads, event check-in, Passport and the five-tab nav (2026-10-05, Maris)

Final social product update (docs/FINAL_SOCIAL_PRODUCT_UPDATE_2026-10-04.md). Owner answers on 2026-10-05: Claude builds
backend and mobile; keep the D-39 oEmbed X check; build every P0 item; any signed-in user may start clubs (rate-limited).
Everything below is offchain Blink state (Postgres). None of it spends SOL or writes to Solana; the payout rail is unchanged.

- **Nav:** Home · Clubs · (Scan) · Drops · You. Create is still the `/create` route (hidden tab), opened from Home's
  quick actions and the + on Drops, Clubs and a club's Drops tab, so existing links keep working.
- **Clubs:** `Club` + `ClubMember`. Public or private (8-character invite code). Member counts are `count(*)` of
  memberships — never estimated. Owners can't leave. 3 new clubs per person per day. Names that look official
  ("official", "blink", "xstocks", …) are refused, and the UI says a club named after a company is not run by it.
  Starter clubs (NVDA, Seeker, SKR, ORE Miners) come from `scripts/seed-clubs.ts`, run by Blink, 0 members.
- **Chat:** plain text (≤ 500 chars, no control characters, never rendered as HTML), replies, 5 fixed reactions,
  soft delete by the author or the club's owner/mods. Members post; a public club's chat can be read before joining.
  20 messages per minute per person. **Transport: polling** (`?after=<last id>` every 3.5 s while the chat is on
  screen, plus a full newest-page resync every 5 polls) — the API has no WebSocket/SSE stack and the live room
  already polls. Reports and mod roles beyond the owner are P1.
- **Club drops:** `Campaign.clubId` (nullable). Only a member can post a drop in a club. New verifier
  `CLUB_MEMBER` (eligibility): a member of the drop's club. It never replaces the xStocks gate.
- **Leaderboard:** derived, never stored: 10 points for a reward won, 5 for qualifying, 5 for an event check-in, once
  each per drop, in the club's 30 newest drops, members only, this week (rolling 7 days) or all time. Balances never
  count. The rule is shown under the board.
- **Event check-in:** new verifier `QR_CHECKIN` (action). The creator gets a random server-issued code (24 bytes,
  `EventCode`), shown as a QR of `https://blinksol.site/e/<code>`; "New code" rotates it (old codes stop working).
  Checking in needs sign-in, a LIVE drop inside its window, and is once per person (`EventCheckin` primary key).
  No GPS, no location stored. "QR Event" in Create = a Verified Quest whose action is the check-in.
- **Squads:** Tap Rush drops (and quests with a Tap Rush step). Up to 4 (`CLUB_LIMITS.squadSize`), one squad per
  person per drop (unique index), join by 6-character code, seat count checked under a row lock, captain leaving
  disbands. Rule `COMBINED_TAPS`: the sum of each member's best accepted round as the server recorded it; goal =
  drop goal × 4. **A squad goal is an achievement (Passport), not a payout:** each person still claims by reaching
  the drop's own goal, so the payout rail and its checks are untouched.
- **Passport:** derived from records: settled rewards (`PAID` claims), check-ins, first club, squad goals, first club
  drop. No balances, no NFTs.
- **Receipts & Activity:** history gains `CHECKIN` and `CLUB_JOINED` (offchain; no amount, no network line). Receipts
  say "Reward settled ✓" only for confirmed payouts ("Completed · reward sending" before), carry a `BLK-xxxxxxxx`
  reference, and filters: All / Rewards / Events / Clubs / Sent & funded.
- **Scanner and links:** QR codes for campaigns, `https://blinksol.site/e/<code>` (check-in, asks before checking in)
  and `https://blinksol.site/club/<slug>[?invite=CODE]`. `app.json` adds `/e/` and `/club/` App Link paths (needs the
  next build). The website has no pages for those paths yet: that needs a Caddy rule on the shared VPS (owner OK).
- **Not changed:** Android package/scheme, Privy, payout rail, compliance gate, Tap Rush anti-cheat, the D-36 Tap
  Rush defaults (50 taps / 10 s server default; the creator picks up to 1,000 taps / 2 min).

## D-41 — Club join rules and members-only drops (2026-10-05, Maris)

- **Who can join a club:** the creator (and later the owner, from the club's About tab) turns on any of: Solana Seeker
  owners (SGT), SKR holds / stakes / holds or stakes / held + staked, ORE holds / stakes / holds or stakes — each with a
  custom minimum. Stored as `Club.rulesJson` (QuestGroup[]), only `CLUB_RULE_VERIFIERS` are accepted. Joining runs the
  Verified Quest readers on mainnet against the person's Privy-verified wallets (fails closed; 10 checks/min/person); a
  refusal returns `CLUB_RULES_NOT_MET` with the evaluation so the app shows each rule, the person's amount and a fix
  (verify a wallet, stake SKR, connect the Seeker). Rules apply to new joins; current members stay; there is no
  re-check sweep. Email-only accounts have no wallet to check and are refused until they link one.
- **Members-only drops:** `Campaign.membersOnly` (needs `clubId`) for every mechanic. Enforced server-side wherever
  someone takes part: Tap Rush start, quest verify, claim, referral, bonus retry and event check-in. It never replaces
  the xStocks gate. In Create it sits with the club picker ("Everyone" / "Club members only"); the quest-only
  "Club members only" toggle was folded into it.

## D-42 — Stock Passport as a shareable ID card (2026-10-05, Maris)

The Passport screen leads with a 16:9 ID card in Blink's own style (ink/cream/lime, flat, the logo's dot as a faint
watermark ring): profile picture, @username, a passport number, "since", level, four counts, the 3 latest stamps and a
passport-style machine line. "Share Passport" captures it at 1200 × 675 (X's full-width image) and opens the share sheet;
"Post on X" opens the composer with a line and blinksol.site. The number (`BLK-XXXX-XXXX`) is a one-way hash of the
account id, stable per account. Levels count stamps only: Newcomer 0, Explorer 1+, Regular 3+, Pro 6+, Legend 10+.
Never shown: balances, wallets, email, country. A browser-rendered reference is `docs/brand/passport-card-mockup.png`.

## D-43 — Club voice notes and WhatsApp-style admin controls (2026-10-05, Maris)

- **Voice notes:** tap the mic (shown when the text box is empty), record up to 60 s, send or cancel. AAC in M4A, mono
  32 kbps (`expo-audio`), base64 to `POST /v1/clubs/:slug/voice`; the server accepts only MP4/M4A (`ftyp` box), ≤ 1 MB,
  15 per 10 minutes plus the chat limit, and stores the bytes in Postgres (`ClubVoice`) like profile pictures. Played
  from `/v1/voice/<random 128-bit id>`; deleting the message makes it 404. One player per chat. The microphone is
  used only while the recorder is open (permission text says so). Muted / admins-only rules apply as for text.
- **Admins:** the owner makes or removes admins (`MOD`). Owner and admins can mute a member (1 h, 8 h, 1 day,
  1 week; unmute), remove a member (they can't rejoin until an admin lets them back in — `ClubBan`), pin one message,
  switch the chat to "only admins can send messages" and edit the description. Nobody acts on the owner; only the
  owner acts on admins; nobody acts on themselves. Members are addressed by an opaque per-club id, never the account id.
  Muted members and non-admins in an admins-only chat can still read and react.
- **Not in this build (owner decision):** paid clubs — one-time and monthly — come after October 8.

## D-44 — Gift xStocks to club members in chat (2026-10-05, Maris)

- **Flow:** 🎁 Gift on someone's message or in the members list → pick a stock in your Blink wallet and an amount →
  the server finds the recipient's Blink (embedded) wallet itself (never shown in the app) and builds the transfer
  through the D-32 Send service; the wallet signs in the app; Blink's fee payer pays the fee and, the first time, the
  recipient's token-account rent (mainnet budget cap applies). Same 20 sends/day cap and the global kill switch.
- **Checks:** both people must be members of the club — any member can gift, including muted members and in an
  admins-only chat (owner decision 2026-10-05: muting and admins-only limit messages, not gifts); no self-gifts; only Blink's supported assets; real xStocks need the sender's live eligibility check (inside
  Send) and the recipient's stored, current eligible decision (`isEligibleStored`) — otherwise
  `RECIPIENT_NOT_ELIGIBLE` before anything is signed.
- **Truthful states:** a gift is posted in the chat, notified to the recipient (push) and shown as "Gift received" in
  their Receipts & Activity only when Solana confirmed it. A transfer still confirming when the request ends is
  recorded `PENDING` and is not posted (the sender's Activity shows it via the Send record).
- **Records:** `ClubGift` (raw amount as Decimal(20,0), signature unique) and `ClubMessage.giftId`. Passport stamps:
  "First gift sent", "Gift received". Gifts can't be undone.
- **Not yet:** a sweep that later confirms `PENDING` gifts and posts them.

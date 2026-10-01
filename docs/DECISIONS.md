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

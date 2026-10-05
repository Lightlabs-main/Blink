# Security and compliance

The owner of this document is Codex (MASTER_PROMPT §3). Claude wrote this first version on
2026-10-01 under product update §21–§22; Codex should review it. The rules in MASTER_PROMPT and
DECISIONS still apply. This file adds what the verifier architecture and xStocks distribution
require.

## 1. xStocks compliance

**Status: `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION = BLOCKED`.** The eligibility gate is now implemented
(D-20: self-declaration + IP-country cross-check, enforced server-side). Public mainnet distribution
stays blocked until all of the following are done:
1. the gate is verified on a device;
2. the restriction list is re-verified against the issuer's current list;
3. Maris explicitly approves.

A controlled mainnet smoke test with one eligible participant may run only with Maris's explicit
approval.

### Policy `XSTOCKS-ELIGIBILITY`, version `2026-10-02.1`

v1 (`2026-10-01.1`) also blocked Nigeria. v2 removes it by owner decision (D-22), and every user
re-confirms under the new version.

Recipients and creators may not take part in xStocks distribution if they are:

| Restriction | Source | Status |
|---|---|---|
| In the United States, or a U.S. person | docs.xstocks.fi/docs/product-legal-overview; xstocks.fi news disclaimers | VERIFIED 2026-10-01 |
| In the United Kingdom | xstocks.fi news disclaimer ("not currently available in the United Kingdom") | VERIFIED 2026-10-01 |
| In any jurisdiction where offer or distribution would be unlawful or would need authorization that hasn't been obtained | same disclaimer | VERIFIED 2026-10-01 |
| In Iran, North Korea or Syria (sanctions: "prohibited") | assets.backed.fi/legal-documentation/restricted-countries | VERIFIED 2026-10-01 |
| In a "non-serviceable" country: Afghanistan, Belarus, Central African Republic, DR Congo, Cuba, Ethiopia, Haiti, Iraq, Lebanon, Libya, Mali, Mozambique, Myanmar, Nicaragua, Philippines, Russia, Somalia, South Sudan, Sudan, Venezuela, Yemen, Zimbabwe | same | VERIFIED 2026-10-01 |
| ~~Nigeria~~: on the issuer's "non-serviceable" list (re-checked 2026-10-02), **allowed by owner decision D-22** | same | OWNER OVERRIDE — risk accepted by Maris |
| In an occupied region of Ukraine | same | VERIFIED 2026-10-01 (enforced by attestation) |
| In Canada or Australia | Maris's update (§21). Not on the issuer's page or the xStocks disclaimers checked | ASSUMPTION — blocked conservatively |

The full list of prohibited and restricted countries is published by the issuer at
`assets.backed.fi/legal-documentation`. **Re-verify it against that list before any release.**
This table is not permanent truth: each eligibility record stores the policy id and version.

### Product characterization (VERIFIED, docs.xstocks.fi product legal overview)

xStocks are issued by Backed Assets (JE) Limited. Each is "a bearer debt instrument classified as
a tracker certificate" that "provides economic exposure to the underlying equity" and "does not
confer shareholder voting rights".

Blink copy must never claim:
- direct or registered share ownership;
- voting rights;
- guaranteed dividends;
- returns;
- safety.

Dividends on the underlying are reinvested through rebasing, net of taxes (xStocks FAQ). The issuer
also holds a PermanentDelegate (OQ-5).

### Rules

- **A separate, mandatory gate.** Every path that ends in an xStock transfer must pass the current
  Blink xStocks eligibility policy, checked server-side right before reward reservation:
  - Gift
  - Tap Rush
  - Flash Drop
  - Referral (friend and referrer)
  - Seeker
  - Verified Quest
  - future QR, Squad and other paths

  Seeker, SKR, ORE and Tap Rush checks **never** imply xStocks eligibility.
- **Creators** distributing xStocks must pass the creator-side policy before funding. Owning the
  campaign account is not an exemption.
- **Minimum data.** Store only:
  - a normalized country/jurisdiction result;
  - eligible yes/no;
  - policy id and version;
  - a timestamp;
  - the method/source;
  - a reason code.

  No identity documents, no precise location. Compliance state is never public and never appears in
  live events or share payloads.
- **Demo.** The public at a hackathon must not receive real xStocks without a working eligibility
  flow. Use test assets for public interaction, and show one real mainnet payout to a controlled,
  eligible participant with Maris's approval.

## 2. Verifier architecture

Applies to requirements such as SGT, SKR, ORE and Tap Rush.

- **The server decides.** Mobile never decides eligibility or payout, and the client can't assert
  "qualified".
- **No creator-supplied protocol data.** Program ids, mints, stake accounts and configs come only
  from Blink's allowlisted verifier registry, never from creators.
- **No client-supplied facts.** Client balances and transaction interpretations are never trusted.
  The server reads canonical chain state.
- **Amounts** are raw-unit bigint and travel in JSON as strings. JS floats are never canonical
  (D-6).
- **Fail closed.** RPC errors, unknown state, expired or stale results, and a non-mainnet RPC for
  mainnet-only protocols all mean "not qualified".
- **Timing (update §20, P0).** Hold and stake conditions are evaluated on **current onchain state
  immediately before reward reservation**. Blink does not lock tokens or monitor continuously, and
  never claims "must hold for N days".
- **Binding.** Verification is tied to the wallet and the user: a wallet change invalidates it, and
  sign-out or session expiry drops cached qualification.
- **Replay safety.** Evidence must be replay-safe, and any transaction used as action proof can't be
  reused beyond the campaign rules. Until that exists for ORE activity, ORE activity stays
  **disabled**.
- **No bypass.** No verifier may bypass:
  - xStocks compliance
  - campaign solvency
  - the delegated allowance
  - campaign state
  - duplicate-claim prevention
  - payout idempotency
  - Token-2022 and mint operational checks (pause, transfer hook)
  - the global payout kill switch
- **X_QUEST is BLOCKED (policy review).** No rewards for likes, reposts or follows, no scraping,
  and never ask for X credentials.

## 3. Existing protections (unchanged)

- Exact delegated allowance per campaign, with the creator owning the campaign account (§9)
- One Privy delegate per campaign (§14)
- A separate low-balance fee payer (§16)
- Mainnet flags and the 0.10 SOL hard ceiling (§7, §22)
- An atomic pool with a CHECK constraint (D-13)
- Signature recorded before send, plus compare-and-set before send (D-16)
- Rate limits (D-16)
- Simulation before signing (D-12)

## 4. Social features (D-40)

- All offchain; no SOL is spent and nothing is signed for clubs, chat, squads, check-ins or the Passport.
- Identity is always the verified Privy user; request bodies carry no user, club-membership or qualification fields.
- Chat text is plain (control characters refused, ≤ 500 chars) and rendered as text, never HTML or links.
- Uniqueness in the database: one membership per person per club, one squad per person per drop, one check-in per
  person per drop, unique club slug, invite code, squad code and event code. Squad seats are taken under a row lock.
- Rate limits: 20 messages/min, 3 clubs/day, 5 squads/day, 10 check-ins/hour per person, plus the D-16 limits.
- Event codes are 24 random bytes from the server, rotatable; no location data.
- People appear by username or a shortened wallet only; private clubs are 404 to non-members without the invite.
- Not yet: message reports and extra moderator roles (owner deletes only), automated content moderation.

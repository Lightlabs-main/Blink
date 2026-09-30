# Open Questions

## OQ-1 — Mobile template choice — RESOLVED 2026-09-29

`sample-expo-kit-privy` (see DECISIONS D-1).

## OQ-2 — Master spec incomplete — PARTIALLY UNBLOCKED 2026-09-30

`docs/MASTER_PROMPT.md` ends inside §26.
- **Built under owner-approved assumptions (DECISIONS D-13), devnet only:** claims, Tap Rush
  sessions, first-come ordering, idempotency, payouts and reconciliation. Replace these with the
  real rules when the sections arrive.
- **Referral, Tap Rush timing checks and resume:** added 2026-09-30 (D-14).
- **Still not implemented:** Seeker/SGT mechanics, notifications, device attestation for Tap Rush,
  and the mainnet smoke test.

## OQ-3 — Build machine not Android-ready — BLOCKED

- Under 1 GB free on C: (it was 3 GB at session start).
- No JDK 17 and no Android SDK.
- `node_modules` for the backend is about 460 MB.

## OQ-4 — Privy authorization-key blast radius — NEEDS_OWNER_DECISION

See SPIKES.md SPIKE-1, "Security caveat". The recommendation is option A for the hackathon.

## OQ-5 — PermanentDelegate disclosure — NEEDS_OWNER_DECISION

Every supported xStock has a PermanentDelegate (the issuer), so the issuer can move tokens out of
campaign accounts and recipient accounts. The product copy likely needs a disclosure; wording is
Maris's call.

## OQ-6 — Dedicated RPC provider — NEEDS_OWNER_DECISION

The public mainnet RPC is rate-limited (it returned HTTP 429). A reliable provider is required
(§19); Helius is allowed for Seeker (§20).

## OQ-7 — Recipient ATA rent vs the 0.02 SOL target — ASSUMPTION pending measurement

The campaign account (175 bytes) costs 1,539,240 lamports. If a recipient ATA is similar,
0.02 SOL covers only about 12 sponsored recipient ATAs, before transaction fees.
Measure with a dedicated RPC.

## OQ-8 — Privy SIWS nonce guarantees (§25) — ASSUMPTION (the flow itself VERIFIED on device 2026-09-29)

§25 requires a random, short-lived, single-use nonce and exact payload verification. Privy performs
SIWS verification, but we haven't found documentation of its nonce expiry and single-use semantics.

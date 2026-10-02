# Demo runbook and one-pass test checklist

The owner of this document is Claude (MASTER_PROMPT §3). The update's demo section hasn't been
received yet (OQ-10), so this version covers what exists today.

## Before testing

- **Install** the latest release APK from `https://blinksol.site/download/blink-to-stock.apk` on two
  Android phones. Phone A is the creator, phone B the participant. They need different accounts;
  creators can't claim their own drops.
- **Server:** `https://api.blinksol.site/v1/status` shows `cluster: devnet`, `payouts.enabled:
  true`, `killSwitch: false`, and a fee payer that isn't `low`.
- **xStocks eligibility (D-20):** testers must be in an eligible country, or the devnet gate must be
  switched off for testing (`XSTOCK_COMPLIANCE=off` on devnet only; mainnet refuses that setting).
- **Creator wallet:** phone A's wallet app is on **devnet** and holds test stock (tNVDAx) plus a
  little devnet SOL.

## Checklist

| # | Flow | Expect |
|---|---|---|
| 1 | Phone B: open the app, sign in with email | Home loads; Profile shows a Blink wallet |
| 2 | Phone B: Profile → xStocks eligibility → choose country, tick the U.S.-person box | "You're eligible" (or the reason it isn't) |
| 3 | Phone A: sign in, Create → connect wallet | Wallet app opens twice (connect + sign) |
| 4 | Phone A: Create → **Tap Rush**, reward, limits (24 hours), review → Create & fund → approve in wallet | Drop goes **Live**; the live room appears |
| 5 | Phone B: scan phone A's QR with the **phone camera** | It opens in Blink (App Link), not the browser |
| 6 | Phone B: Play Tap Rush, reach the goal | "Sending … on Solana" → "Received", with an explorer link |
| 7 | Phone B: Challenge a friend | Native share sheet with "I completed the … Tap Rush on Blink" and a blinksol.site link |
| 8 | Both phones: the live room | Joined/qualified counts, leaderboard (phone B shown as "You"), recent activity |
| 9 | Phone A: Create → **Verified Quest**: Verified Seeker or SKR/ORE (needs real mainnet holdings) + Tap Rush | Requirements listed one per line |
| 10 | Phone B: open the quest → Check my requirements | Each line shows its state; amounts are shown as "Yours: …"; Claim appears only when every line passes |
| 11 | Phone A: Create → **Flash Drop** and **Referral** | Claim works; the referral pays both people once |
| 12 | Phone A: revoke the approval in the wallet, then have someone claim | The drop pauses with a reason, and "Check again & resume" is shown |
| 13 | blinksol.site on a laptop | Live drops listed, Night edition toggle, download works |

## Known limits to mention in a demo

- **Devnet:** payouts use a test stock with no value. `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION =
  BLOCKED` (SECURITY.md).
- **SKR stake checks** need a dedicated mainnet RPC; with the public one they show "Couldn't check
  right now", which fails closed.
- **ORE activity, QR Event, Squads and X quests** are shown as "Soon" or "Unavailable", never as
  working.

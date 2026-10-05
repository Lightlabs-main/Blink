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
| 14 | Phone B: **Clubs** tab → NVDA Club → Join | Member count goes up by one (real count); Home shows it under Your clubs |
| 15 | Both phones in the club: Chat → send, reply, react, delete | Messages appear on the other phone within a few seconds |
| 16 | Phone A: club → Drops → Post a drop in this club (Tap Rush) | The drop lists under the club's Drops (Live) |
| 17 | Phone B: open that Tap Rush → Play as a squad → Create; phone C joins with the code | Members and combined taps update; the squad goal = drop goal × 4 |
| 18 | Phone A: Create → **QR Event** → fund; show the Event check-in QR | Phone B scans it in Blink → confirm → "Checked in ✓"; scanning again says already checked in |
| 19 | Phone B: You → Stock Passport, and Receipts & Activity → filters | Real stamps only (reward settled, check-in, first club); check-in and club join have receipts |
| 20 | Club → Leaderboard | Points match the rule shown (10 won / 5 qualified / 5 check-in) |
| 21 | Phone A: Start a club → turn on "SKR stakes" with a minimum → phone B (no stake) taps Join | Refused; each rule shows phone B's amount and "Stake SKR in Blink" |
| 22 | Phone A: club → Drops → post a Tap Rush with "Club members only"; phone C (not a member) opens it | "For <club> members" card; playing is refused until phone C joins |
| 23 | Club chat: phone B taps the mic, records ~5 s, sends; phone A plays it | Voice note appears within seconds and plays; deleting it removes the audio |
| 24 | Phone A (owner): About → Members → make phone B an admin; phone B mutes phone C for 1 hour | Phone C sees "An admin muted you…" and can't post; Unmute restores it |
| 25 | Phone A: About → Admin settings → Only admins; pin a message | Members can't post; the pinned message shows above the chat |
| 26 | Phone B (admin): remove phone C; phone C taps Join | "An admin removed you"; Members → Removed → Let back in, then Join works |

## Known limits to mention in a demo

- **Devnet:** payouts use a test stock with no value. `MAINNET_PUBLIC_XSTOCK_DISTRIBUTION =
  BLOCKED` (SECURITY.md).
- **SKR stake checks** need a dedicated mainnet RPC; with the public one they show "Couldn't check
  right now", which fails closed.
- **Chat is polled** (every few seconds), not push; a message can take up to ~4 s to appear.
- **Squad goals** are achievements; each player still wins the drop's reward individually.
- **Event and club links** open the app; the website has no page for them yet.

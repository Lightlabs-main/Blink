# Blink

Tokenized stocks, made social. Blink is an Android app for Solana Mobile, built for the Solana
Seeker, where people give, claim and share xStocks with their friends and communities.

- **Website:** https://blinksol.site
- **Android app:** https://blinksol.site/download/blink-to-stock.apk
- **Network:** Solana mainnet (the live server reports `mainnet-beta`)

## What the app does

| Area | What it does | Status |
|---|---|---|
| Drops | Creators fund a drop with xStocks from their own wallet and share a link or QR | Live on mainnet |
| Tap Rush | A timed tapping challenge; the server times each round | Live |
| Verified Quests | Requirements checked before a reward moves: Verified Seeker (SGT), SKR or ORE holdings, a check-in at an event, an X post, an ORE deploy | Live |
| QR entry and check-in | Scan a drop or an event QR to open it or check in once | Live (device test pending, see `docs/MOBILE_STACK_VERIFICATION.md`) |
| xStock rewards | Real xStocks paid from the creator's own delegated treasury, with eligibility checked | Live on mainnet |
| Clubs | Community chat with text and voice notes, roles, member profiles, leaderboards, club delete | Live |
| Gifts | Give stock to a person by Blink username or `.skr` name, or gift a drop to a list of names | Live |
| SKR tipping | Tip a club member in SKR from your own wallet; the transfer is verified onchain before it counts | Live |
| SKR boost | A creator pays SKR to feature a live drop for a fixed time; labelled as sponsored | Live (owner-approved package) |
| `.skr` identity | A `.skr` name is shown only when it resolves both ways to a verified wallet | Live |
| ORE live board | Reads the ORE round from the chain; deploys are signed by your wallet | Live (you approve each deploy) |
| Receipts and activity | Every reward, gift, tip, boost and deploy has a receipt with its transaction signature | Live |
| Wallets | Mobile Wallet Adapter for external Solana wallets; an embedded Blink wallet for stock | Live |

SKR staking and holding are used only as **eligibility** for Verified Quests. They are not a prize
integration. Staking itself happens on Solana Mobile's official surfaces.

## Repository layout

```
apps/mobile      Expo (React Native) Android app: Privy login, MWA, screens
apps/api         Fastify API: campaigns, claims, payouts, clubs, gifts, SKR, ORE
apps/web         blinksol.site (static site, proxied API under /api)
packages/        domain · validation · config · solana · xstocks (shared logic)
prisma/          PostgreSQL schema and migrations (Prisma 7)
scripts/         read-only inspection tools and the mainnet switch
docs/            decisions, handoff, verification and go/no-go records
```

## Running it locally

Requirements: Node.js 22.12 or newer, npm, PostgreSQL (for the full API), and an Android device or emulator for the app.

```bash
npm install
cp .env.example .env          # fill in your own values; never commit .env
npx prisma generate
npm test
npm run typecheck
```

The mobile app is built with EAS (`apps/mobile/eas.json`). The `preview` profile produces the APK
that is published to the website.

## Network

The server chooses its network from `SOLANA_CLUSTER`. The app reads the network from the server, so
one APK follows the server. Mainnet requires `MAINNET_ENABLED=true` and `MAINNET_GO_APPROVED=true`;
`scripts/switch-network.sh` switches between devnet and mainnet with a rollback on failure.

Current mainnet status and its open items are recorded in `docs/MAINNET_GO_NO_GO.md`.

## Documentation

- `docs/DECISIONS.md`: product and engineering decisions, with dates
- `docs/HANDOFF.md`: API contracts and what changed when
- `docs/MOBILE_STACK_VERIFICATION.md`: what has been tested on a device, and what has not
- `docs/MAINNET_GO_NO_GO.md`: the mainnet gate checklist
- `docs/DEMO_RUNBOOK.md`: the submission demo

Documents marked **historical** describe an earlier state and are kept for the record.

## Security

Secrets live only in server `.env` files (mode 600) and EAS environment settings. The APK contains
only public app identifiers. Report security issues privately to the maintainers.

## Licence and attribution

Built for the Solana Mobile CLOCK IN Hackathon. This product includes GeoLite2 data created by
MaxMind, available from https://www.maxmind.com. xStocks are issued by Backed Assets (JE) Limited.
ORE is a protocol by Regolith Labs; Blink is not affiliated with ORE.

# Blink-to-Stock

Tokenized stocks as shareable mobile experiences: a creator funds a campaign, shares a link or QR
code, and recipients earn real xStocks on Solana. The build is Android-first, for the Solana Mobile
CLOCK IN Hackathon.

> "Blink determines campaign eligibility; asset settlement is transparent and verifiable on Solana
> mainnet."

The spec lives in `docs/MASTER_PROMPT.md`. It is **incomplete** and awaiting the remaining
sections.

## Layout

```
apps/mobile      Expo + Privy + Solana Kit + MWA (official sample-expo-kit-privy); deps not installed yet
apps/api         Fastify API (Privy-verified creator auth, campaign drafts)
packages/        domain · validation · config · solana · xstocks
prisma/          PostgreSQL schema (Prisma 7)
scripts/         read-only inspection tools, DB guard
docs/            spec, decisions, dependencies, spikes, handoff
```

## Backend quick start (devnet, local)

```bash
npm install
cp .env.example .env
npx prisma generate
npm test
npm run typecheck
```

Read-only inspection of an xStock mint on mainnet (nothing is signed or sent):

```bash
SOLANA_RPC_URL=https://api.mainnet.solana.com npx tsx scripts/inspect-xstock.ts <mint> --fee-payer <any existing account>
```

## Safety

- Mainnet spending requires `SOLANA_CLUSTER=mainnet-beta`, `MAINNET_ENABLED=true` and
  `MAINNET_GO_APPROVED=true`. The budget is capped at 0.10 SOL in code.
- Migrations: `npx tsx scripts/db-guard.ts` must pass first. Never run `prisma migrate reset`
  against a shared database.
- There is no custom Solana program and no custodial treasury. Campaign stock stays in a
  creator-owned Token-2022 account with an exact delegated allowance.

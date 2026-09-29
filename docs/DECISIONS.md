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

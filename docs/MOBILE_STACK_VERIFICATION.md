# Mobile stack verification (Solana Mobile, MWA, Seed Vault)

Audit 2026-10-07. Statuses: VERIFIED · FAILED · BLOCKED · ASSUMPTION · NEEDS_OWNER_DECISION · NOT TESTED.

## Hackathon requirements (CLOCK IN)

Source: solanamobile.com/blog/clock-in-the-solana-mobile-hackathon (fetched 2026-10-07): "A functional Android APK",
a GitHub repository, a demo video, a pitch deck; submissions close October 8, 2026. A Seeker is not required.

| Requirement | Status | Evidence |
|---|---|---|
| Android app, not a PWA wrapper | VERIFIED | Expo / React Native native build (`expo prebuild`, EAS `preview` profile, `buildType: apk`); native modules: expo-camera, expo-audio, MWA (`@wallet-ui/react-native-kit ^4.2.1` over `@solana-mobile/mobile-wallet-adapter-protocol`), Privy embedded wallets. |
| Functional APK | **FAILED** until rebuild | Build `c5dc737a` installs and runs (owner's phone, 2026-10-06) but has no CAMERA / RECORD_AUDIO (see MAINNET_GO_NO_GO.md). Fix `a06d8f7`. |
| Solana Mobile Stack + MWA | VERIFIED (partial) | MWA used for creator connect, SIWS, campaign funding, gifts and Close drop; on-device funding with Solflare confirmed onchain. Blink does not provide SKR staking in the submitted build (D-48): staking is on stake.solanamobile.com / Seed Vault Wallet. |
| Meaningful Solana interaction | VERIFIED | Token-2022 xStock funding with delegated allowance, payouts, sends, gifts (devnet e2e 2026-10-07; device funding 2026-10-05). |

Android identity: package `com.blinktostock.app`; scheme `blinktostock`; App Links `https://blinksol.site/{c,e,club}/…`
(assetlinks.json SHA-256 `0F:0A:…:D3:6C`); build variant EAS `preview` (release-signed APK); version `1.0.0`.
Device used by the owner: Android phone (model not recorded); Android version NOT RECORDED.

## Mobile Wallet Adapter

Installed APIs used (checked in installed types/source): `transact(cb)` → `wallet.authorize({ chain, identity })`,
`wallet.signTransactions({ transactions })` (`@wallet-ui/react-native-kit`); Privy `useLoginWithSiws` / `useLinkWithSiws`.

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Authorization through MWA | VERIFIED | Solflare authorized on a real phone; funding signed (2026-10-05). |
| 2 | Compatible wallet selection | **FAILED / NOT TESTED** | Phantom did not open for the owner (likely Testnet Mode off or Android default handler). App now shows a "Your wallet didn't open" guide (ab3977d, next build). Retest Phantom + Solflare + Seed Vault Wallet. |
| 3 | Expected public key | VERIFIED | App checks the authorized accounts include the campaign's creator wallet before signing (fund-campaign.tsx); funding came from `GXi7…yhx3yW` as recorded. |
| 4 | Message signing / SIWS | VERIFIED | Privy SIWS flow device-verified 2026-09-29 (OQ-8). |
| 5 | Transaction signing | VERIFIED | Devnet funding tx confirmed onchain from the device. |
| 6 | Rejected signature handled | NOT TESTED | Code path: thrown error → "Funding did not complete" notice, step back to review. Needs a device run. |
| 7 | Cancelled flow doesn't crash | NOT TESTED | Same path; plus the 6-s "wallet didn't open" guard (next build). |
| 8 | Disconnect / reconnect | NOT TESTED | Profile → remove creator wallet (server unlink, D-26) then relink. |
| 9 | Wallet change invalidates state | ASSUMPTION | Server derives wallets from Privy on every request (`getVerifiedExternalSolanaWallets`); a removed wallet stops counting immediately. Device test pending. |
| 10 | No seed phrase / private key in Blink | VERIFIED | No key material in the app: grep of the source; APK scan (no keys, only library PEM header constants). Embedded wallet keys are Privy-managed; external wallets sign inside the wallet app. |

## Seed Vault

Relationship (Solana Mobile docs, 2026-10-07): Seed Vault is the secure key store used by compatible wallets on
Solana Mobile devices; apps reach a wallet through MWA. Blink uses **no direct Seed Vault API** (grep: only UI text
telling Seeker users to pick the Seed Vault wallet). No direct dependency will be added for optics.

Hardware test on a Seeker / Seed Vault Wallet: **NOT TESTED** (no Seeker available to the audit).

## SKR (official sources)

docs.solanamobile.com/solana-mobile-stack/skr (2026-10-07): mint `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, staking
program `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ`, stake config `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw`,
"Stakers delegate their stake to a Guardian", staking portal stake.solanamobile.com. **Matches** `packages/solana/src/stake-readers.ts`.
Decimals 6 and Tokenkeg program were verified onchain earlier (DEPENDENCIES.md); total stake sums every position of the
wallet across guardian pools (stake-readers tests). Seed Vault Wallet as an official staking surface: not stated on the
fetched page — ASSUMPTION.

Official staking surfaces (Solana Mobile, 2026-10-08): stake.solanamobile.com and Seed Vault Wallet only. Blink links to
the first and mentions the second; in-app staking is disabled (D-48, code kept behind a flag).

Blink's SKR uses (all read-only): A balance check — VERIFIED (tests + mainnet read); B staking-state check — VERIFIED,
including stake made on the official surfaces (`scripts/skr-official-stake-check.ts` on mainnet 2026-10-08 (read-only): 47,618 UserStake accounts in the official program, all active stake in one guardian pool; 20/20 sampled real stakers detected by `MainnetChainReader.skrStaked`, the reader behind SKR_STAKED / SKR_TOTAL and the SKR OG mark); C club / quest gating and the SKR OG mark — VERIFIED (tests);
D SKR social utility (tips, SKR club access) — **not built**.
Prize note: the CLOCK IN FAQ says staking integrations do not qualify; staking is not presented as Blink's SKR integration.

External staking link on Android: the URL answers 200 (2026-10-08); it opens with `Linking.openURL`, the same call the
working ORE and explorer links use. **Device check pending** on the next APK (device plan row below).

## Device test plan (run on the next build)

Clean install → sign up (email) → sign out / in → every tab → Clubs (join, chat, voice note, reactions, admin, mute)
→ Scan (drop QR, event QR, club QR) → Drops → Create + fund (Solflare and Phantom, approve, reject, cancel) → Tap Rush
→ claim → receipt → share receipt / Passport → OG check → gift → deep links from WhatsApp → kill the app mid-funding
and reopen → airplane mode during claim → battery saver → background/foreground during Tap Rush. Record device model and
Android version.

Also on the next build: creator's drop → **Close drop** (stock back, drop Closed); a quest or club with an SKR-staked
rule and a wallet without stake → **Stake on Solana Mobile** opens stake.solanamobile.com in the phone's browser and Back
returns to Blink; Profile → SKR → Stake SKR does the same; no in-app staking screen anywhere.

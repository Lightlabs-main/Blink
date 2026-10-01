# Dependencies

Status vocabulary: VERIFIED / ASSUMPTION / BLOCKED / NEEDS_OWNER_DECISION. All dates are 2026-09-29
unless noted.

## Tooling

| Dependency | Version | Purpose | Source | Status / limitation |
|---|---|---|---|---|
| Node.js | 22.23.1 (VPS) / 26.4.0 (local PC) | Runtime | `node --version` on each host | VERIFIED. `.nvmrc` = 22.23.1 to match the VPS global Node (D-10). |
| npm | 11.17.0 | Workspaces | `npm --version` | VERIFIED. npm 11 skips install scripts not covered by `allowScripts` (prisma, @prisma/engines, esbuild). `prisma generate`, tsx and vitest still work. |
| solana-mobile CLI | 0.5.0 | Bootstrap, doctor | `npx solana-mobile@latest --version` | VERIFIED. Commands: create, device, doctor, emulator, localnet, playground, templates, webshell. |
| TypeScript | 6.0.3 | Types | npm | VERIFIED. Matches the mobile template (`~6.0.3`); npm `latest` is 7.0.2 and was deliberately not used. |
| vitest | 5.0.2 | Tests | npm | VERIFIED |
| tsx | 4.23.15 | Running TS scripts and the API | npm | VERIFIED |

## Mobile template

- `gh:solana-mobile/templates/mobile/sample-expo-kit-privy` is the only Expo + Kit + Privy template
  listed by `create --list-template-ids`. Description: "A sample Solana mobile app with Expo, Privy
  auth, Solana Kit, and Uniwind."
- The repo README says it "requires native modules and Mobile Wallet Adapter support" (no Expo Go).
- Scaffolded with `--skip-install --skip-git`.
- Generated versions (from the template `package.json`): expo ~57.0.6, react-native 0.86.2,
  react ~19.2.3, @privy-io/expo ^0.65.5, @privy-io/expo-native-extensions ^0.0.11,
  @solana/kit ^7.0.0, @wallet-ui/react-native-kit ^4.2.1, expo-router ~57.0.6, uniwind 1.6.5,
  typescript ~6.0.3.
- Mobile dependencies are **NOT installed** (disk space).
- Note: mobile pins kit ^7 while the backend uses 8.4.0. Shared packages (`domain`, `validation`)
  do not import kit.

## Backend / Solana

| Dependency | Version | Purpose | Status / limitation |
|---|---|---|---|
| @solana/kit | 8.4.0 | RPC, addresses, transactions | VERIFIED exports at runtime. `createAddressWithSeed` enforces `MAX_SEED_LENGTH = 32` (dist source). |
| @solana-program/token-2022 | 0.19.0 | Token-2022 instructions and decoders | VERIFIED: `getGetAccountDataSizeInstruction`, `getInitializeAccount3Instruction`, `getApproveCheckedInstruction`, `getRevokeInstruction`, `getTransferCheckedInstruction`, `getCloseAccountInstruction`, `fetchMint`, `fetchMaybeToken`, `getTokenSize`. Its Scaled UI helpers use JS float math, so they are display-only; payouts use raw bigint. |
| @solana-program/system | 0.15.0 | `getCreateAccountWithSeedInstruction` | VERIFIED signature: `{ payer, newAccount, baseAccount?, base, seed, amount, space, programAddress }` |
| @solana/sysvars | 8.4.0 | Token-2022 peer | VERIFIED |
| @privy-io/node | 0.35.0 | Access-token verification, user lookup, server wallets | VERIFIED: `new PrivyClient({ appId, appSecret, jwtVerificationKey? })`, `utils().auth().verifyAccessToken(token)` → `{ user_id, session_id, app_id, … }`, `users()._get(id)`, `wallets().create(...)`, `wallets().solana().signTransaction(walletId, …)`. Optional peer `@solana/kit ^5.1.0` is **overridden to 8.4.0** (see DECISIONS D-4). |
| fastify | 5.12.5 | HTTP API | VERIFIED |
| zod | 4.6.5 | Validation | VERIFIED. In Zod 4, later checks still run after a failed check; see DECISIONS D-6. |
| prisma / @prisma/client / @prisma/adapter-pg | 7.10.0 | ORM | VERIFIED. npm `latest` for `prisma` is `8.0.0-rc.17` (a release candidate), so stable 7.10.0 was chosen. Prisma 7 uses `prisma.config.ts` plus a driver adapter. `npm audit` reports 4 high findings, all transitive through the Prisma CLI (deepmerge-ts, mysql2). This is dev tooling and the runtime doesn't use them; the only offered fix is downgrading to Prisma 6. Revisit on the next Prisma patch. |
| pg | 8.23.0 | PostgreSQL driver | VERIFIED |

## Services and addresses

| Item | Value | Source | Status |
|---|---|---|---|
| Solana mainnet public RPC | `https://api.mainnet.solana.com` | solana.com/docs/references/clusters | VERIFIED. Rate-limited (it returned HTTP 429 on `getTokenLargestAccounts`). Not for production; a dedicated provider is NEEDS_OWNER_DECISION. |
| Solana devnet public RPC | `https://api.devnet.solana.com` | same | VERIFIED |
| Token-2022 program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `TOKEN_2022_PROGRAM_ADDRESS` in the installed package, and the owner of every xStock mint onchain | VERIFIED |
| xStocks asset list | `GET https://api.backed.fi/api/v2/public/assets?page=N` | Found through docs.xstocks.fi | VERIFIED. 1,124 assets, paginated (`page.hasNextPage`). |
| NVDAx mint | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | Backed API + mainnet RPC | VERIFIED |
| TSLAx mint | `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` | Backed API + mainnet RPC | VERIFIED |
| AAPLx mint | `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` | Backed API + mainnet RPC | VERIFIED |
| SPYx mint | `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W` | Backed API + mainnet RPC | VERIFIED |

### xStock mint facts observed on mainnet (2026-09-29)

- **Mint basics:** Token-2022; decimals 8; mint authority `7pt9…taCj`; freeze authority `JDq1…dxJNs`.
- **Extensions:** MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmountConfig,
  PausableConfig, ConfidentialTransferMint, TransferHook, TokenMetadata.
- **DefaultAccountState:** `state = 1` (Initialized). New accounts are not frozen.
- **TransferHook:** `programId = 11111111111111111111111111111111`, meaning no hook is configured.
  The hook authority `5aMN…FvEq` could set one later, so payouts must re-check it.
- **PermanentDelegate:** `5aMN…FvEq`. The issuer can move tokens from any holder account. This is a
  **disclosure item**.
- **Pausable:** `paused = false`.
- **Scaled UI multiplier:** NVDAx 1.0009…, rising to 1.0017… at unix 1789000200; TSLAx 1; AAPLx 1.0026….
- **Campaign token account size:** **175 bytes** (not 165), via the Token-2022 `GetAccountDataSize`
  simulation. Rent-exempt minimum: **1,539,240 lamports**. Measured for NVDAx.
- **Recipient ATA size** (it adds ImmutableOwner): NOT YET MEASURED because the public RPC
  rate-limited the query. Needed for the Blink SOL budget (§8: Blink pays recipient ATA rent).

## Local environment (from `solana-mobile doctor`, 2026-09-29)

| Check | Result |
|---|---|
| Disk space | **BLOCKED**: under 1 GB free. It needs 10 GB minimum; 20 GB is recommended. |
| JDK 17+, `JAVA_HOME` | **BLOCKED**: not found |
| Android SDK, adb 33+ | **BLOCKED**: not found |
| Readiness | Project creation ready. Android build, emulator and device workflows unavailable. |

## Device verification log

### 2026-09-29 — First development build on a real Android phone

- **Build:** EAS Build `12c37559-ad11-4104-b05a-337c7ce3617f` (profile `development`), status
  FINISHED. The dev server `blink-metro` runs on the VPS.
- **MWA wallet connect:** **VERIFIED.** The sample's "Connect wallet" opened the user's wallet via
  Mobile Wallet Adapter, the user approved, and the app showed the connected address
  `Ctyk1E…prGPWM`. A devnet balance read also worked.
- **Privy SIWS creator login:** **VERIFIED**, after enabling Solana (SVM) inside Privy's External
  wallets login method. The first attempt returned "Login with solana wallet not allowed" because
  SVM wasn't enabled. The phone showed Privy user `did:privy:…kz65ek`.
- **Backend creator-wallet check:** **VERIFIED against real Privy data.**
  - `users().list()` and `users()._get(id)` both work.
  - The linked account is `{ type: 'wallet', chain_type: 'solana', wallet_client: 'unknown',
    verified_at: <unix> }`, as the types predicted.
  - `extractVerifiedExternalSolanaWallets` returns exactly `Ctyk1E…prGPWM`.
- **Not yet tested:** MWA signMessage and signTransaction (sample buttons), email login (not in the
  sample), and any Blink campaign transaction.
- **MWA signMessage:** **VERIFIED** on device (2026-09-29). A signature was returned.
- **MWA signTransaction:** **VERIFIED** on device (2026-09-29). It signed the sample's devnet memo
  transaction. The wallet's preview showed **"Unexpected error when analyzing the transaction"**,
  most likely because the wallet was on mainnet while the transaction was devnet, with a 0 SOL
  payer. This is ASSUMPTION; the wallet gives no detail.
- **Wallet dApp identity:** shown as "Blink-to-Stock · blinktostock://app", with "Only confirm if
  you trust this website".

### 2026-09-29 — Build #2 on device

- **Build:** EAS Build `4531e9e8-e495-42a1-b5e5-b2c4bd9cc34a` (development; adds expo-camera, expo-haptics, react-native-qrcode-svg, bottom-tabs), FINISHED.
- **Verified by Maris on device:**
  - Email OTP login and sign-out work.
  - Creating a campaign draft works; persisted in Postgres with raw amount `6600000000` for 66 TSLAx.
  - After installing build #2, the QR scanner and safe-area layout work.
- **Lesson:** after `git pull` on the VPS, `blink-metro` kept serving stale JS until restarted with its cache cleared. Deploy procedure: pull, then `pm2 delete blink-metro`, clear `apps/mobile/node_modules/.cache/metro`, and start `infra/metro.ecosystem.config.cjs` again (Blink process only).

### 2026-09-30 — First release APK (build #3)

- **Build:** EAS Build `34171533-125a-494e-9052-3555476a1507` (profile `preview`, release APK
  with no dev client), FINISHED. It includes claims, Tap Rush, Referral and resume (D-13, D-14).
- **Signing:** the same default EAS keystore as the dev builds.
- **Not yet verified on a device.**

### 2026-09-30 — Release APK build #4 (blinksol.site)

- **Build:** EAS Build `567b6e1b-7970-4b36-af48-45f7e41a8067` (profile `preview`), FINISHED.
- **What changed:** the API is `https://api.blinksol.site`; `https://blinksol.site/c/*` App Links
  are declared; the wallet identity is `https://blinksol.site`.
- **Signing:** the certificate SHA-256 `0F:0A:…:D3:6C` matches `apps/web/.well-known/assetlinks.json`.
- **Hosting:** the build is served at `https://blinksol.site/download/blink-to-stock.apk`.
- **Not yet verified on a device.**

## External protocol addresses (VERIFIED 2026-10-01)

Each address below comes from the official source listed, and each was checked against mainnet
with `getAccountInfo` on the same day.

| Item | Value | Source | Onchain check |
|---|---|---|---|
| SKR mint | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` | docs.solanamobile.com/solana-mobile-stack/skr | SPL Token (Tokenkeg), decimals **6** |
| SKR staking program | `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` | same; `react-native-samples/skr-staking/program/idl.json` `address` | executable (BPF upgradeable) |
| SKR stake config | `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw` | same | owned by the staking program; StakeConfig discriminator `[238,151,43,3,11,151,63,176]` matches the IDL |
| SKR guardian pool (sample default) | `DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr` | same | GuardianDelegationPool discriminator matches |
| SKR stake vault | `8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8` | docs | not yet checked onchain |
| SKR UserStake | PDA `["user_stake", stake_config, user, guardian_pool]`; layout disc(8) bump(1) stake_config(32) user(32) guardian_pool(32) shares u128 …; staked = shares × share_price / 1e9 | skr-staking sample `src/app/index.tsx` + IDL | — |
| ORE mint | `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` | github.com/regolith-labs/ore-mint `api/src/consts.rs` | SPL Token (Tokenkeg), decimals **11** (matches `TOKEN_DECIMALS`) |
| ORE stake program | `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH` | github.com/regolith-labs/ore-stake `api/src/lib.rs` | executable |
| ORE Stake account | PDA `["stake", authority]`; steel account, 8-byte discriminator (108), then `authority: Pubkey`, `balance: u64` | ore-stake `api/src/state/{mod,stake}.rs` | — |
| Seeker Genesis Token | see D-17 | Solana Mobile docs + solana-mobile-dev-skill | — |

**Known limitations**
- The official SKR sample comments "SKR uses 9 decimals" but uses 6. The mint says 6.
- Total SKR stake needs getProgramAccounts across guardian pools, which needs a dedicated RPC
  (OQ-6).

## geoip-country (2026-10-01)

| Field | Value |
|---|---|
| Package | `geoip-country@5.0.202609300220`, installed in `@blink/api` only |
| Purpose | Offline IP → country for the D-20 eligibility cross-check; no IP leaves the server |
| Data | Bundled MaxMind GeoLite2 country data, republished about twice a week; update with `npm update geoip-country` |
| License | MaxMind GeoLite2 License (EULA in the package). The website shows the required attribution: "This product includes GeoLite2 data created by MaxMind" |
| Verified | Lookups tested offline: 8.8.8.8 → US, 197.210.0.1 → NG, 81.2.69.142 → GB, loopback → null (fails closed) |
| Limitation | The README says the code is no longer maintained (the author recommends `ip-location-api`, which downloads data at runtime). Data releases continue. Revisit before production. VPNs defeat IP checks, which is why the declaration + attestation is primary and the IP is a cross-check |

# BLINK-TO-STOCK — FINAL LOCKED MASTER BUILD SPECIFICATION

> **STATUS: INCOMPLETE.** This file holds only the sections Maris has delivered so far.
> The original paste was truncated inside §26. Maris will provide the rest.
> **Do not implement behaviour from sections that are not in this file.**
>
> Received so far:
> - §0–§25 in full, and §26 up to its first example sentence (2026-09-29)
> - Owner corrections (2026-09-29), below
> - "VPS ISOLATION — NON-NEGOTIABLE" (2026-09-29); its section number is not yet known
>
> Missing: the rest of §26 and every section after it.

---

## Owner corrections (2026-09-29)

1. Mobile base template: the official Solana Mobile Privy + Solana Kit + Expo sample. The CLI ID is
   `gh:solana-mobile/templates/mobile/sample-expo-kit-privy` (verified 2026-09-29; see DEPENDENCIES.md).
   Do not substitute a different wallet or auth architecture.
2. Creator authentication uses the verified Privy/MWA SIWS flow (`useLoginWithSiws` + MWA `signMessages`).
   Do not construct an authentication message from scratch.
3. The architecture stays locked to creator-owned delegated campaign treasuries: no custom mainnet
   contract and no central custodial Blink treasury.
4. No mainnet transactions may be executed.
5. Do not improvise the missing security-critical sections.

---

## 0. Product

**Name:** Blink-to-Stock

**Positioning:** The Social Distribution Network for Tokenized Stocks.

**Core idea.** Blink-to-Stock turns tokenized stocks into shareable mobile experiences. Normally,
getting a tokenized stock means installing a crypto wallet, managing a seed phrase, acquiring SOL,
finding an exchange, searching for the tokenized stock, understanding Token-2022 and executing a
trade. Instead, a friend, creator, community or business creates a stock campaign and shares a
simple link or QR code. The recipient opens Blink-to-Stock, authenticates, completes the campaign
action and receives a real tokenized stock on Solana.

**Campaign examples:** Gift → Stock; Tap → Stock; Early Claim → Stock; Referral → Stock;
Seeker Participation → Stock. Future: ORE Action → Stock; Market Challenge → Stock.

**Product thesis:** "Tokenized stocks should not only live inside trading applications. They should
become shareable, programmable and social internet objects." Blink-to-Stock makes the internet
itself a distribution layer for tokenized equities.

## 1. Hackathon objective

The build targets the Solana Mobile CLOCK IN Hackathon. The product MUST:

- be Android-first and produce a functional Android APK
- use Solana meaningfully
- integrate Mobile Wallet Adapter (MWA) for genuine actions
- feel designed for mobile rather than wrapped from a website
- contain real product functionality
- run on ordinary Android phones and be suitable for Seeker
- be architected for eventual Solana dApp Store publication

**Submission package:** functional Android APK, GitHub repository, demo video, and a pitch deck or
brief presentation.

**Hard internal deadline:** October 9, 2026 at 07:59 GMT+1.

Anything threatening these four deliverables is deprioritized:
1. working Android APK
2. working MWA
3. real mainnet xStock settlement
4. reliable hero demo

## 2. Judging strategy

CLOCK IN judging has four equally weighted criteria:

- **25% Stickiness / PMF.** Reasons to return: live drops, Tap Rush, ending-soon campaigns, reward
  notifications, activity, portfolio, and future streak mechanics.
- **25% User Experience.** Haptics, full-screen Tap Rush, QR camera scanning, native Android
  sharing, fast authentication, clear transaction states, polished error and loading states, and
  minimal blockchain jargon.
- **25% Innovation / X-factor.** "Stocks become shareable internet objects." Users can send,
  drop, play for, earn and socially distribute stock.
- **25% Presentation / Demo.**

**Hero flow:** Creator opens Blink → creates a Tap Rush → authenticates with MWA + SIWS →
creates and funds the campaign treasury → approves the exact Blink distribution allowance →
campaign becomes LIVE → shares a QR code → a second Android phone scans it → the recipient plays
Tap Rush → the recipient earns a real xStock → Solana mainnet settlement → explorer receipt.

Everything we build should strengthen this flow.

## 3. Team

- **Maris — human project owner.** Final authority over architecture changes, scope, mainnet
  spending, production infrastructure, credentials, compliance release decisions, release signing,
  merges and hackathon submission. Only Maris can approve actual mainnet spending.
  Raw production private keys MUST NOT be pasted into AI chats, committed to Git, written into docs,
  bundled in the APK or exposed in logs. Prefer managed signing infrastructure over manually handled
  raw keys.
- **Claude Code — Lead Architect + Mobile Owner.**
  - Owns `apps/mobile/`, `packages/domain/` and `packages/validation/`.
  - Responsible for: Android architecture, React Native / Expo, navigation, Privy consumer auth,
    MWA UX, SIWS UX, campaign creation UX, Tap Rush, haptics, QR scanning, native share, deep links,
    App Links, portfolio, activity, push UX, Seeker UX, the release APK and end-to-end integration.
  - Owns the docs `docs/ARCHITECTURE.md` and `docs/DEMO_RUNBOOK.md`.
  - Reviews Codex work for API contract compatibility, mobile assumptions, UX regressions,
    integration regressions and client-visible security issues.
- **Codex — Backend + Solana + Reliability Owner.**
  - Owns `apps/api/`, `packages/solana/`, `packages/xstocks/`, `packages/config/`, `prisma/` and
    `scripts/`.
  - Responsible for: the Fastify API, PostgreSQL, Prisma, the campaign engine, authentication and
    SIWS verification, claims, campaign state, Tap Rush server sessions, FOMO ordering, idempotency,
    payout orchestration, reconciliation, Token-2022, xStocks, Scaled UI math, campaign accounts,
    delegation, the fee payer, rent estimation, SOL budget controls, audit logs and tests.
  - Owns the docs `docs/SECURITY.md`, `docs/MAINNET_CHECKLIST.md` and `docs/MAINNET_SMOKE_TEST.md`.
  - Reviews Claude work for API correctness, wallet assumptions, amount handling, client-trust
    mistakes and secrets accidentally entering the APK.

## 4. Agent boundaries

- Agents do not casually edit each other's owned directories.
- Cross-agent requests go into `docs/HANDOFF.md`.
- Shared documents that both agents may append to: `docs/DECISIONS.md`, `docs/DEPENDENCIES.md`,
  `docs/OPEN_QUESTIONS.md`, `docs/HANDOFF.md` and `docs/SPIKES.md`.
- Claude owns the shared API contracts under `packages/domain/` and `packages/validation/`.
- Contract changes must be recorded in `HANDOFF.md` before Codex depends on them. No silent breaking
  API changes.

## 5. Anti-hallucination protocol

**5.1 Verify before use.** Every package, version, import, hook, method, CLI command, CLI flag,
API endpoint, Solana instruction, program ID, mint address, Seeker identifier and config property
must be verified from at least one authoritative source:
1. installed package definitions or source
2. official documentation
3. the official repository
4. onchain RPC verification

**5.2 Addresses never come from memory.** Never use a mint, program ID, SGT group or token address
because an AI remembers it. Reverify.

**5.3 Record dependencies** in `docs/DEPENDENCIES.md`: dependency or service, version, purpose,
authoritative source, date verified, and known limitation.

**5.4 Status vocabulary:** VERIFIED, ASSUMPTION, BLOCKED, NEEDS_OWNER_DECISION. Never disguise
assumptions as facts.

**5.5 No invented success.**
- Never report "Mainnet works." unless a real transaction exists.
- Never report "APK works." unless it was built and installed.
- Never report "MWA works." unless it was actually tested.

Completion reports include the command run, the result, relevant output, and the transaction
signature where applicable.

**5.6 No fake metrics.** Never fabricate users, TVL, stock distributed, campaigns, transactions,
volume or revenue. Preview fixtures are allowed only under `DEMO_MODE=true` and must be visibly
labelled.

## 6. Locked V1 architecture

DO NOT DEPLOY A CUSTOM SOLANA PROGRAM TO MAINNET FOR V1. That means no Anchor program, no Pinocchio
program, no custom escrow, and no central Blink custody treasury. Blink handles social and campaign
eligibility; existing Solana infrastructure handles settlement.

**Correct trust statement:** "Blink determines campaign eligibility; asset settlement is
transparent and verifiable on Solana mainnet." Do NOT claim "Fully trustless campaigns."

## 7. SOL budget

Blink-funded mainnet infrastructure:

| Limit | Amount |
|---|---|
| Target | ≤ 0.02 SOL |
| Soft fallback | ≤ 0.05 SOL |
| Hard ceiling | 0.10 SOL |

No operation may cross the hard ceiling without explicit Maris approval.

Implement `MAINNET_BUDGET_LAMPORTS`, `MAINNET_ENABLED` and `MAINNET_GO_APPROVED`.
Track `spentLamports`, `reservedLamports` and `estimatedNextOperationLamports`.

Before a Blink-sponsored mainnet transaction, check that
`spent + reserved + estimatedNextOperation <= configuredBudget`.
If false: DO NOT SEND THE TRANSACTION.

## 8. Who pays what

- **Creator pays:** campaign auxiliary token-account rent, the campaign funding transaction, the
  delegation approval transaction, the revoke transaction and the campaign cleanup transaction.
  Reclaimed campaign-account rent returns to the creator after proper closure.
- **Blink / campaign sponsor pays** (hackathon MVP): the missing recipient xStock token-account
  rent when Blink sponsors it, the reward transaction fee, and a priority fee only if explicitly
  justified.
- **Recipient pays:** 0 SOL in the normal consumer claim experience.

Do not silently use Blink's SOL to pay for creator-side setup.

## 9. Delegated campaign treasury

Authoritative funding architecture:
1. The creator selects a supported xStock.
2. Create a dedicated auxiliary Token-2022 account.
3. The creator is the token authority.
4. The creator transfers only the campaign inventory into it.
5. The creator grants Blink an exact capped allowance.
6. Blink distributes qualified rewards as delegate.
7. The delegated amount decreases after payouts.
8. The creator can revoke.
9. Blink pauses the campaign if funding or delegation becomes invalid.

**Correct product wording:** "Your campaign stock stays in an account you own. Blink can only
distribute the amount you approve." Never call this escrow.

## 10. The campaign account is not an ATA

The creator already has a canonical ATA for creator + mint; a campaign needs another Token-2022
account. The flow is: creator ATA → campaign inventory → auxiliary campaign token account → Blink
delegate → recipients.

Never reuse the creator's personal ATA as the campaign treasury. Never attempt to create a second
canonical ATA.

## 11. Preferred auxiliary account creation

**Preferred path: `CreateAccountWithSeed`.** Use the System Program's currently supported
seed-derived account creation, if it is compatible with the selected Token-2022 account.
Advantages: no persistent extra keypair, a deterministic account, the creator (base wallet) can
authorize via MWA, easier recovery and verification, and fewer signer compatibility problems.

Conceptually: base = the authenticated creator wallet; seed = a deterministic campaign seed; owner
program = Token-2022. Then initialize the account with mint = the selected xStock and token
authority = the authenticated creator.

**Seed limit.** `CreateAccountWithSeed` seeds must not exceed the current Solana maximum. Use a
seed of 32 bytes or fewer.
- **Preferred:** `campaignSeed` = the campaign UUID with hyphens removed. For a standard UUID this
  is exactly 32 ASCII hexadecimal characters.
- **Do NOT** use campaign UUID + mint; that exceeds the allowed seed length.
- **If campaign IDs change format**, use a deterministic hash instead, such as
  `sha256(campaignId + ":" + mint)` → hexadecimal → the first 32 ASCII characters.

The exact function must be documented and covered by tests.

Store `campaignSeed` and `derivedCampaignAccount`. On every operation, independently derive the
expected address. Never trust a campaign-account address supplied by the client. If the derived
address unexpectedly already exists: STOP AND INVESTIGATE. Do not silently choose another.

## 12. Fallback auxiliary account creation

If `CreateAccountWithSeed` is proven incompatible with the actual Token-2022 account requirements,
use a fresh account signer/keypair only as an approved fallback. Rules: the private key exists only
during transaction creation and signing; it is never persisted in AsyncStorage, sent to the backend,
logged, sent to analytics or committed.

Document why seed creation failed, and set NEEDS_OWNER_DECISION before switching.

## 13. Token account size

Never assume 165 bytes; Token-2022 extensions can change the required account configuration and
space. Before account creation:
1. inspect the selected mint
2. determine the required extensions
3. calculate the account size
4. query the rent-exempt minimum
5. record and display the estimate

The rent estimator is authoritative.

## 14. Delegate model

**Preferred: ONE PROTECTED DELEGATE PER CAMPAIGN.** A compromise of Campaign A cannot
automatically spend Campaign B's allowance; native delegation additionally caps exposure, so the
blast radius is one campaign.

Preferred signing infrastructure: a Privy server-managed wallet or equivalent managed
infrastructure, but only after current support is verified.

**Deadline: September 30, 2026.** By then, Codex must resolve whether Privy can:
- create and manage Solana server wallets
- support one per campaign
- sign the required Token-2022 transactions
- support our intended policy controls
- do so without unacceptable operational overhead

Record the findings in `docs/SPIKES.md` with the result VERIFIED, or BLOCKED /
NEEDS_OWNER_DECISION. Do not let this remain unresolved after September 30. Do not silently switch
to a shared global delegate.

## 15. Privy policy

Privy policies are defense in depth. The primary hard onchain boundary is the exact Token-2022
delegated allowance.

Attempt to additionally restrict: permitted program IDs, the source account, the transaction
amount, recipients (if supported), and forbidden instructions.

Before relying on structured SPL policy parsing, prove that current Privy policies understand the
Token-2022 instructions actually used. If they don't:
- keep per-campaign delegate isolation
- keep the exact native allowance
- allowlist the necessary programs where supported
- enforce backend constraints
- document the limitation

Never advertise policy guarantees that were not tested.

## 16. Fee payer

Use a separate low-balance fee-payer wallet. The fee payer holds no campaign stock, has no campaign
delegate authority, holds minimal SOL, is monitored, is replaceable, and uses secure server-side
signing.

Never combine campaign inventory, delegate authority and a large SOL balance in one key.

## 17. Solana Mobile bootstrap

Use the official Solana Mobile CLI. First run `npx solana-mobile@latest create --list-template-ids`,
which returns the exact template IDs; when useful, also run
`npx solana-mobile@latest create --list-templates` to inspect descriptions. Choose the current
Expo + Solana Kit + Privy template returned by the CLI; trust the current CLI output, not this
document.

Record in `docs/DEPENDENCIES.md`: the CLI version, template ID, source, verification date and the
generated package versions.

**Environment doctor.** Before relying on `npx solana-mobile@latest doctor`, verify that it exists
in the current CLI (`npx solana-mobile@latest --help`). If present, run it and record material
environment failures. Do not assume undocumented flags exist.

**Non-negotiable: DO NOT USE EXPO GO.** MWA requires native Android modules; use an Android
development build.

## 18. Expected mobile stack

After verification: React Native, Expo, Expo Router, TypeScript, Solana Kit, Mobile Wallet Adapter,
the official/current Solana Mobile wallet tooling, Privy, and template-supported styling such as
Uniwind.

Do not replace Solana Kit with legacy web3.js unless a verified blocker requires it and the
decision is recorded.

## 19. Backend stack

Node.js, TypeScript, Fastify, PostgreSQL, Prisma and Zod. Prefer current Solana Kit and current
official Solana packages where compatible. The RPC provider must be reliable. Secrets stay
backend-only.

## 20. Seeker RPC policy

Seeker verification is an allowed exception to provider neutrality. The official Seeker
verification implementation/guidance may use Helius, including its enhanced token-account methods,
so Codex may use Helius specifically for SGT verification if it matches the current official
Solana Mobile reference implementation.

Preferred decision order:
- **Option A — Standard RPC.** If ordinary Token-2022 `getTokenAccountsByOwner` provides everything
  needed to securely verify SGT membership and current balance at acceptable performance, use
  standard RPC.
- **Option B — Helius.** If the official Seeker verification implementation depends on Helius, or
  Helius materially simplifies correct verification, use Helius server-side.

Rules for Helius:
- the API key is backend-only; never expose the Helius secret or key in the APK
- verify response semantics
- verify the SGT mint/group relationship; never rely only on provider labels
- document the provider dependency

Do not reject Helius merely for being vendor-specific when it is used to implement official Seeker
verification guidance.

## 21. Repository structure

```
blink-to-stock/
  apps/{mobile,api}/
  packages/{domain,validation,solana,xstocks,config}/
  prisma/
  scripts/{inspect-xstock,estimate-rent,verify-delegation,devnet-test-mint,smoke-mainnet}.ts
  docs/{MASTER_PROMPT,ARCHITECTURE,SECURITY,MAINNET_CHECKLIST,MAINNET_SMOKE_TEST,DEPENDENCIES,
        DECISIONS,OPEN_QUESTIONS,HANDOFF,SPIKES,DEMO_RUNBOOK}.md
  .env.example  README.md  package.json
```

Adapt only when official template requirements demand it.

## 22. Environments

The explicit environments are `local`, `test` and `mainnet`. Development defaults to devnet/local
testing.
- Mainnet requires `SOLANA_CLUSTER=mainnet-beta` and `MAINNET_ENABLED=true`.
- Actual spending additionally requires `MAINNET_GO_APPROVED=true`.

If a required mainnet guard is absent: REFUSE EXECUTION. Never infer the cluster from UI state.

## 23. Android identity

Lock this early. Defaults, unless Maris changes them before initialization:
- Android package: `com.blinktostock.app`
- Custom URI scheme: `blinktostock`
- Production HTTPS domain: configurable via `PUBLIC_WEB_ORIGIN`. Do not invent one.

Do not rename the package after Privy registration, App Links configuration or release signing
without explicit approval.

## 24. Privy consumer auth

Primary CTA: "Continue with email". Privy provides authentication and the embedded Solana wallet
experience. The backend verifies every Privy session using current official server APIs. Never
trust a client-supplied `userId`, `email` or `walletAddress` without verified auth context.

## 25. Creator authentication

Connecting an MWA wallet is not backend authentication. Creators authenticate with the current
official Sign In With Solana / MWA `signIn` flow.

Conceptual flow: backend nonce → MWA/SIWS → wallet signs → backend verifies the exact signed
payload → nonce consumed → creator session bound to the public key.

Requirements: a cryptographically random nonce, short expiry, the expected domain, one-time use,
exact payload verification, and a session bound to the verified key.

Never trust `{"creatorWallet":"..."}` from mobile as authentication.

*(Owner correction 2: use the verified Privy/MWA SIWS flow rather than constructing an
authentication message from scratch.)*

## 26. Mobile Wallet Adapter *(TRUNCATED)*

MWA must be meaningful. Use it for:
- creator wallet authorization
- SIWS
- campaign account/funding signing
- delegate approval
- revoke/cleanup
- Seeker wallet authentication

Never access Seed Vault private-key material. Blink requests signatures; the wallet handles keys.

Before opening MWA, explain the action plainly. Example:

«Fund this campaign with X NVDAx an… **[TRUNCATED — remainder not yet received]**

---

## VPS isolation — NON-NEGOTIABLE *(received 2026-09-29; section number TBD)*

Blink-to-Stock will run on a VPS that already contains other projects. Those projects MUST NOT be
modified, stopped, restarted, upgraded, reconfigured, overwritten or reused. Blink must operate as
a completely isolated application.

- **Directory:** a dedicated directory such as `/opt/blink-to-stock/` or
  `~/projects/blink-to-stock/`. Never place Blink files inside another project's directory. Before
  deployment, inspect the VPS to determine which directories are already in use. Do not delete,
  move or modify existing project files.
- **Git:** Blink-to-Stock uses its own Git repository. Never initialize Blink inside another
  project's repository, reuse another project's `.git`, modify another project's branches, or copy
  secrets from another repository.
- **Environment:** Blink gets its own `blink-to-stock/.env`; never reuse another project's `.env`.
  Use Blink-specific values for the database, ports, RPC, Privy, public URL, Redis (if introduced),
  notification credentials, wallet infrastructure and logging. Do not overwrite global environment
  variables used by other applications.
- **Database:** Blink has its own PostgreSQL database (e.g. `blink_to_stock`), preferably with a
  dedicated user (e.g. `blink_app`). Never point Prisma at another project's database. Before
  running migrations:
  1. print the target database name
  2. verify it is the Blink database
  3. refuse the migration if the database identity is uncertain

  Never run `prisma migrate reset` against an unknown, shared or production database.
- **Ports:** Before selecting ports, inspect the currently listening services (e.g. `ss -tulpn`)
  and choose unused Blink-specific ports. Example only: Blink API 4310, Blink internal service
  4311. Do NOT blindly use 3000, 3001, 4000, 5000 or 8080 without checking. Ports must be
  configurable through environment variables.
- **PM2:** Use unique names such as `blink-api` and `blink-worker`, never generic names (`api`,
  `server`, `backend`, `app`). Inspect existing PM2 processes before starting or restarting. Never
  run `pm2 restart all`, `pm2 stop all` or `pm2 delete all` on this VPS. Only operate on
  Blink-specific process names.
- **Docker:** Preferred where practical, if Docker is already installed and using it will not
  disturb existing projects. Use a dedicated Compose project (e.g. `blink-to-stock`) with unique
  container names (e.g. `blink-api`, `blink-postgres`, `blink-worker`), its own network
  (e.g. `blink-network`) and Blink-specific volumes (e.g. `blink-postgres-data`, `blink-uploads`).
  Do not attach Blink to another project's private network unless it is explicitly required and
  approved. Never reuse another application's volume, and never delete unnamed or unknown volumes.
  Forbidden unless Maris explicitly authorizes them after reviewing the affected resources:
  `docker system prune -a`, `docker container prune`, `docker volume prune`,
  `docker stop $(docker ps -q)`.
- **Logs:** Use Blink-specific paths or services (e.g. `/var/log/blink-to-stock/`). Do not write
  into another project's log directory.
- **Reverse proxy:** If Nginx, Caddy or Traefik already serves other projects, do NOT replace the
  global configuration; add only a Blink-specific virtual host or route after inspecting the
  existing configuration. Before reloading:
  1. back up the relevant configuration
  2. run config validation (`nginx -t` must succeed)
  3. confirm existing domains remain configured
  4. reload; do not restart unnecessarily

  Never overwrite another site's configuration.
- **No global mutations:** Prefer project-local dependencies. Do not casually upgrade global Node,
  replace system Python, upgrade PostgreSQL, change system-wide environment variables, modify global
  npm packages, alter firewall rules, change Nginx globally or change the Docker daemon
  configuration. If a global change is genuinely required, mark it NEEDS_OWNER_DECISION and explain
  why before performing it.
- **Runtime version:** Use a version manager or a containerized runtime. Record the required
  version in `.nvmrc`, `.tool-versions` or the Docker configuration. Never upgrade the VPS's global
  Node version merely for Blink.
- **Pre-deployment inventory (READ-ONLY):** Record in `docs/VPS_INVENTORY.md` the relevant project
  directories, listening ports, PM2 processes, running Docker containers, Docker networks and
  volumes, PostgreSQL databases and users (where safely inspectable), reverse-proxy sites and
  routes, the Node version, and available disk space and memory. Include no secrets. The inventory
  is used only to prevent collisions.
- **Safety rule:** If a command could affect a project other than Blink-to-Stock: STOP, mark
  NEEDS_OWNER_DECISION, explain which command is required, what other resources it might affect and
  why it is necessary, and wait for Maris's approval.
- **Deployment invariant:** Blink-to-Stock must be independently started, stopped, restarted,
  updated, migrated, rolled back, logged and backed up without affecting any other application on
  the VPS. If this invariant is not true, the deployment architecture is incorrect.

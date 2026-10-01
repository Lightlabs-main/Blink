# Verifier architecture (product update 2026-10-01)

**Status:** DESIGN. No code yet; implementation waits for the build-order section of the update.

Each fact below is marked by how it is known:
- **[official]** an official source;
- **[onchain]** checked against mainnet;
- **[inference]** Claude's reading of code or sample, not stated by the source.

## Model

- A **condition** is `{ verifier, version, config }`. Config holds only creator-tunable values, such
  as a minimum raw amount. Protocol addresses come from the registry, never from the creator.
- A **group** is `{ mode: 'ALL' | 'ANY', conditions[] }`.
- **Requirements** are `{ eligibility: Group[], actions: Group[] }`. Every group must pass (implicit
  AND). There is no deeper nesting.
- **Freezing:** requirements are stored with the campaign when it's created (version + hash) and
  can't be edited once LIVE. A change needs a new campaign or revision.
- **Result:**
  - status: `NOT_STARTED | CHECKING | PASSED | FAILED | PENDING | ERROR | STALE`
  - evidence summary: raw amounts as strings, wallet, slot, source, `checkedAt`, `expiresAt`,
    failure reason
- **Two views:** private evidence stays server-side, and public/mobile DTOs carry the summary only.
- **Timing:** current state immediately before reservation (§20). A result older than its TTL is
  `STALE`, which fails.
- **Wallets checked:** the caller's Privy-verified wallets only, meaning SIWS-linked external
  wallets plus their embedded wallet. Never a typed or pasted address.
- **Separate gate:** xStocks eligibility (SECURITY.md §1) is **not** a verifier in this model, and
  no requirement combination can satisfy it.

## Registry (allowlisted)

| Verifier | Kind | Canonical data | State |
|---|---|---|---|
| `SEEKER_SGT` | eligibility, read-only | SGT mint checks (D-17) [official][onchain] | implemented (D-17) |
| `SKR_BALANCE` | eligibility, read-only | SKR ATA balance (SPL Token) of each verified wallet; mint `SKRbvo…ZhW3`, decimals read from the mint (6) [official][onchain] | planned |
| `SKR_STAKED` | eligibility, read-only | sum of every `UserStake` for the wallet; see below | planned; **needs a dedicated RPC** |
| `SKR_TOTAL` | eligibility, read-only | `SKR_BALANCE + SKR_STAKED` (one wallet set, one evaluation) | planned |
| `ORE_BALANCE` | eligibility, read-only | ORE ATA balance; mint `oreoU2…ybcp`, 11 decimals [official][onchain] | planned |
| `ORE_STAKED` | eligibility, read-only | ore-stake `Stake.balance` at PDA `["stake", wallet]` | planned |
| `ORE_ACTIVITY` | action | — | **DISABLED**: no deterministic, replay-safe evidence defined (§9, §29) |
| `TAP_RUSH` | action | server-timed round with tap-timing checks (D-13, D-14) | implemented as a mechanic; becomes a module |
| `X_QUEST` | action | — | **BLOCKED / POLICY_REVIEW_REQUIRED** (§19); registry slot only |

## SKR staked aggregation

- **Program** `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` [official][onchain]; **config**
  `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw` [official][onchain].
- **UserStake** has one PDA per (config, user, guardian pool): `["user_stake", config, user,
  guardian_pool]` [official sample + IDL].
- **Layout** [IDL]: discriminator `[102,53,163,107,9,138,87,153]` (8 bytes) · bump u8 ·
  stake_config (offset 9) · user (offset 41) · guardian_pool (offset 73) · shares u128 (offset 105)
  · cost_basis u128 · cumulative_commission_before_staking u128 · unstaking_amount u64 ·
  unstake_timestamp i64.
- **Aggregation** [inference from the IDL, checked by tests]:
  1. `getProgramAccounts(program)` filtered by the discriminator at offset 0, `stake_config` at
     offset 9 and `user` at offset 41.
  2. For each account, check program ownership and recompute the PDA from its own `guardian_pool`.
     Skip mismatches.
  3. Staked raw = Σ shares × `StakeConfig.share_price` / 1e9.
  4. `unstaking_amount` is **excluded**: it's leaving the stake and no longer earning.
- **Tests:** one position; several positions; zero; a closed or stale account; wrong owner program;
  wrong config; wrong network (a non-mainnet genesis is refused).
- **RPC:** the public RPC rate-limits `getProgramAccounts`, so production needs a dedicated mainnet
  RPC (OQ-6). Until then the verifier returns `ERROR`, never a pass or fail.

## ORE staked

- **Program** `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH` [official][onchain].
- **Stake account** is the PDA `["stake", wallet]` [official]. It's a steel account: 8-byte
  discriminator (enum `Stake = 108`) [official], then `authority` (offset 8) and `balance` u64
  (offset 40) [inference from the `#[repr(C)]` layout; checked by tests and onchain before enabling].
- **Checks:** the owner is the program, the PDA is recomputed and matches, the authority equals the
  wallet, and the network is mainnet.

## Extension point

A new verifier needs:
- a registry entry (type, version, config schema, chain, read-only flag, enabled flag);
- a server evaluator that returns the result shape above;
- tests.

The campaign model and the UI render conditions generically by type. A future, policy-compliant
social verifier (§19) plugs in the same way after review, with nothing else to refactor.

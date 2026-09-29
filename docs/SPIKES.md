# Spikes

## SPIKE-1 — Privy server wallets as per-campaign delegates (MASTER_PROMPT §14/§15)

- **Deadline:** 2026-09-30
- **Owner:** Codex. Research done by Claude on 2026-09-29 at Maris's request.
- **Overall status:** PARTIALLY VERIFIED from docs and installed SDK types. The live test is
  **BLOCKED** until a Privy app ID and app secret exist in the backend `.env`.
- **Nothing was executed against Privy or any cluster.**

### Sources

- Docs (fetched 2026-09-29):
  - `docs.privy.io/wallets/wallets/create/create-a-wallet`
  - `/controls/policies/overview`
  - `/controls/policies/example-policies/solana`
  - `/authentication/user-authentication/access-tokens`
- Installed SDK: `@privy-io/node@0.35.0` type definitions.

### Findings

| # | Question (§14) | Status | Evidence |
|---|---|---|---|
| 1 | Create/manage Solana server wallets? | VERIFIED (docs + types) | `privy.wallets().create({ chain_type: 'solana', owner, policy_ids, additional_signers })`. The owner can be `{ public_key }`, a P-256 authorization key held by our backend ("You must use a server-side SDK to create wallets owned by an authorization key"). |
| 2 | One wallet per campaign? | ASSUMPTION | Nothing in the docs we read limits the number of wallets, but we found no quota or pricing statement either. Maris: confirm plan limits and pricing in the Privy dashboard. |
| 3 | Sign the required Token-2022 transactions? | VERIFIED at the API level; NOT live-tested | `privy.wallets().solana().signTransaction(walletId, { transaction, authorization_context })` and `signAndSendTransaction(...)` accept arbitrary serialized transactions. Signing is program-agnostic, so a Token-2022 `TransferChecked` with the Privy wallet as delegate authority should sign. We have to prove it on devnet. |
| 4 | Policy controls for our instructions? | **UNVERIFIED for Token-2022** | Field source `solana_token_program_instruction` is documented as "Fields relevant to the **SPL Token Program**" (Transfer, TransferChecked, Burn, MintTo, CloseAccount, InitializeAccount3). Token-2022 is never mentioned. The overview's TransferChecked field list omits `.mint`, but the USDC example uses `TransferChecked.mint`, so the docs contradict each other. `solana_program_instruction.programId` allowlisting is generic and should work for Token-2022 and ATA program IDs. |
| 5 | Operational overhead? | ASSUMPTION: acceptable | One `wallets().create` call per campaign plus one policy. The authorization private key is a backend secret (base64 PKCS8, passed in `authorization_context.authorization_private_keys`). |

### Security caveat — NEEDS_OWNER_DECISION

If every campaign wallet is owned by **one** Blink authorization key, stealing that key compromises
every campaign's delegate. Each loss is still capped by its native Token-2022 allowance
(§15 primary boundary). But the "Campaign A compromise cannot spend Campaign B" property from §14
then holds only for the *wallet* keys, not for the *authorization* key. Options:

- **A.** One authorization key, per-wallet policies, and a strict per-campaign allowance. Simplest;
  the blast radius is the sum of live allowances.
- **B.** A key quorum (e.g. a backend key plus a second key held elsewhere) as owner. Stronger, with
  more operational steps.
- **C.** A distinct authorization key per campaign. This moves the storage problem instead of
  solving it; not recommended.

Recommendation: **A** for the hackathon, with a low total live allowance, and document the
limitation in SECURITY.md. Maris to decide.

### Live test plan (devnet; needs Privy app credentials)

1. Create a Privy Solana wallet owned by a test authorization key, with a policy that allowlists
   programIds = [Token-2022, System, Compute Budget, ATA].
2. Create a devnet Token-2022 test mint (`scripts/devnet-test-mint.ts`, not yet written).
3. Create a campaign token account via CreateAccountWithSeed + InitializeAccount3 and ApproveChecked
   to the Privy wallet.
4. Sign a TransferChecked with the Privy wallet as delegate: expect success.
5. Sign a TransferChecked above the allowance: expect an onchain failure.
6. Add a `solana_token_program_instruction` condition (`TransferChecked.amount lte X`) and check
   whether Privy evaluates it for a Token-2022 instruction. Record VERIFIED or BLOCKED.
7. Test a transaction using a program outside the allowlist: expect a Privy denial.

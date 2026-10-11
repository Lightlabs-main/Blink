# Submission demo runbook

Status (2026-10-11): **the demo is not yet recorded.** The steps below are what to record. Each step is
marked with what has been verified so far, so the video shows only what works on the day.

## Hero flow (record this first)

`Open a Drop → qualify or complete the action → verify → xStock settles → receipt`

1. **Open a Drop.** Scan the Drop QR or tap its link on the phone. The Drop shows the stock, the amount
   per person and the requirements.
2. **Qualify or complete the action.** Use Tap Rush, a check-in, or a Verified Quest requirement.
3. **Verify.** The server checks the requirement before any stock is reserved.
4. **xStock settles.** The reward is paid from the creator's delegated treasury. Show the amount that arrived.
5. **Receipt.** Open the receipt and show its Solana transaction signature. Open that signature in the
   Solana explorer to prove it.

Verified in code and on the live server: steps 1–5 exist on mainnet. Not yet verified on a phone for this
build: all five steps end to end. Record them on the phone before relying on them.

## Sponsor story (only if the steps below work on the day)

`SKR boost features the Drop → a user enters → a confirmed ORE deploy clears the quest → xStock settles → the receipt shows the signatures`

- **SKR boost:** the creator pays the owner-approved SKR package from their wallet. The Drop shows
  "Boosted with SKR" until the stated time. Verified on the server: the boost is activated only from a
  confirmed transfer. Not yet verified on a phone.
- **ORE quest:** an ORE mining quest clears only after the server verifies a confirmed deploy to the current
  round from the user's wallet. **Currently off for reward drops** (`ORE_REWARDS_ENABLED=false`), so this
  sponsor story is not available for real xStock rewards. Use it only as the non-financial ORE Miner mark.

Do not show the sponsor story as working unless you have recorded it working.

## Optional appendix (only if time allows; not part of the hero flow)

- **Clubs:** open a club, show the chat, roles and a member's profile card.
- **Chat:** send a message and a voice note.
- **Passport:** show the verified marks and participation record.
- **Squad:** join a Tap Rush squad and show the combined goal.
- **Gifts:** gift a person by username, or gift a drop to a pasted list of names.
- **Event QR:** check in once at an event QR.

## Before you record

1. Install the final APK (`docs/MOBILE_STACK_VERIFICATION.md` lists its version and hash).
2. Use a wallet with a little SOL and the test-approved amounts only. Tell me before any real transaction.
3. Confirm the website and the app show the same live drops.
4. Keep the phone's Android version and device model for the verification record.

## After you record

- Record each receipt's transaction signature in `docs/MOBILE_STACK_VERIFICATION.md`.
- Any step that didn't work on the day is marked **not shown** rather than cut silently.

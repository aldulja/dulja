# ADR 0060 — Argon2id in WebAssembly: one PIN function for the server, the tests and the till

- Status: **proposed** (spec:95 — a decision touching security is written as a proposal and asked before implementing)
- Date: 2026-09-05
- Slice: 6C

## Context

spec:2132 makes the cashier PIN the only credential the application itself hashes, and names the
algorithm: Argon2id with a per-cashier salt. The same function must run in three places:

1. `apps/api` on **Bun** — the set-PIN and reset-PIN routes.
2. **Vitest on Node 24** (D5) — every test in this slice and in 6B.
3. **Electron's main process at the till** (6B) — the PIN is *verified* offline against the
   down-synced `catalogue_cashier` mirror, with no network and no server.

A native N-API module (`@node-rs/argon2`, `argon2`) satisfies the first two and makes the third an
electron-builder rebuild problem — the same class of problem ADR 0017 already records for
`better-sqlite3`, and one that produces a till which installs and then cannot log anybody in.
`Bun.password` satisfies only the first: it does not exist under Vitest, so the test tier could not
verify a hash the API produced.

## Decision

`hash-wasm`'s `argon2id` / `argon2Verify`, wrapped in **one** module, `packages/db/src/staff/pin.ts`,
exported from `@dulja/db`. Pure WebAssembly: identical bytes on Bun, Node and Electron, no ABI, no
rebuild step, no per-platform binary in the installer.

Parameters: `parallelism: 1`, `iterations: 2`, `memorySize: 19456` (KiB), `hashLength: 32`, and a
16-byte salt from `crypto.getRandomValues`. `outputType: "encoded"`, so `pos_cashier.pin_hash` is a
self-describing PHC string and the parameters travel with every hash — a later cost increase rehashes
on next set and verifies old hashes unchanged.

A PIN is low-entropy by construction, so the cost parameter is the whole defence and the band
`PIN_MIN_LENGTH = 4` / `PIN_MAX_LENGTH = 12` is enforced in `hashPin` rather than only in Zod: the
function that stores the credential is the one that must refuse a one-character one.

## Consequences

- `packages/db` gains one runtime dependency. It is pure WASM, so `packages/db` stays importable from
  `apps/worker`, `apps/api` and (through 6B's main process) Electron, with no change to §3.1's tiers.
- The PIN never leaves the till except at set/reset time, and the server never compares one:
  `verifyPin` exists in `@dulja/db` for 6B to call locally, and **no route in this slice calls it**.
  A test in Task 10 asserts that, by scanning `apps/api` for the symbol.
- Rotating the cost parameters is a change to this file plus a rehash-on-next-set; no migration.
- If the owner or a reviewer prefers a native module, the change is confined to this one file, and
  6B's ADR 0017 is where the Electron consequence must then be re-argued.

## Proposal preparation

Prepared for owner review on 2026-10-07 from [2026-09-05-dulja-phase-6c-staff-cashiers-branch-isolation.md](../superpowers/plans/2026-09-05-dulja-phase-6c-staff-cashiers-branch-isolation.md). The source proposal date above is preserved. This record is proposed; no owner acceptance or implementation is recorded here.

## What we are asking

Approve the shared WebAssembly Argon2id implementation and the stated cost parameters and PIN length limits for API hashing and offline till verification?

## PR 12 review amendment — the till's PIN lockout (2026-10-22, proposed)

The PR 12 review found that the till verified a PIN with no failed-attempt limit, so a four-digit supervisor
PIN could be found by trying all ten thousand. spec:476 asks for "rate limiting and lockout on failed
attempts", and the PIN is the one credential the application hashes itself (spec:2132). This amendment
records the policy implemented in `apps/pos/src/main/authority.ts` (`authenticateCashier`) for owner review:

1. Every PIN typed at the till goes through one function: sign-in and every supervisor approval (void,
   overrides, blind return) share one counter per employee number.
2. After `PIN_FAILURES_BEFORE_LOCKOUT` = 5 consecutive wrong PINs the number is locked for
   `PIN_LOCKOUT_BASE_MS` = 5 minutes; each further wrong PIN after a lockout ends doubles the window, capped at
   `PIN_LOCKOUT_MAX_MS` = 60 minutes. Only a correct PIN resets the count.
3. Across all numbers, the till takes at most `TILL_PIN_FAILURES_PER_WINDOW` = 10 wrong PINs per
   `TILL_PIN_WINDOW_MS` = 10 minutes, so one common PIN cannot be sprayed across every employee number.
4. The counter is keyed by the employee number as typed, so an unknown number is counted and locked exactly
   like a real one. A locked attempt is refused with `ERR_RATE_LIMITED` before the lookup and before
   `verifyPin`, so it is neither an oracle nor a timing signal.
5. The state is a `meta` row of the till's SQLite file (owned local bookkeeping, never synced — ADR 0057), so
   restarting the application does not reset it. Both windows are measured from the attempt's own time and
   capped, so a till clock that moves backwards cannot lengthen a lockout beyond its cap.

6. A new credential for an employee number — a manager's PIN reset in the back office, or a new cashier —
   clears that number's lockout when it reaches the till (`mirror.ts`), so the back office is the supervised
   unlock; a snapshot-only change does not.

Accepted trade-offs (owner direction 2026-10-22: best practice): anyone at the keypad can lock a known
employee number for up to an hour, or pause PIN entry at the till for up to ten minutes; the per-number count
decays only on a correct PIN or a new credential; and an offline till trusts its own clock, so someone with
administrator rights on the till's operating system can shorten a lockout.

## Full review amendment — who may cancel an unfinished till ticket (2026-11-15, proposed)

The 2026-11-15 full review (POS-04) found that a shift could not be closed while any of its tickets was open,
even by a holder of `pos.shift.close_any`, and that only the ticket's own cashier could cancel it. A cashier who
left a ticket at the payment step and went home — or was terminated, so that migration 0093 revoked their till
credential — left a till that could neither close the shift, open a new one nor be re-enrolled. This amendment
records the till-side authority rule implemented in `apps/pos/src/main/register.ts` (`cancel_draft`) for owner
review, because it widens who may act at a till:

1. A cashier still cancels only their own unfinished ticket. A signed-in holder of `pos.shift.close_any` — the
   code that already lets them close another cashier's shift — may also cancel another cashier's unfinished
   ticket on this till's open shift, with a reason. No other code admits it.
2. Only a draft no server has seen is cancelled: the existing check refuses a ticket whose outbox row has been
   acknowledged or attempted, so nothing posted is undone and the server is never asked to agree.
3. The cancellation is recorded under the supervisor's own principal (`cashierPrincipalId`), naming the ticket's
   cashier as `onBehalfOfPrincipalId`, beside the reason, in the till's `cancel:<clientRef>` record.
4. The shift screen lists other cashiers' unfinished tickets so the supervisor can see why the close is refused;
   the renderer clears the last cashier's payment screen and basket when another cashier signs in.

**Owner question:** is `pos.shift.close_any` the right code, or should cancelling another cashier's draft need
`pos.ticket.override` (a supervisor approval) instead or as well?

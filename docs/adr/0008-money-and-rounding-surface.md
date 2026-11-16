# ADR 0008 — `Money`, `Quantity` and the one rounding function

- **Status:** Accepted (surface frozen by `docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md` §4.2.1; recorded here because spec §0.2 requires an ADR for anything touching money semantics)
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Spec §3.9 requires `numeric(19,4)` in Postgres and an opaque `Money` type over `decimal.js` in TypeScript that
carries its currency and makes MYR + USD a compiler error. Spec §4.6 requires exactly one rounding function with an
explicit mode, symmetric across sign, applied at persist time (SAH-019). SAH-008 is the failure this prevents: a
unit cost of 500,020.00 produced by a rounding residue in `double precision`.

## Decision

1. `decimal.js` behind a cloned constructor at **precision 40**; no global `Decimal.set`.
2. Four rounding modes, all symmetric across sign: `HALF_AWAY_FROM_ZERO`, `HALF_EVEN`, `TOWARD_ZERO`,
   `AWAY_FROM_ZERO`. No CEIL/FLOOR — an asymmetric mode on a signed amount is SAH-019.
3. `Money.multiply` and `Money.divide` **require** an explicit `RoundingMode` parameter; there is no implicit default.
4. Base conversion is always `HALF_AWAY_FROM_ZERO` at scale 4, because that is what Postgres `round(numeric, int)`
   does and the `ledger_entry` CHECK `base_debit = round(debit * exchange_rate, 4)` (spec §3.8) must hold by
   construction, not by luck. Task 8 proves the agreement against a real Postgres over 10^4 rows.
5. `Money.allocate(weights, mode)` uses the **largest-remainder** method — round each exact share by `mode`, then
   hand the residual minor units one at a time to the shares with the largest positive remainder — with **ties broken
   by lowest index**, which is what makes the contracts document's "residue to the first weight" true for the common
   equal-weights case. Σ of the result equals the input exactly, for every input.
6. The currency literal travels in the type: `currency<const S extends string>(code: S): CurrencyCode & S`, so
   `Money<"MYR">.add(Money<"USD">)` fails `tsc`. The runtime check stays as a second line of defence for values
   crossing the wire, where the literal is erased.

## Consequences

- One place changes if a rounding rule ever changes, and `tests/golden/**` diffs make the change visible (spec §4.11).
- `Money` has no `toNumber()`: there is no supported path from a monetary value to a `number`, which is what makes
  the `no-number-money` lint (§3.7.5) enforceable rather than advisory.
- Display rounding (a currency's `minor_units` / `rounding_mode`, `app.currency`) is a `packages/ui` concern applied
  at render time and is **never persisted** (spec §3.9).

## Open proposal for the owner

The tie-break in (5) and the absence of `toNumber()` in (1) are the two choices the spec does not state. Neither
changes a stored figure that any other rule already fixes; both are recorded here so a reviewer sees them.

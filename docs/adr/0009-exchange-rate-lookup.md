# ADR 0009 — Exchange-rate lookup: greatest effective_from, no interpolation, no synthesised inverse

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 0D

## Context

Spec §3.3 models `Currency ── ExchangeRate(effective_from, source)`; spec §3.8 fixes `source` as a mandatory
provenance string. Nothing states what happens between two rate rows, before the first, or when only the opposite
pair is on file. Every one of those is a place a wrong number can enter the ledger silently, so each is decided here
once rather than in whichever slice hits it first (contracts §4.2.10 fixes the table and the function).

## Decision

1. **Step function, not interpolation.** `app.rate_for(company, from, to, on)` returns the row with the greatest
   `effective_from <= on`. A rate applies from its effective date until the next one supersedes it, and forward
   indefinitely after the last. There is no interpolation between two rows: an interpolated rate has no `source`,
   and an unsourced rate is unauditable.
2. **No row before the first effective date → no rate.** `rateFor()` returns `null` and the caller raises
   `ERR_RATE_NOT_FOUND` (422). The document is refused. A default of 1, or of the nearest later rate, would post a
   wrong base amount that no later correction can distinguish from a real one.
3. **No synthesised inverse.** A `USD→MYR` row does not answer a `MYR→USD` question. `1/4.68` is not a rate anyone
   quoted, and rounding it to 8 places then multiplying back does not return the original. Both directions are
   entered when both are needed.
4. **The identity pair is never stored or looked up.** `rateFor(c, X, X, …)` short-circuits to `UNIT_RATE(X)`
   (rate `1.00000000`, source `unit`), so a same-currency document can never fail on a missing self-rate row.
5. **Rates are per company, currencies per tenant.** A group may hold companies with different base currencies and
   different rate policies; a tenant that trades in USD trades in USD everywhere.
6. **`source` is `not null`.** `'BNM 2026-09-04'` for a published rate, `'manual:<actor_id>'` for a keyed one
   (spec §3.8). `entered_by` is stamped by trigger and is not the same fact: `source` is where the number came from,
   `entered_by` is who put it in.
7. **`currency.pos_rounding_increment` is a display concern only, never applied to a stored amount.** It rounds
   what a POS terminal shows and collects in cash (Malaysia settles to 5 sen); the ledger keeps the exact
   `numeric(19,4)`. Applying it to a stored amount would make the rounding irreversible and the ledger
   disagree with the document.

## Consequences

- 4B's FX settlement and revaluation read the same function; there is one lookup rule in the system, not two.
- A tenant that forgets to enter a rate gets a refused document with a named remedy rather than a silently wrong
  base amount — the SAH-011/SAH-012 class of defect.
- Decision 7 lives here because migration `0005` carries no explanatory comment for the column: the migration is
  applied and forward-only, so the rule is recorded in the ADR rather than by editing it.

# 0074 — The payroll calculator is pure, the rates are data, and every line pins its version

- Status: **Proposed** — the plan records it as accepted, but the calculator decides how every payroll figure is
  derived and what a posted line is pinned to (money semantics, spec:95), so it is asked rather than decided.
  Implemented in 8B Tasks 5–6 ahead of approval, as ADRs 0071–0076 were, under the owner's direction to implement
  Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8B · Tasks 5 and 6
- Contracts: §4.12.1; round 17, A9 and A14

## Context

spec:2080: "This document states no rate, threshold, ceiling or formula." spec:2229 asks for "EPF, SOCSO, EIS
and PCB/MTD as versioned, effective-dated, **verified** rate tables pinned per payroll line". LEGACY-020 is a legacy
GST return that hard-coded a rate; LEGACY-013 is a legacy reversal that re-read _current_ flags instead of what was
originally applied. Both failures are the same shape: a figure that lives in code, or a figure that is re-derived
at read time.

## Decision

Three seams, and no fourth.

1. **`packages/domain/payroll/` is pure and outside `src/`.** It uses `decimal.js` (through `@dulja/domain`'s
   own `D` constructor) for intermediate arithmetic — a proration factor, a band walk — and `Money` for every
   figure it returns, which is what ADR 0022 records D11 to mean. `packages/domain/src/**` may not import it
   (spec:2366, enforced by `dependency-rule` and `test/payroll/dependency.test.ts`); `@dulja/domain/payroll` is
   its one import path.
2. **Every number comes out of a `RateTable`.** `SchemeCalculator.compute(table, input)` reads bands, rates,
   ceilings, floors, brackets and reliefs from `table` and holds none of its own. There are exactly three
   calculators, one per `kind` the §4.12.3 schema admits; a fourth statutory shape is a schema change with a new
   `kind` label, not an `if` inside an existing calculator. Because the schema's `table` is a `oneOf` that does
   not depend on `kind`, each calculator checks that the table it is handed has its own shape and refuses one that
   does not (`RateTableValidationError`, `ERR_VALIDATION_FAILED`).
3. **A run pins what it used.** `PayrollCalculator.calculate` returns `pinnedTables`, and the run service writes
   `payroll_run.pinned_tables` and `payroll_line.rate_table_id` / `rate_table_version`. Nothing re-reads
   `statutory_rate_table` for a posted line, ever. That is LEGACY-013's fix applied to statutory rates.

Refusals rather than defaults: a table with `verified = false`, or whose effective range does not cover the pay
period, raises `ERR_PAYROLL_RATE_TABLE_UNVERIFIED`, and the **whole run** refuses before a single figure is
computed; a scheme an employee's earnings feed with no table raises the same code; a required statutory input
(`required_profile_fields`, or a relief the table reads) that is `null` or absent raises
`ERR_PAYROLL_INPUT_MISSING` naming the employee, the table and the field; a base outside every band, or a
chargeable amount outside every bracket, raises `ERR_PAYROLL_INPUT_MISSING` naming the employee and the table.
**No calculator returns zero for an input it does not understand** — LEGACY-011 is precisely the failure where a NULL
became a figure.

## Consequences

- Tests run on the clearly synthetic `SYNTH` table (§4.12.4) and on in-memory tables built in the test file. No
  file exists under `packages/db/seed/my/statutory/<SCHEME>/` until OD-23 supplies verified tables with `source`,
  `loaded_by` and `verified_by`. `tests/regression/legacy-020.test.ts` scans the package's executable source for any
  numeric literal other than `0` and `1`.
- The `progressive_schedule` calculator computes on the period's chargeable amount and makes no annualisation
  claim. If the accountant's verified method annualises, that is a fourth `kind` in §4.12.3 and a fourth
  calculator, and these three are untouched.
- `SchemeCalculator.compute` receives `ytd` and `period` and the three shipped calculators read neither. The
  parameters are in §4.12.1's frozen signature so a later `kind` that needs them does not change the seam.
- Rounding is the table's declared `rounding_mode`, applied **once**, through `@dulja/domain`'s one `round`
  (LEGACY-019). A table that omits the optional member rounds `HALF_AWAY_FROM_ZERO`, §4.2.1's base mode; the run
  service copies the scheme row's own `rounding_mode` into such a definition, so the pure calculator stays total.
- A prorated amount rounds `HALF_AWAY_FROM_ZERO` at scale 4 once, from the exact `eligible / period` factor
  (`prorationFactor` returns the integer pair, never a float). The rule (`calendar_days` or `working_days`) is
  the company's configuration, never a statutory claim (spec:2086, ⚠️ OD-28).
- `SchemeResult.rateTableVersion: number` is the one `no-number-money` exception the slice adds (A14).

## Owner question

1. Is the seam accepted as written — every figure from a verified, period-covering, pinned table; a whole-run
   refusal on the first unusable table; a refusal, never a zero, for a missing input — or should a run compute the
   employees it can and report the rest?

## Amendment — 2026-11-15: the pin and the lines are frozen in the data layer (full review DBS-03, DBS-09)

- Status: **Proposed** — security and money semantics (spec:95). Implemented in migration `0126` ahead of approval
  under the 2026-11-15 full review's fix brief.
- DBS-03: the pin this ADR decides was only as durable as the caller's view of it. 0087's line guard read the
  run's status under the caller's RLS and passed on NULL, so a principal who could not see the document (another
  branch, or an employee holding no role) rewrote a posted line, and `payroll_run.pinned_tables` had no guard at
  all. Decided: (1) `payroll_line` and `payroll_run` carry a RESTRICTIVE `document_parent_visibility` policy — read
  under a readable document, written only under one whose branch the actor is in; (2) the line guard fails closed:
  on INSERT and UPDATE a status it cannot read is refused, and only the DELETE cascade (app_rw holds no DELETE)
  keeps the NULL pass; INSERT is now guarded; (3) `payroll_run` is frozen once its document leaves draft, by a
  whole-row comparison, as 0117 freezes the header; (4) R4 reaches `payroll_line`: no one UPDATEs their own line or
  INSERTs an override (spec:2087) on it.
- DBS-09: `employee.company_id` is immutable after insert. `sensitive_gate` and `compensation_gate` derive the
  company from the employee row, so a movable company let a writer re-home an employee into a company where they
  hold the HR codes.
- Owner question 2: R4 refuses a self-override and any UPDATE of one's own line, but not a *calculated* INSERT, so
  a preparer who is also an employee can still calculate a run that contains their own pay (from compensation R4
  already guards; R1 and R3 put a second person on the approval). Is that accepted, or must a run containing the
  preparer's own line be refused, so such a preparer can never calculate the whole payroll?

## Amendment (2026-11-15, full review finding HRP-03) — a deduction joined to a scheme reduces its base

- Status: **Proposed** (money semantics, spec:95). Implemented ahead of approval in the review's fix branch.

The calculator built each scheme's base from the **earnings** joined to it and ignored a **deduction** joined to it,
although `pay_component_scheme` (and `setComponentSchemes`) admit a join for either kind and spec:2076 maps
"pay components" — earnings and deductions — to schemes through that table (RC-3). An operator who joined the
unpaid-leave deduction to a scheme had every share charged on the unreduced salary, silently.

Decision: a scheme's base is **Σ the earnings joined to it − Σ the deductions joined to it**, per employee per
period. The join table is the scheme's rule about which components it is computed on; the rate table's own rule
(its bands, rate, ceiling or brackets) then applies to that base unchanged. Two cases refuse with
`ERR_PAYROLL_INPUT_MISSING`, naming the employee, rather than computing: a deduction joined to a scheme no earning of
the employee feeds, and joined deductions that exceed the joined earnings (a negative base). The scheme order is still
the order the employee's earnings named the schemes, so no existing golden fixture moved (none joins a deduction).

Owner question: is "a joined deduction reduces the base" the rule for every scheme the business uses, or does some
scheme compute on gross earnings regardless of a deduction (in which case the deduction must simply not be joined to
it, which the data already allows)?

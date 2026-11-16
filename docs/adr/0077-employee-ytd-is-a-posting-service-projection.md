# 0077 — `employee_ytd` is a posting-service projection with one aggregation

- Status: **Proposed** — asked, not decided (spec:95: money semantics and the data model). Implemented in 8C
  Tasks 2–3 as the plan's default, ahead of approval, under the owner's direction to implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8C · Tasks 2, 3 (Task 9 adds the rebuild)
- Contracts: round 18, B2, B5, B6, B7, B14; §4.12.8

## Context

spec:2084 makes `employee_ytd` "a projection rebuilt from posted lines nightly and compared (D14)". Contracts
§4.12.8 puts its MERGE at §4.3.2 **step 12**, beside `account_balance` and `stock_on_hand`, and spec:1978 groups the
three; spec:98 then forbids writing such a table outside the posting service. The Phase 8 definition of done requires
it to rebuild **bit-identically**.

Two figures in it are `jsonb` objects — `by_component` and `by_scheme` — and jsonb has no canonical text form for a
`numeric`. A MERGE that built them one way and a rebuild that built them another would agree on every `gross` and
`net` and disagree on the objects, intermittently, only when an amount ended in a trailing zero.

## Decision

1. **`app.employee_ytd` is written only by `packages/db/src/posting/**`** — the step-12 MERGE (`mergeEmployeeYtd`,
   `packages/db/src/posting/ytd.ts`) and nothing else. `scripts/lint/rules/posting-only-tables.ts` enforces it (its
   protected list has named the table since 1A); `packages/db/src/integrity/**` is not on the allow-list and must not
   be. The nightly rebuild **reads and compares and never writes**: it folds the posted deltas in one CTE statement
   (no DDL from application code — the plan's temp table became a CTE, round 18 B18), compares row for row as text
   and reports `ProjectionMismatch` rows and the `employee_ytd_drift` audit sentinel (B2, admitted to
   `app.record_system_event` by tail migration 0121) — drift is reported, never silently repaired.
2. **One SQL function, `app.employee_ytd_delta(p_document_id uuid)`, is the only aggregation** (B6). The MERGE and the
   rebuild both call it; the rebuild folds a year with `app.jsonb_add_money_agg` / `app.jsonb_add_scheme_agg`, built
   from the very binary functions the MERGE uses. Its jsonb values are fixed-scale **strings**
   (`to_char(…, 'FM999999999999990.0000')` — fifteen integer positions, the range of `numeric(19,4)`), the
   discipline `Money.toString()` applies in TypeScript. The function admits a document in `issued` as well as
   `posted` status, because step 12 runs before step 13 writes `posted`; a draft, submitted or approved run yields
   nothing.
3. **`tax_year` is the calendar year of `payroll_run.pay_date`** (B7) — a convention, confirmed by the owner under
   OD-23 ("pay-period/pay-date conventions", spec:2407). No statutory rule follows from it and none is stated here.
4. **`app.employee_ytd_opening` is not in the protected set**: it is a loaded figure with a provenance, is audited,
   and is written through `upsertEmployeeYtdOpening` (8C Task 9) by 9B's importer at cut-over. There is no route for
   it. **An opening is never merged into `app.employee_ytd` and never appears in the rebuild** (B14): the projection is
   Σ posted deltas on both sides of the compare, and the opening is added at READ time in one place,
   `ytdFromEmployeeYtd` (`packages/db/src/hr/ytd.ts`). The alternative is unbuildable — only `posting/**` may write
   the projection, so a loader in `hr/**` could not seed it, and an opening that reached only the rebuild would
   report every cut-over employee as permanent drift.
5. **There is no un-MERGE path**, because `PAYROLL` refuses reversal (ADR 0076): a correction is a `supplementary`
   run whose own delta is MERGE'd like any other. A delta's `net` is signed — read from the source line's own
   `document_line.credit - document_line.debit` over the run's `kind = 'account'` lines (8B's rules 6 and 7) — and
   never from `payroll_line.amount`, which 8B constrains `>= 0` so that §4.4.2 A9 keeps `side` the sole carrier of
   direction. `gross`, `by_component` and `by_scheme` are magnitudes and only grow. The columns therefore carry no
   non-negative CHECK.
6. **The MERGE serialises on its keys** (B16 item 7): `MERGE … WHEN NOT MATCHED THEN INSERT` does not re-check the
   target on a concurrent insert, so `mergeEmployeeYtd` takes a sorted, transaction-scoped
   `ytd:<company>/<employee>/<year>` advisory lock per delta row first — the reasoning amendment A4 records beside
   the `account_balance` MERGE.

## Consequences

- A projection drift is visible rather than silent: `EMPLOYEE_YTD_CHECK` joins 1B's registry (B5) and the nightly
  `hr.employee_ytd.rebuild` reports it.
- 8B's `ytdFromPostedLines` stays as the calculator's read and is not deleted; `ytdFromEmployeeYtd` reads the
  projection and is what 8D's payslip and annual statement consume. **They are not interchangeable and 8C does not
  make them so**: the calculator's `ytdBefore` is keyed per component and scheme share (`ytdKey`, `schemeYtdKey`),
  while `ytdFromEmployeeYtd` returns the two headline measures, `gross` and `net`. Substituting one for the other
  inside `payrollCalculator` would read every accumulated share as zero — a wrong number, not an error. The 8B
  handoff's note that "exactly this call site changes" is therefore not acted on in 8C; if a later slice wants the
  projection to drive the calculator, it widens the read from `by_component`/`by_scheme` and amends §4.12.8.
- A change to how a component or scheme total is derived is one function, in one file, with one test.

## Owner question

1. Is `tax_year` = the calendar year of `pay_date` (decision 3) the convention the accountant uses? If not, one
   `extract(year from …)` expression in `app.employee_ytd_delta` changes (a new migration) and the rebuild job is run
   once — 8C Task 15 records the change list.

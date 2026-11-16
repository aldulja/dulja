# 0072 — Effective-dated HR rows are closed, never edited

- Status: **Proposed** — the plan records it as decided, but it fixes the shape of two HR tables (a data-model
  decision, spec:95), so it is asked rather than decided. Implemented in 8A Tasks 5 and 6 ahead of approval, as
  ADRs 0054–0071 were, under the owner's direction to implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-08)
- Slice: 8A · Tasks 5 and 6
- Migrations: `0082` (`employee_statutory_profile`), `0083` (`compensation_line`)

## Context

spec:2077 says of compensation: "Salary history is the closed rows; a promotion is a new row", and of the statutory
profile that it is "effective-dated per employee". §4.6.1 gives both tables `effective_from` and a nullable
`effective_to` and nothing else. What it does not say is what stops two open rows, what closes the previous one, and
where.

R3 (spec:2174) makes the answer load-bearing beyond tidiness: "a compensation change effective in the period of a
run in `submitted` or `approved` status returns that run to `draft`". 8B's trigger detects such a change by looking
for a row whose effective window overlaps the run's period. If a raise were an UPDATE of the existing row, there
would be nothing to detect — the row's identity would not change and the audit before-image would be the only
evidence, which is not a queryable trigger condition.

## Decision

**Close-then-open, in one transaction, in one function per table.** `openCompensation` and `openStatutoryProfile`
(`packages/db/src/hr/`) set the previous open row's `effective_to` to `effective_from - 1 day` and insert the new
row. Neither function updates a business column of an existing row, and no route exposes a `PATCH` that would.

**"At most one open row" is a database fact, not a convention.** A partial unique index —
`compensation_line (employee_id, component_id) where effective_to is null` and
`employee_statutory_profile (employee_id) where effective_to is null` — refuses the second one, so a direct `app_rw`
insert cannot produce the state the read path assumes.

**Backdating before the current open row is refused** by the same index: the close statement is guarded by
`effective_from < <new>`, so an attempt to open a row on or *before* the open one leaves the old row open and the
insert collides. Correcting history is therefore an explicit act by a human, not an accident.

**A compensation line's component belongs to the employee's company.** The composite foreign keys bound only the
tenant, so `openCompensation` joins the component on the employee's company and refuses a component of a sibling
company of the same tenant.

## Consequences

- `compensationOn(employeeId, date)` and `profileOn(employeeId, date)` are simple range reads with no
  "latest wins" tie-break, because ties cannot be produced through the write functions.
- 8B's R3 trigger has a queryable condition: a row whose `[effective_from, effective_to]` overlaps the run's period
  and whose `created_at` is after the run's `calculated_at`.
- The audit log carries the whole history twice — once as the closed rows, once as before/after images. That is
  redundancy on purpose: the rows answer "what was in force", the audit answers "who changed it and when"
  (spec:2105, LEGACY-029/030).
- Genuine correction of a mistyped row is a *new* row, never an UPDATE of a business column. spec:2049 admits no
  deletion here.

## Rejected

- **A `valid_range daterange` column with an exclusion constraint.** More expressive, and it makes every read a
  range-operator query that 8B, 8C and 8D would each have to spell correctly. Two date columns and a partial index
  give the guarantee the write path needs with the query shape everyone already writes.
- **A separate `*_history` table.** Two tables to keep consistent, and the "current" one becomes a projection nobody
  rebuilds. The spec's own sentence — "history is the closed rows" — rejects it.

## Owner question

1. Is "correct a mistyped row by opening a new row" enough, or does payroll need an explicit *void* of a row
   entered in error (a status column, never a delete) before 8B's first run?

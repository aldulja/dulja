# ADR 0033 — Expand/contract for a live table, and what "zero downtime" is asserted to mean

**Status:** accepted
**Date:** 2026-09-05
**Deciders:** architect
**Slice:** 2C
**Spec:** §3.9 Migrations (spec:2057) "Expand/contract for any change touching a live table"; §4.8
(spec:2236) "zero-downtime deployments … so schema change never requires a maintenance window (the direct
answer to LEGACY-080)"; LEGACY-080 (spec:872); Part VI test 25 (spec:2443).
**Demonstrated by:** `packages/db/migrations/0027_expand_document_add_notes.sql`,
`packages/db/test/expand-contract.test.ts`, `tests/regression/legacy-080.test.ts`.
**Binds:** every later migration that touches a live table.
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

LEGACY-080 is a High finding: the legacy system upgrades its schema by dumping and re-pumping the whole
database, coordinated by 6,251 version integers. The rebuild's answer is expand/contract. The rule was
written in §3.9 and never demonstrated, so "zero downtime" had no operational definition and no test.

`app.document` is the busiest live table in the system by the end of Phase 2, so it is the honest subject.
`document.notes` is the column contracts §4.3.4 assigns 2C, and adding it is the **expand** half.

## Decision

**1. Expand and contract are two PRs in two slices, never one file.** The expand PR adds; the contract PR
removes, after every deployed reader has stopped needing the old shape. `app.document.notes` is the worked
example: 2C expands; nothing is owed for it because it replaced no earlier column, and the runbook says what
a real contract PR does.

**2. Renaming a column is forbidden.** Add, backfill, dual-write, then drop — four steps across two PRs. A
rename is atomic in the database and non-atomic in the fleet, so it is a maintenance window wearing a
different hat.

**3. Every migration touching a live table sets `lock_timeout` in the file.** `ALTER TABLE` takes
`ACCESS EXCLUSIVE`; the failure mode is not the lock's duration but the lock QUEUING behind a long read,
after which arriving readers queue behind the ALTER. Bounded at **3 s**, with `statement_timeout` at
**30 s**. A timeout rolls the transaction back — nothing is half-applied, because the runner wraps each file
in one transaction — and the deploy is retried. The runner (`packages/db/src/migrate.ts`) is not modified:
`set local` inside the file is enough, and Plan 0A is frozen.

**4. "Duration proportional to the change, not the data" is asserted as a RATIO, not a bound.** The test
measures the same migration against two row counts a decade apart in scale and asserts the timings stay
comparable. A wall-clock bound would pass on a fast machine and prove nothing.

**5. "No maintenance window" is asserted as ZERO non-2xx responses in a request loop that spans the
migration** — not as "the migration finished quickly". `tests/regression/legacy-080.test.ts` holds that loop,
on an API instance the test owns, because it rolls a migration back and the tier's shared instance must
never see that.

**6. Adding a column requires no audit or RLS change.** `app.document` carries its `audit_row` trigger from
migration 0001 and the trigger images the whole row (`to_jsonb(new)`), so the new column is audited from
the moment it exists. RLS is on the table, not the column.

**7. The Drizzle mirror follows the migration in the same PR** (§3.4.9) and readers that select an explicit
column list are untouched — which is the expand/contract discipline itself, and why the loop in decision 5
sees no error.

## Consequences

- Every later live-table migration is reviewed against this ADR and re-runs test 25 (§6.1).
- A migration that needs `NOT NULL` on a live table is three PRs: add nullable, backfill in batches under a
  job (never a migration — hazard 10), then add the constraint with `NOT VALID` followed by
  `VALIDATE CONSTRAINT`. None of those takes `ACCESS EXCLUSIVE` for longer than a catalogue write.
- The contract half of a real change is scheduled, not forgotten: `docs/runbooks/expand-contract.md` is the
  checklist and names the precondition (no deployed reader selects the old shape).
- The pinned DELETE grant list (§3.5.4, hazard 25) is re-asserted after 0027 so that an `ALTER TABLE` can
  never quietly carry a privilege with it.

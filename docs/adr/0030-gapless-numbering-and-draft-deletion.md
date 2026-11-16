# ADR 0030 — Gaplessness is proved by a function, and drafts are the one thing app_rw may delete

**Status:** PROPOSED — this ADR touches the data model and the privilege surface, so spec:95 requires it to be written as a proposal and asked before implementing.
**Date:** 2026-09-05
**Deciders:** owner (pending), architect
**Slice:** 2B
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

The Phase 2 definition of done (spec:2288) reads "issued numbers are unique and **gapless-provable**", and
spec:2222 spells out the mechanism: "assigned at *issue*, per (series, period), unique-constrained,
gapless-provable, with voided numbers explicitly recorded (LEGACY-051)". Uniqueness is already a constraint
(`unique (company_id, series, fiscal_period_id, number)`, migration 0001). *Provable* is not: nothing in the
schema answers "is there a number this series issued that no document and no void explains?"

LEGACY-051 is the legacy numbering: a race on first use, no uniqueness constraint, and no way to demonstrate
gaplessness. spec:2224 adds the other half — "No deletion of posted documents at any privilege level" — because
a system that can delete an issued document can make any gap disappear.

spec:2049 nevertheless admits deletion "for drafts and for the GDPR/PDPA erasure workflow, and both write an
audit row first", and contracts §3.5.4 pins the `app_rw` DELETE list, which after Plan 0A holds
`idempotency_key`, `role_permission` and `role_assignment_branch`. **This slice is the only one that ever
extends it** (contracts hazard 25).

Three ways to prove gaplessness were considered.

1. **A materialised gap table maintained by the posting service.** Rejected: a projection of a projection, and
   the thing it would prove is exactly what a bug in it would hide.
2. **A nightly job that walks every series in application code.** Rejected on the same ground the trial balance
   is read from `account_balance` rather than recomputed (contracts §4.16.3): the check must be expressible in
   one statement a human can read.
3. **A set-returning SQL function, evaluated on demand and by the nightly integrity job.** Chosen.

## Decision

- `app.series_gaps(company, series, period)` returns every `n` in `[1, document_series.next_number)` for which
  there is neither a `document` row with that number nor a `document_number_void` row. **Zero rows for every
  (company, series, period) is the definition-of-done proof.** It is `stable` and runs under the caller's RLS,
  so a tenant can only ever prove its own numbering.
- `SERIES_GAP_CHECK` registers with 1B's `registerProjectionCheck`, so the nightly
  `accounting.ledger.integrity_check` reports a non-empty result as a mismatch and the incident path 1B built
  handles it. It reports `projection: "document_series"` and `side: "missing_in_projection"` — the reading
  being that the counter has advanced past a number the document set does not explain.
- `app_rw` gains DELETE on `app.document` and `app.document_line`, guarded by two BEFORE DELETE triggers that
  raise `ERR_DOC_NOT_DRAFT` for anything but a draft. The `audit_row` AFTER DELETE trigger already attached to
  both tables supplies spec:2049's "writes an audit row first".
- The **child** guard refuses only when a non-draft parent is *visible*. A cascade from a deleted parent leaves
  no parent row to see, and that parent's own guard already proved it was a draft; a direct
  `delete from app.document_line where document_id = <a posted document>` sees the parent and is refused.
- No other table ever gains DELETE. Everything else is archived with `archived_at` (contracts §4.11.2).

## Consequences

- Acceptance test 16's three clauses become runnable: concurrent first documents both succeed (the advisory
  lock of contracts §4.3.6), issued numbers are unique (the constraint), and deletion of an issued document is
  impossible (the guard) — through the API, through a job and through direct `app_rw` SQL.
- A voided number stays a *recorded* gap, not a hole: `voidDocument` writes `document_number_void` in the same
  transaction as the status change (spec:1745), so `series_gaps` sees it as explained.
- The nightly job gains one query per `(company, series, period)` counter row. Counters are per period, so the
  cardinality is small and bounded by the number of series a company uses.
- **A known limit of this decision, recorded here rather than discovered later:** the DELETE grant reaches only
  a draft that carries **no** `document_event` row. `app.document_event`'s foreign key to `app.document`
  (contracts §4.5.2) declares no on-delete action and the table is immutable to `app_rw`, so a draft that was
  submitted and returned to draft — or that received an override — cannot be deleted at all: the statement
  fails with SQLSTATE 23503 and the caller sees `ERR_CONFLICT_REFERENCE`, not `ERR_DOC_NOT_DRAFT` and not
  success. `packages/db/test/document-delete.test.ts` pins that behaviour so it is visible in CI. It is not
  what spec:2049 intends for "deletion for drafts", but the foreign key is contracts-verbatim and the two
  candidate fixes both touch how the record of a deleted document is kept, so it is reported upward as an open
  question (contracts §4.18 open item 4) and not decided here (hazard 7). The slice that applies the answer
  replaces this pinning test.
- **Recorded for a later amendment:** `IntegrityReport` (1B, contracts §4.16.3) has no `numberingGaps` member,
  so a gap is reported through `ProjectionMismatch`. A dedicated member would read better; changing the
  interface is a contracts-document change, not a plan change (hazard 7).

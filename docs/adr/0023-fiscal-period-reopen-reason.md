# ADR 0023 — The mandatory period-reopen reason is a column on `fiscal_period`

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 1A

## Context

spec:2179 (R8) requires that `accounting.period.reopen` "requires a reason written to the audit row, and every
reopen is reported by the nightly integrity job". `app.audit_log` (plan0A) has columns `before` and `after`
holding `to_jsonb(old)` / `to_jsonb(new)` of the changed row and no free-text column; `app.audit_row()` takes
no reason parameter and gating an audit write on anything is forbidden (spec:103). So the reason has to reach
the audit row through the row itself.

## Decision

Migration 0013 adds `app.fiscal_period.reopen_reason text`. The reopen handler writes it in the same `UPDATE`
that sets `status = 'open'`, and the `audit_row` AFTER trigger carries it into `after`. The API refuses a
reopen with a missing or blank reason (`ERR_VALIDATION_FAILED`), so a non-null value is always present when a
period moves out of `closed` or `locked`.

The alternative — a transaction-scoped `set_config('app.event_reason', …)` read by a trigger, as 2B uses for
`document_event.reason` — was rejected here: `document_event` is a purpose-built event table with its own
`reason` column, whereas `fiscal_period` has no event table in v1 and inventing one for a single field would
be over-building. When 2B's session-setting mechanism exists it is used for documents only.

## Consequences

- `fiscal_period.reopen_reason` holds the **most recent** reason. The full history is in `app.audit_log`, one
  row per reopen, each with its own stamped `actor_id` and `occurred_at`; 1B's job walks those rows.
- `closed_by` and `closed_at` are not cleared on reopen. `app.stamp_actor` raises `ERR_ACTOR_IMMUTABLE` on any
  change to a non-null `*_by` value, so the close handler writes
  `closed_by = coalesce(closed_by, app.current_actor())` and the column records the first closer; the audit
  log is the per-event record. Changing that would mean amending Plan 0A, which is frozen.
- 1B reads `after ->> 'reopen_reason'` and is null-safe, so a reopen performed by direct SQL without the
  column set is still reported, with a null reason.

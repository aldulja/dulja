# ADR 0021 — `document_line`: the Phase 1 base shape

- **Status:** Proposed (spec:95 — a data-model decision is proposed and asked, not implemented first)
- **Date:** 2026-09-05
- **Slice:** 1A
- **Supersedes / superseded by:** —

## Context

Phase 1 posts a single hand-written `JOURNAL` type (spec:2287). Phase 2 generalises documents; Phase 3 adds
items, warehouses and lots; Phase 5 adds tax; Phase 6 adds POS tender lines; Phase 8 adds payroll lines. All of
them are lines of the same document. The choice is between one table that grows by expand-only ALTERs and one
table per family.

## Decision

One table, `app.document_line`, created here with the seven business columns a journal voucher needs
(`line_no`, `description`, `account_id`, `debit`, `credit`, `dimensions`, `custom_fields`) plus the standard
tenant, company, document, id and `created_at` columns. Every later slice adds **nullable or defaulted**
columns to this table on the schedule in contracts §4.3.4, and no slice renames or drops one. `kind` arrives
in 2A with the default `'account'`, so every row this slice writes is retro-classified correctly.

## Consequences

- A generic `documents` API (§4.2.7) can serve every type without a per-type table, which is what acceptance
  test 15 ("a new document type with zero code") requires.
- The table is wide by Phase 8. That is acceptable: Postgres stores NULLs in the null bitmap, and the
  alternative — a table per family — would make the posting service branch on type, which is exactly the
  design the policy engine exists to avoid (RC-3).
- `document_line` never gains a branch key. It is branch-isolated through `document` (contracts §4.5.6), so
  6C's `branch_isolation_policy` rule deliberately omits it.
- Every future column addition is an expand migration; a matching contract migration is only ever needed if a
  column is retired, which no slice in the v1 roadmap does.

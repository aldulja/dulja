# Runbook — expand/contract on a live table

Governed by ADR 0033. Applies to every migration that touches a table already carrying tenant rows.

## Expand (the first PR)

1. The change is **additive and nullable**. No `NOT NULL`, no `DEFAULT`, no rename, no type change.
2. The file sets `set local lock_timeout = '3s'` and `set local statement_timeout = '30s'` first.
3. `NNNN.down.sql` drops exactly what the up added — a column, never a table.
4. The Drizzle mirror (`packages/db/src/schema/`) is updated in the same PR; readers that do not select
   the column are untouched.
5. CI: `up`, `down`, `up` on Testcontainers (`packages/db/test/expand-contract.test.ts` is the shape);
   `lintSchema` reports zero violations; the request-loop test in `tests/regression/sah-080.test.ts`
   records zero non-2xx.

## Between the two PRs

6. Deploy. Both shapes are now valid: old readers ignore the column, new readers use it.
7. If the column replaces an old one, the writer **dual-writes** both for one full release, and a backfill
   job (never a migration — hazard 10) fills the history in bounded batches.
8. Wait until no deployed client selects the old shape. The evidence is the OpenAPI document of the oldest
   still-deployed API version plus the desktop app's minimum supported build.

## Contract (a later PR, a later slice)

9. Confirm step 8 in writing in the PR body. This is the only step with no automated check.
10. One migration, one drop, the same two `set local` lines, its own hand-written down file (which re-adds
    the column as nullable — it cannot restore data, and says so in a comment).
11. Re-run test 25. Update `packages/db/test/privileges.test.ts` only if a grant actually changed
    (hazard 25 — outside 2B, it should not).

## `NOT NULL` on a live table

Three PRs, never one: add the column nullable (this runbook's expand); backfill in batches under a job;
then `alter table … add constraint … check (col is not null) not valid` followed by
`alter table … validate constraint …`, which takes only a `SHARE UPDATE EXCLUSIVE` lock while it scans.

## For `app.document.notes` specifically

The expand half is `0027_expand_document_add_notes.sql` (2C). **There is nothing to contract**: the column
replaced no earlier column, so no later PR is owed. It stands as the worked example, and this runbook is
what the first real contract PR follows.

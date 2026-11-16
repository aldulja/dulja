-- ── 0027 · app.document.notes — the EXPAND half of an expand/contract change on a LIVE table ────────
-- spec:2057 (§3.9 "Expand/contract for any change touching a live table"), spec:2236 (§4.8 zero-downtime
-- deployments). Answers SAH-080 (spec:872): the legacy schema upgrade is a full dump-and-repump.
-- Contracts §4.3.4 assigns `document.notes` to 2C. The CONTRACT half is a later slice's PR — the
-- procedure is docs/runbooks/expand-contract.md and the reasoning is ADR 0033. Acceptance test 25
-- (spec:2443) is asserted against this file by packages/db/test/expand-contract.test.ts.

-- ── 1. bound the lock ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE takes ACCESS EXCLUSIVE for an instant. The danger is never the ALTER itself: it is the
-- ALTER QUEUING behind a long read, after which every arriving reader waits behind the queued ALTER and
-- the table is effectively offline. lock_timeout makes that outcome impossible — the statement fails,
-- this transaction rolls back, nothing is applied, and the deploy is retried. `set local` is scoped to
-- the transaction the runner (packages/db/src/migrate.ts, `up`) already opens around each file, so the
-- runner is untouched.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ── 2. expand ─────────────────────────────────────────────────────────────────────────────────────
-- Nullable, and DEFAULT-less on purpose. PostgreSQL 11+ can add a column with a constant default
-- without a rewrite, but "nullable and no default" is unconditionally catalogue-only on every version,
-- which is what makes the duration proportional to the change rather than to the data. The API keeps
-- serving throughout: existing readers select an explicit column list, and a new column is invisible to
-- them until they ask for it (the expand/contract discipline itself).
alter table app.document add column notes text;

comment on column app.document.notes is
  'Free-text note printed on the document (contracts §4.3.4, slice 2C). Expand half of 0027.';

-- ── 3. what is deliberately NOT here ──────────────────────────────────────────────────────────────
-- No NOT NULL, no default, no backfill, no index, no trigger change. `app.document` already carries its
-- audit trigger from migration 0001, and `audit_row` images the whole row with `to_jsonb(new)`, so a note
-- change is audited from the moment this file lands — no trigger edit is needed, and adding one would be
-- the "disable an invariant temporarily" move §0.2 forbids. No per-tenant row is written: FORCE ROW LEVEL
-- SECURITY binds app_migrator and a migration sees no tenants (hazard 10).

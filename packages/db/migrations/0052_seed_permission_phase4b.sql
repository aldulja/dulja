-- 0052_seed_permission_phase4b.sql — slice 4B. The one permission code of contracts §3.6.2, spec:2147.
-- app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw — plan0A:1313), so FORCE ROW LEVEL
-- SECURITY does not hide it from app_migrator the way it hides every per-tenant table: this is migration
-- data, not seed-pack data (contracts §3.4.8, spec:1366, hazard 10). The role grant over this code is
-- per-tenant seed-pack data and is applied by `bun run seed --tenant <id> --only roles` from
-- packages/db/seed/roles.ts (accountant only — spec:2157).
-- The code is `mutating`, so R7 (spec:2178) keeps it off the auditor.
-- This file's version is higher than 0048-0051, which land in later tasks of this same slice. That is
-- expected and legal: hazard 14 — no plan asserts max(version), and the runner applies whatever is not in
-- listApplied() in version order (contracts §3.4.1).

-- ── 1. the one code §3.6.2 assigns 4B ─────────────────────────────────────────────────────────────────
-- spec:2147 lists accounting.bank.reconcile among the accounting codes; spec:2157 gives bank reconciliation
-- to the accountant. The description is packages/contracts/permissions.ts's own string, character for
-- character. `on conflict do update` and not `do nothing`: §3.6.3 makes the catalogue bidirectional, so a
-- description drifting between the module and the table is corrected by re-running the migration.
insert into app.permission (code, module, mutating, description) values
  ('accounting.bank.reconcile', 'accounting', true,
   'Import bank statements and match or unmatch receipts, payments, till bankings and payroll batches')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

-- 0014_seed_permission_phase1.sql — the six Phase 1 accounting codes (spec:2147, contracts §3.6.2).
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366). The role grants over these codes are per-tenant seed-pack data and are
-- applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.

-- ── 1. the Phase 1 catalogue ──────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('accounting.account.manage', 'accounting', true,  'Create, edit and archive chart-of-accounts rows'),
  ('accounting.ledger.read',    'accounting', false, 'Read posted ledger entries and account balances'),
  ('accounting.period.close',   'accounting', true,  'Close a fiscal period so nothing may post into it'),
  ('accounting.period.reopen',  'accounting', true,  'Reopen a closed or locked fiscal period, with a mandatory reason'),
  ('accounting.journal.create', 'accounting', true,  'Draft and edit a journal voucher and its lines'),
  ('accounting.journal.post',   'accounting', true,  'Post a journal voucher to the ledger')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

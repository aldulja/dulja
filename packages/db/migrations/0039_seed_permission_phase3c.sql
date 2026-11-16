-- 0039_seed_permission_phase3c.sql — the four permission codes of contracts §3.6.2, spec:2147-2148.
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366, hazard 10). The role grants over these codes are per-tenant seed-pack data
-- and are applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.
-- All four are `mutating` — R7 (spec:2178) therefore gives the auditor none of them, and packages/db/seed/roles.ts
-- grants them to accountant, user and warehouse only.
-- This file's version is higher than 0037-0038, which land in later tasks of this same slice. That is expected
-- and legal: hazard 14 — no plan asserts max(version), and the runner applies whatever is not in listApplied().

-- ── 1. the Phase 3C catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('accounting.purchase.create', 'accounting', true,
   'Create and submit purchase orders, import shipments and purchase returns'),
  ('accounting.purchase.post',   'accounting', true,
   'Post purchase returns and purchase documents'),
  ('inventory.receipt.create',   'inventory',  true,
   'Create and submit goods receipts and import shipments'),
  ('inventory.receipt.post',     'inventory',  true,
   'Post goods receipts and import shipments — quantities and landed cost')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

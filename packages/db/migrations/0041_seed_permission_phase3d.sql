-- 0041_seed_permission_phase3d.sql — the six permission codes of contracts §3.6.2, spec:2147-2148.
-- app.permission is global and has no RLS (plan0A:1313), so FORCE ROW LEVEL SECURITY does not hide it from
-- app_migrator the way it hides every per-tenant table: this is migration data, not seed-pack data
-- (contracts §3.4.8, spec:1366, hazard 10). The role grants over these codes are per-tenant seed-pack data
-- and are applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.
-- All six are `mutating`, so R7 (spec:2178) gives the auditor none of them.
-- spec:2148 inventory: transfer.create/.post, count.create, adjustment.create/.approve
-- spec:2147 accounting: sales and purchase ORDERS are created under accounting.sales.create

-- ── 1. the Phase 3D catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('inventory.transfer.create',    'inventory',  true,
   'Draft a delivery order, a stock transfer or a transfer receipt'),
  ('inventory.transfer.post',      'inventory',  true,
   'Post a delivery order, a stock transfer or a transfer receipt (stock out, no revenue — F-19)'),
  ('inventory.count.create',       'inventory',  true,
   'Draft a stock count and enter counted quantities'),
  ('inventory.adjustment.create',  'inventory',  true,
   'Draft a stock adjustment or an expiry write-off'),
  ('inventory.adjustment.approve', 'inventory',  true,
   'Approve and post a stock count or an expiry write-off (spec:2026)'),
  ('accounting.sales.create',      'accounting', true,
   'Draft a sales order or a sales document')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

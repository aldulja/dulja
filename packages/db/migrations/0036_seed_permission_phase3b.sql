-- 0036_seed_permission_phase3b.sql — the ONE permission code slice 3B introduces (contracts §3.6.2).
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366, hazard 10). The role grants over this code are per-tenant seed-pack data and
-- are applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.
-- `mutating` is FALSE, and that is load-bearing rather than descriptive: R7 (spec:2178) forbids the auditor
-- any mutating code, and §3.6.4 gives this one to the auditor.
-- This is NOT §4.16.1's `inventory.valuation` ReportCode, which is 3D's on 1B's reports module (hazard 4);
-- it is the gate over 3B's own list module at /v1/companies/{companyId}/valuation (amendment A8).

-- ── 1. the Phase 3B catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('inventory.cost.read', 'inventory', false, 'Read stock valuation and open cost layers')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

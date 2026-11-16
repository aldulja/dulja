-- 0056_seed_permission_phase5a.sql
-- app.permission is GLOBAL (no RLS, read-only for app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8). Slice 5A introduces exactly one code (§3.6.2, spec:2147).
-- The filing permission belongs to 5B and is deliberately absent: §3.6.3's catalogue test compares both directions,
-- so seeding a code whose handler has not shipped would fail the build.
insert into app.permission (code, module, mutating, description) values
  ('accounting.tax.manage', 'accounting', true,
   'Maintain tax regimes and codes, and generate periodic tax returns')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;

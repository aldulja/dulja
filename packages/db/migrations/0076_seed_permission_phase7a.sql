-- ── 0076. Phase 7A permission codes ───────────────────────────────────────────
-- app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw), so it is migration data, not seed-pack
-- data (§3.4.8). spec:2146 names the code; §3.6.2 assigns it to this slice; the auditor's grant (spec:2163) is
-- seed-tier data in packages/db/seed/roles.ts, applied by `bun run seed --only roles`.
-- packages/db/test/permission-catalogue.test.ts asserts this set equals permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('accounting.report.export', 'accounting', false,
   'Export a report as PDF, XLSX or CSV (spec:2146; the auditor''s export authority, spec:2163)')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;

-- ── 0079. Phase 7C permission codes ───────────────────────────────────────────
-- spec:2146 lists admin.data.export in the admin module; spec:2163 gives the auditor role "export"; spec:2211
-- is the right-to-export it serves. app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw), so
-- it is migration data, not seed-pack data (§3.4.8). The auditor's grant is seed-tier data in
-- packages/db/seed/roles.ts, applied by `bun run seed --only roles`.
-- packages/db/test/permission-catalogue.test.ts asserts this set equals permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('admin.data.export', 'admin', false, 'Export the tenant''s own data in open formats')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;

-- ── 0089. Phase 8B permission codes ───────────────────────────────────────────
-- §3.6.2's hr / 8B row: the four codes acceptance tests 10, 29, 31, 33 and 38 are gated by. The vocabulary is
-- closed (§3.6.1) and this slice invents none. app.permission is GLOBAL and has no RLS, so it is the one table a
-- migration may write (§3.4.8, hazard 10); the role grants are packages/db/seed/roles.ts, applied by
-- `bun run seed --only roles`. packages/db/test/permission-catalogue.test.ts asserts this set equals
-- permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('hr.payroll.read',    'hr', false, 'Read payroll runs and posted payroll lines (spec:2163 — the auditor sees posted lines only, never compensation or sensitive rows).'),
  ('hr.payroll.prepare', 'hr', true,  'Calculate, recalculate and submit a payroll run (spec:2162 — the HR officer prepares; R6 forbids the same seeded role also approving).'),
  ('hr.payroll.approve', 'hr', true,  'Approve a submitted payroll run (spec:2172 R1/R2 — the checker, who must not be the submitter).'),
  ('hr.payroll.post',    'hr', true,  'Post an approved payroll run through the posting service (spec:2173 R2).')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;

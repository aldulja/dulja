-- ── 0097. Phase 8D permission codes ───────────────────────────────────────────
-- §3.6.2's hr / 8D row: the code that gates producing a filing — a payslip, a statutory schedule document or an
-- annual statement — from POSTED payroll figures (spec:2083). app.permission is GLOBAL and has no RLS, so it is the
-- one table a migration may write (§3.4.8, hazard 10); the role grant is packages/db/seed/roles.ts, applied by
-- `bun run seed --only roles`. packages/db/test/permission-catalogue.test.ts asserts this set equals permissions.ts
-- in both directions.
-- The two ⚠️ hr.leave.* codes are NOT here: 0096 inserts them with the tables they gate, so the whole OD-13 gate is
-- one file and one task (contracts round 19, 8D A9).
insert into app.permission (code, module, mutating, description) values
  ('hr.filing.generate', 'hr', true,
   'Generate a payslip, a statutory schedule document or an annual statement from posted payroll figures')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;

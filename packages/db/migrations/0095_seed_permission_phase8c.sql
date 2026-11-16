-- ── 0095. Phase 8C permission codes ───────────────────────────────────────────
-- §3.6.2's hr / 8C row: the release code of a payroll payment batch and the create code of a staff advance. Each
-- is the approval.create of one hr-module document type (PAYROLL_PAYMENT, EMPLOYEE_ADVANCE); approval and posting
-- stay 4A's accounting.payment.approve / .post, so payroll money leaves the bank under the same two-person control
-- as every other payment (spec:2082, R1). app.permission is GLOBAL and has no RLS, so it is the one table a
-- migration may write (§3.4.8, hazard 10); the role grants are packages/db/seed/roles.ts, applied by
-- `bun run seed --only roles`. packages/db/test/permission-catalogue.test.ts asserts this set equals
-- permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('hr.payroll.pay',    'hr', true, 'Release a payroll payment batch and settle a statutory remittance'),
  ('hr.advance.create', 'hr', true, 'Create a staff advance')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;

-- ── 0086. Phase 8A permission codes ───────────────────────────────────────────
-- §3.6.2's six 8A codes. app.permission is GLOBAL and has no RLS, so it is the one table a migration may write
-- (§3.4.8, hazard 10); every per-tenant row in this slice is seed-pack data instead, and the role grants are
-- packages/db/seed/roles.ts, applied by `bun run seed --only roles`. This file is written before 0081–0085 on
-- purpose: migration 0081's sensitive_gate policy names 'hr.employee.read_sensitive' as a literal that
-- app.actor_has resolves against this table, and a policy naming an unseeded code resolves to false for everyone.
-- packages/db/test/permission-catalogue.test.ts asserts this set equals permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('hr.employee.read_sensitive', 'hr', false, 'Read an employee''s identity, bank and statutory reference numbers. Gated in the data layer by the sensitive_gate RLS policy, not only by this pre-flight — which is why it also gates the WRITE without being a mutating code: sensitive_gate has no `with check`, so its `using` predicate applies to writes too.'),
  ('hr.compensation.read',       'hr', false, 'Read compensation lines and effective-dated statutory profiles. Posted payroll amounts are a different code (hr.payroll.read).'),
  ('hr.compensation.manage',     'hr', true,  'Open and close compensation lines and statutory profiles, and write an employee''s sensitive record. The sensitive write additionally passes sensitive_gate, which requires hr.employee.read_sensitive. R4 forbids acting on your own record.'),
  ('hr.pay_component.manage',    'hr', true,  'Maintain the pay-component catalogue and its statutory-scheme joins.'),
  ('hr.statutory_table.manage',  'hr', true,  'Break-glass load of a statutory rate table outside the seed pull request. The loader is recorded in loaded_by and cannot verify its own table.'),
  ('hr.statutory_table.verify',  'hr', true,  'Verify a loaded statutory rate table. Refused when the verifying principal is the one recorded in loaded_by (ERR_HR_SELF_VERIFY).')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;

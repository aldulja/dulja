-- 0069_seed_permission_phase6c.sql — §3.6.2's four 6C codes. app.permission is GLOBAL and has no RLS, so
-- it is the one table a migration may write (§3.4.8, hazard 10); every per-tenant role grant in this slice is
-- seed-pack data instead. Each description is byte-identical to its `PermissionDef` in
-- packages/contracts/permissions.ts, and packages/db/test/permission-catalogue.test.ts pins the two together.
-- pos.cashier.manage_pin sets and resets a PIN only: creating and revoking a cashier credential is
-- admin.user.manage (6C plan gate table; apps/api/src/routes/pos/cashiers.ts).
insert into app.permission (code, module, mutating, description) values
  ('hr.employee.read',       'hr',  false, 'Read the staff directory: employee number, home branch, hire and termination dates. No sensitive or compensation fields.'),
  ('hr.employee.manage',     'hr',  true,  'Create and maintain the employee master.'),
  ('hr.attendance.record',   'hr',  true,  'Record and correct attendance events in the back office.'),
  ('pos.cashier.manage_pin', 'pos', true,  'Set or reset a cashier''s till PIN, within the branches the actor is assigned to.')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;

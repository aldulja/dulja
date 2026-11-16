-- Unseeded-database precondition (§3.4.5): remove tenant role grants through
-- the seed tier before rollback. Never disable tenant RLS or delete grants here.
delete from app.permission where code in (
  'hr.employee.read', 'hr.employee.manage', 'hr.attendance.record', 'pos.cashier.manage_pin'
);

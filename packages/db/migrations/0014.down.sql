-- Reverse of 0014: exactly the six codes it inserted. The FK from app.role_permission.permission_code blocks
-- the delete while any tenant still grants one, which is the correct signal — re-run the role seed for that
-- tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'accounting.account.manage',
  'accounting.ledger.read',
  'accounting.period.close',
  'accounting.period.reopen',
  'accounting.journal.create',
  'accounting.journal.post'
);

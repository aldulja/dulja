-- Reverse of 0039: exactly the four codes it inserted and nothing else (§3.6.3). The FK from
-- app.role_permission.permission_code blocks the delete while any tenant still grants one, which is the
-- correct signal — re-run the role seed for that tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'accounting.purchase.create',
  'accounting.purchase.post',
  'inventory.receipt.create',
  'inventory.receipt.post'
);

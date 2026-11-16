-- Reverse of 0041: exactly the six codes it inserted and nothing else (contracts §3.6.3).
-- app.role_permission.permission_code references app.permission(code) with NO `on delete cascade`
-- (plan0A:1325), so this delete is BLOCKED while any tenant still grants one of the six — which is the
-- correct signal, not a defect: re-run that tenant's role seed first (contracts §3.4.5). 0033.down.sql
-- and 0039.down.sql document the identical statement the same way.
delete from app.permission where code in (
  'inventory.transfer.create',
  'inventory.transfer.post',
  'inventory.count.create',
  'inventory.adjustment.create',
  'inventory.adjustment.approve',
  'accounting.sales.create'
);

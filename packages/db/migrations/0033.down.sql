-- Reverse of 0033: exactly the five codes it inserted. The FK from app.role_permission.permission_code blocks
-- the delete while any tenant still grants one, which is the correct signal — re-run the role seed for that
-- tenant first (contracts §3.4.5).
delete from app.permission where code in (
  'inventory.item.read',
  'inventory.item.manage',
  'inventory.price.manage',
  'inventory.stock.read',
  'inventory.negative_stock.override'
);

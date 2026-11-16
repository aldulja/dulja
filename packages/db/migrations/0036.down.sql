-- Reverse of 0036: exactly the one code it inserted and nothing else (§3.6.3). The FK from
-- app.role_permission.permission_code blocks the delete while any tenant still grants it, which is the
-- correct signal — re-run the role seed for that tenant first (contracts §3.4.5).
delete from app.permission where code = 'inventory.cost.read';

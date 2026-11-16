-- 0086.down.sql — deletes exactly the six codes the up inserted (§3.6.3).
--
-- PRECONDITION (contracts §3.4.5, round 3): reversible only against an UNSEEDED database, exactly as 0079's down.
-- app.role_permission.permission_code references app.permission(code) with no `on delete` action, so on a
-- database where `--only roles` has run this delete RAISES SQLSTATE 23503 rather than orphaning a grant. The
-- operator removes the grants per tenant first. NEVER disable or drop a policy to make this file "work".
delete from app.permission where code in
  ('hr.employee.read_sensitive', 'hr.compensation.read', 'hr.compensation.manage',
   'hr.pay_component.manage', 'hr.statutory_table.manage', 'hr.statutory_table.verify');

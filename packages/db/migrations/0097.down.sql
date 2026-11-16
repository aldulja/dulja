-- 0097.down.sql — deletes exactly the code the up inserted (§3.6.3).
--
-- PRECONDITION (contracts §3.4.5, round 3): reversible only against an UNSEEDED database, exactly as 0089's and
-- 0095's downs. app.role_permission.permission_code references app.permission(code) with no `on delete` action, so on
-- a database where `--only roles` has run this delete RAISES SQLSTATE 23503 rather than orphaning a grant. The
-- operator removes the grants per tenant first (contracts round 19, 8D A13 item 6). NEVER disable or drop a policy to
-- make this file "work".
delete from app.permission where code = 'hr.filing.generate';

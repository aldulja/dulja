-- 0096.down.sql — reverse dependency order (§3.4.5). `drop table` removes each table's own triggers and policies.
--
-- PRECONDITION (contracts §3.4.5, round 3): reversible only against an UNSEEDED database, exactly as 0089's, 0095's
-- and 0097's downs. app.role_permission.permission_code references app.permission(code) with no `on delete` action,
-- so on a database where `--only roles` has run this delete RAISES SQLSTATE 23503 rather than orphaning a grant. The
-- operator removes the grants per tenant first. NEVER disable or drop a policy to make this file "work".
delete from app.permission where code in ('hr.leave.record', 'hr.leave.approve');
drop table if exists app.public_holiday;
drop table if exists app.leave_record;
drop function if exists app.guard_leave_record();
drop table if exists app.leave_entitlement;
drop table if exists app.leave_type;

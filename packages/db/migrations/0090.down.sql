-- 0090.down.sql — removes R3's trigger and the bounded lookup, and restores 0083's compensation_gate exactly as
-- 0083 wrote it. Development and CI only (spec:2057).
drop function app.compensation_changes_in_period(uuid, date, date);
revoke select (tenant_id, role_id, permission_code) on app.role_permission from app_auth;
revoke select (tenant_id, employee_id, effective_from, entered_by) on app.compensation_line from app_auth;

drop policy compensation_gate on app.compensation_line;
create policy compensation_gate on app.compensation_line as restrictive
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

drop trigger compensation_line_returns_run on app.compensation_line;
drop function app.compensation_change_returns_run();
drop function app.return_runs_for_compensation(uuid, date, date);

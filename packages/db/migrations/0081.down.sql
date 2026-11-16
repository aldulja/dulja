drop trigger  if exists stamp_updated_by on app.employee_sensitive;
drop trigger  if exists employee_sensitive_no_self_pay on app.employee_sensitive;
drop policy   if exists sensitive_gate on app.employee_sensitive;
drop table    if exists app.employee_sensitive;
drop function if exists app.stamp_actor_always();   -- created by 0081; dropped after the table (A19)

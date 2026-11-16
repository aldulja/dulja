drop trigger if exists employee_statutory_profile_no_self_pay on app.employee_statutory_profile;
drop policy  if exists compensation_gate on app.employee_statutory_profile;
drop index   if exists app.employee_statutory_profile_open_idx;
drop table   if exists app.employee_statutory_profile;

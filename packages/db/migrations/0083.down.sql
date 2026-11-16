drop trigger if exists compensation_line_no_self_pay on app.compensation_line;
drop policy  if exists compensation_gate on app.compensation_line;
drop index   if exists app.compensation_line_period_idx;
drop index   if exists app.compensation_line_open_idx;
drop table   if exists app.compensation_line;
drop table   if exists app.pay_component_scheme;
drop table   if exists app.pay_component;

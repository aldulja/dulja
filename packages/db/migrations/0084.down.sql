drop trigger  if exists statutory_rate_table_verifier on app.statutory_rate_table;
drop function if exists app.assert_rate_table_verifier();
drop index    if exists app.statutory_rate_table_lapse_idx;
drop index    if exists app.statutory_rate_table_effective_idx;
drop table    if exists app.statutory_rate_table;
drop trigger  if exists pay_component_scheme_same_company on app.pay_component_scheme;
drop function if exists app.assert_pay_component_scheme_company();
alter table app.pay_component_scheme drop constraint if exists pay_component_scheme_scheme_fk;
drop table    if exists app.statutory_scheme;

-- 0087.down.sql
drop trigger if exists payroll_line_change_draft_only on app.payroll_line;
drop function if exists app.forbid_payroll_line_change_unless_draft() cascade;
drop index if exists app.payroll_line_scheme_idx;
drop index if exists app.payroll_line_employee_idx;
drop table if exists app.payroll_line;
drop index if exists app.payroll_run_period_idx;
drop table if exists app.payroll_run;
-- The kind CHECK returns to the state the migration BEFORE this one left — and in this tree that is 6A's 0061,
-- which always applies first and already wrote the six-label union (contracts round 17, A17 item 1). Narrowing
-- to 2A's four here would leave the schema in a state no forward migration produces, and the up → down → up
-- fingerprint would differ. 0061.down.sql is the file that narrows it, and it carries the row guard.
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text','tender','payroll'));

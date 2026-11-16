-- A down that drops app.employee would violate §3.4.5's "down to 0 leaves zero tables in app" for
-- migration 0064, which owns the table. Only what 0080 added is removed.
drop trigger if exists employee_no_self_pay on app.employee;
drop function if exists app.forbid_self_pay();
alter table app.employee drop constraint if exists employee_employment_type_check;
alter table app.employee drop column if exists statutory_profile_note;
alter table app.employee drop column if exists archived_at;
alter table app.employee drop column if exists employment_type;
alter table app.employee drop column if exists position;

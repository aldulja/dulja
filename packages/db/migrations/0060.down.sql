-- 0060.down.sql
drop table if exists app.needs_attention;
drop table if exists app.terminal_request_guard;
drop function if exists app.resolve_enrolment(bytea) cascade;
drop policy if exists enrolment_resolver on app.terminal_enrolment;
revoke select on app.terminal_enrolment from app_auth;
drop table if exists app.terminal_enrolment;

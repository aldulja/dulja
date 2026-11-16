drop trigger if exists statutory_schedule_remittance_guard on app.statutory_schedule;
drop function if exists app.assert_remittance_matches_schedule() cascade;
drop table if exists app.statutory_schedule;

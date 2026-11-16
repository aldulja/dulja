drop function if exists app.record_cashier_snapshot_drift(uuid,jsonb,jsonb);
drop view if exists app.who_can_reset_a_pin;
drop trigger if exists refresh_pos_cashier on app.branch_pos_policy;
drop trigger if exists refresh_pos_cashier on app.role_permission;
drop trigger if exists refresh_pos_cashier on app.role_assignment_branch;
drop trigger if exists refresh_pos_cashier on app.role_assignment;
drop trigger if exists snapshot_revision_stamp on app.pos_cashier;
drop function if exists app.stamp_snapshot_revision() cascade;
drop function if exists app.refresh_pos_cashier_for_branch_policy() cascade;
drop function if exists app.refresh_pos_cashier_for_role() cascade;
drop function if exists app.refresh_pos_cashier_for_assignment() cascade;
drop function if exists app.refresh_pos_cashier(uuid) cascade;

drop trigger if exists attendance_event_correction on app.attendance_event;
drop function if exists app.assert_attendance_correction();
drop table if exists app.attendance_event;

drop function if exists app.branch_pos_policy_sync(uuid, uuid, bigint);
drop index if exists app.branch_pos_policy_cursor_idx;
drop trigger if exists catalogue_revision on app.branch_pos_policy;
drop table if exists app.branch_pos_policy;

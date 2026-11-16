-- 0106.down.sql
drop trigger if exists posting_policy_pinned on app.posting_policy;
drop function if exists app.guard_pinned_policy();

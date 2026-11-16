-- 0075.down.sql — reverse dependency order (§3.4.5): report_run references saved_view, which references
-- 0074's report_definition. Triggers and policies drop with their tables; indexes are named first.
drop index if exists app.report_run_queued_idx;
drop index if exists app.report_run_recent_idx;
drop table if exists app.report_run;
drop index if exists app.saved_view_shared_idx;
drop index if exists app.saved_view_owner_idx;
drop table if exists app.saved_view;

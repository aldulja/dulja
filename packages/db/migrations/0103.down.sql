-- 0103.down.sql — reverse dependency order (§3.4.5). Triggers and policies drop with the table; the audit and stamp
-- functions are app_meta's and are never dropped by a slice's down file. Indexes are named first.
drop index if exists app.import_run_one_live_per_company;
drop index if exists app.import_run_company_created_idx;
drop table if exists app.import_run;

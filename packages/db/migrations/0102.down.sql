-- 0102.down.sql — the table's triggers, indexes and grants go with it; app_meta and app_meta.schema_migration are
-- never dropped (§3.4.5).
drop table if exists app.import_batch;

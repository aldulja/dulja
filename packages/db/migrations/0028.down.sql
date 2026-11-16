-- reverse dependency order (§3.4.5). `drop table` removes each table's indexes, its tenant_isolation
-- policy and its audit_row trigger with it; app_meta and app_meta.schema_migration are never dropped.
drop table if exists app.unit_conversion;
drop table if exists app.item;
drop table if exists app.unit_of_measure;

-- Reverse dependency order: trigger, function, indexes, table. `app_meta` and app_meta.schema_migration are
-- never dropped (§3.4.5).
drop trigger if exists landed_cost_allocation_draft_only on app.landed_cost_allocation;
drop function if exists app.assert_landed_cost_allocation_draft() cascade;
drop index if exists app.landed_cost_allocation_target_idx;
drop index if exists app.landed_cost_allocation_document_idx;
drop table if exists app.landed_cost_allocation;

-- Reverse dependency order: trigger, function, view, then the table. The view depends on the table, so it
-- must go first or `drop table` fails. `app_meta` and app_meta.schema_migration are never dropped (§3.4.5).
drop trigger if exists document_link_open_quantity on app.document_link;
drop function if exists app.assert_document_link_within_open_quantity() cascade;
drop view if exists app.document_open_quantity;
drop index if exists app.document_link_target_document_idx;
drop index if exists app.document_link_source_line_idx;
drop index if exists app.document_link_header_pair_key;
drop index if exists app.document_link_line_pair_key;
drop table if exists app.document_link;

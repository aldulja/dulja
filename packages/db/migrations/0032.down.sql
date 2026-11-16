-- Reverse of 0032, in reverse dependency order. down runs only in CI on empty tenants (contracts §3.4.5).
drop trigger if exists document_line_base_quantity on app.document_line;
drop function if exists app.document_line_base_quantity();
drop index if exists app.document_line_warehouse_idx;
alter table app.document_line drop constraint if exists document_line_unit_fk;
alter table app.document_line drop constraint if exists document_line_lot_fk;
alter table app.document_line drop constraint if exists document_line_warehouse_fk;
alter table app.document_line drop constraint if exists document_line_item_fk;
alter table app.document_line drop column if exists unit_quantity;
alter table app.document_line drop column if exists unit_id;
alter table app.document_line drop column if exists lot_id;
alter table app.document_line drop column if exists warehouse_id;

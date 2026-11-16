-- Reverse of 0031, in reverse dependency order (contracts §3.4.5). down runs only in CI on empty tenants, so
-- the attachment check can be dropped without re-examining rows.
drop index if exists app.attachment_lot_idx;
alter table app.attachment drop constraint if exists attachment_owner_check;
alter table app.attachment drop constraint if exists attachment_lot_fk;
alter table app.attachment drop column if exists lot_id;
alter table app.document drop constraint if exists document_to_warehouse_fk;
alter table app.document drop constraint if exists document_warehouse_fk;
alter table app.document drop column if exists to_warehouse_id;
alter table app.document drop column if exists warehouse_id;
drop function if exists app.pick_lots_fefo(uuid, uuid, numeric);
drop table if exists app.stock_on_hand;
drop trigger if exists inventory_movement_stock_available on app.inventory_movement;
drop trigger if exists inventory_movement_immutable on app.inventory_movement;
drop index if exists app.inventory_movement_chrono_idx;
drop table if exists app.inventory_movement;
drop function if exists app.assert_stock_available();

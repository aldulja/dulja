-- reverse dependency order (§3.4.5). `drop function … cascade` is the accepted way to remove a
-- function's triggers (plan0A:1518) — item_sentinel_lot's trigger sits on app.item, which this file
-- does not drop, so it must go explicitly and cannot ride a `drop table`.
drop function if exists app.item_sentinel_lot() cascade;
drop table if exists app.variant;
drop table if exists app.lot;
drop function if exists app.warehouse_no_cycle() cascade;
drop table if exists app.warehouse;

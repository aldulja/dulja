-- ── 0114 down ──────────────────────────────────────────────────────────────────────────────────────────
-- 0031's app.assert_stock_available, restored byte for byte, FIRST — it is the one reader of the functions
-- dropped below — then everything 0114 created, in reverse. Down-migrating this reopens the defect: any
-- negative-stock override on a document admits whatever its lines say at post.
create or replace function app.assert_stock_available() returns trigger
language plpgsql as $$
declare
  available numeric(19,6);
begin
  if new.quantity >= 0 then
    return new;                          -- a receipt cannot take stock below zero
  end if;

  select coalesce(sum(m.quantity), 0) into available
    from app.inventory_movement m
   where m.company_id   = new.company_id
     and m.item_id      = new.item_id
     and m.warehouse_id = new.warehouse_id
     and m.lot_id       = new.lot_id;

  if available + new.quantity >= 0 then
    return new;
  end if;

  if exists (
    select 1 from app.document_event e
     where e.document_id   = new.document_id
       and e.event_kind    = 'override'
       and e.override_code = 'inventory.negative_stock.override'
  ) then
    return new;
  end if;

  raise exception 'ERR_STOCK_INSUFFICIENT: item % warehouse % lot % holds %, this movement needs %',
    new.item_id, new.warehouse_id, new.lot_id, available, (- new.quantity)
    using errcode = 'check_violation';
end $$;
drop trigger if exists document_event_stock_override_digest on app.document_event;
drop function if exists app.stamp_stock_override();
drop function if exists app.stock_override_admits(uuid);
drop function if exists app.document_stock_digest(uuid);
alter table app.document_event drop constraint if exists document_event_approved_stock_digest_check;
alter table app.document_event drop column if exists approved_stock_digest;

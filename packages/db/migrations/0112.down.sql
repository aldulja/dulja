-- Restores 0031's picker, which orders by expiry with no lower bound and therefore picks an expired lot
-- first. Down-migrating this reintroduces that behaviour, and says so.
create or replace function app.pick_lots_fefo(p_item_id uuid, p_warehouse_id uuid, p_quantity numeric)
returns table (lot_id uuid, quantity numeric(19,6))
language plpgsql stable as $$
declare
  remaining numeric(19,6) := p_quantity;
  r         record;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'ERR_VALIDATION_FAILED: pick_lots_fefo needs a positive quantity, got %', p_quantity
      using errcode = 'check_violation';
  end if;
  for r in
    select h.lot_id as id, h.quantity as available
      from app.stock_on_hand h
      join app.lot l on l.tenant_id = h.tenant_id and l.id = h.lot_id
     where h.item_id = p_item_id
       and h.warehouse_id = p_warehouse_id
       and h.quantity > 0
       and l.archived_at is null
     order by l.expires_on asc nulls last, l.code asc, h.lot_id asc
  loop
    exit when remaining <= 0;
    lot_id   := r.id;
    quantity := least(r.available, remaining);
    remaining := remaining - quantity;
    return next;
  end loop;
end $$;

-- ── 0112 · app.pick_lots_fefo never picks a lot that has already expired ───────────────────────
-- Phase 3 review pass, PR #6; allocated from the §3.4.1 tail (register row 0109–0112).
--
-- 0031's picker orders `expires_on asc nulls last` with no lower bound, so a lot whose expiry is in the
-- PAST sorts first and is picked first. `convertOrderToDelivery` (3D Task 5) picks with FEFO by default, so
-- a sales order for an item holding one expired batch and one good one drafted its delivery from the
-- expired batch — shipping expired food unless the operator noticed, and leaving the EXPIRY_WRITE_OFF that
-- should have consumed that batch with nothing to consume.
--
-- "Earliest-expiring" (the Phase 3 DoD clause, spec:2289) means earliest among the lots that can still be
-- sold. A lot past its expires_on is the write-off's to consume (spec:1054), never a pick's. `current_date`
-- is the session's date; effective_date is a user-entered accounting date and is not consulted here,
-- because whether a batch is fit to ship is a fact about today, not about the document's date.
-- The sentinel lot (expires_on null) is unaffected and still sorts last.

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
       and (l.expires_on is null or l.expires_on >= current_date)   -- 0112: an expired lot is never picked
     order by l.expires_on asc nulls last, l.code asc, h.lot_id asc
  loop
    exit when remaining <= 0;
    lot_id   := r.id;
    quantity := least(r.available, remaining);
    remaining := remaining - quantity;
    return next;
  end loop;
end $$;

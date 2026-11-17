-- ── 0114 · a negative-stock override approves the document's stock lines as they stood ─────────────────
-- Phase 4 code-review pass (not a slice); allocated from the §3.4.1 tail (register row 0113–0115).
--
-- spec:624 (LEGACY-048 "New system"): "an audited, explicitly-granted override recording who overrode what";
-- spec:2179 (R8): overrides are "exercised per document by a second principal". The two consumers of
-- `inventory.negative_stock.override` — 0031's app.assert_stock_available and applyMovements — asked only
-- whether an override event EXISTED on the document. The event recorded who and which document, never what:
-- a supervisor approved a one-unit shortfall, the creator re-keyed the draft to 1,000 through PUT …/lines, and
-- the post drove stock to -1000.000000 on the strength of an approval of one.
--
-- The credit-limit override had the same defect and 0045 fixed it by stamping the figure approved
-- (approved_base_total). The stock override cannot copy that shape exactly: acceptance test 7 records it on an
-- ISSUED document, so it cannot be cut off at `approved`. It is bound instead to the document's STOCK CONTENT
-- — a digest of every stock-relevant column, stamped by the database when the event is written and compared
-- when stock is short — and an override admits the document only while that content is unchanged. Editing the
-- lines after the approval makes the approval approve nothing; the supervisor records it again.
--
-- A residue this does not remove, and is not the defect: the shortfall can still grow between override and
-- post because OTHER documents consume the same stock, exactly as credit exposure can grow under 0045.

-- ── 1. the column and its check (0045's approved_base_total is the sister) ───────────────────────────
alter table app.document_event add column approved_stock_digest text;
alter table app.document_event
  add constraint document_event_approved_stock_digest_check
      check (approved_stock_digest is null
          or (event_kind = 'override' and override_code = 'inventory.negative_stock.override'));
comment on column app.document_event.approved_stock_digest is
  'Code review 2 (Phase 4): on an inventory.negative_stock.override event only — app.document_stock_digest() of '
  'the document when the override was recorded, stamped by app.stamp_stock_override(). '
  'app.stock_override_admits() admits a shortfall only while the document''s digest still equals it.';

-- ── 2. the digest: ONE function, used at the stamp and at the check ───────────────────────────────────
-- The header's two warehouses and, in line_no order, every line that names an item — the lines
-- planMovements reads (it keys on item_id, not on kind) — as entered: item, warehouse, lot, unit, the base
-- quantity and the two count columns (a TRANSFER_RECEIPT's legs move expected_quantity and counted_quantity,
-- not `quantity`). A null lot stays null: the NONE-sentinel resolution happens later, in applyMovements, and
-- is never written back, so the digest is stable from the override to the post. `stable` and unqualified
-- reads, so it runs under the caller's RLS. jsonb's text form is canonical (keys sorted, numerics at their
-- column scale), so two calls over the same rows cannot disagree.
create function app.document_stock_digest(p_document uuid) returns text
language sql stable as $$
  select encode(sha256(convert_to(jsonb_build_object(
           'warehouse_id',    d.warehouse_id,
           'to_warehouse_id', d.to_warehouse_id,
           'lines', coalesce((
             select jsonb_agg(jsonb_build_array(l.line_no, l.item_id, l.warehouse_id, l.lot_id, l.unit_id,
                                                l.quantity, l.expected_quantity, l.counted_quantity)
                              order by l.line_no)
               from app.document_line l
              where l.document_id = d.id and l.item_id is not null), '[]'::jsonb))::text, 'UTF8')), 'hex')
    from app.document d
   where d.id = p_document
$$;
comment on function app.document_stock_digest(uuid) is
  'Code review 2 (Phase 4): sha256 over the document''s stock content — header warehouse_id/to_warehouse_id '
  'and each item line''s (line_no, item_id, warehouse_id, lot_id, unit_id, quantity, expected_quantity, '
  'counted_quantity). The one spelling app.stamp_stock_override() and app.stock_override_admits() share.';

-- ── 3. the stamp — never a caller's value (LEGACY-044), and refused once the document has posted ─────────
-- Draft, submitted, approved and issued are all legal: test 7 records the override on an issued document,
-- and the posting that consumes it runs from any of them. A posted, void or reversed document has no post
-- left for an override to admit, so one recorded there would be a record of an approval never used.
create function app.stamp_stock_override() returns trigger language plpgsql as $$
declare
  v_status app.document_status;
begin
  select d.status into v_status from app.document d where d.id = new.document_id;
  -- An invisible document is document_event_override_guard's refusal (ERR_OVERRIDE_NOT_AUTHORISED), which
  -- fires first (name order); the composite FK refuses a document that does not exist at all.
  if v_status is null then return new; end if;
  if v_status in ('posted', 'void', 'reversed') then
    raise exception
      'ERR_DOC_STATUS_ILLEGAL: document % is %; a negative-stock override is recorded before the document posts, '
      'which is when stock availability is checked', new.document_id, v_status
      using errcode = 'check_violation';
  end if;
  new.approved_stock_digest := app.document_stock_digest(new.document_id);
  return new;
end $$;
comment on function app.stamp_stock_override() is
  'Code review 2 (Phase 4): stamps approved_stock_digest on an inventory.negative_stock.override event, and '
  'refuses one on a posted, void or reversed document (ERR_DOC_STATUS_ILLEGAL).';
create trigger document_event_stock_override_digest
  before insert on app.document_event
  for each row
  when (new.event_kind = 'override' and new.override_code = 'inventory.negative_stock.override')
  execute function app.stamp_stock_override();

-- ── 4. the door, as the two consumers now ask it ──────────────────────────────────────────────────────
create function app.stock_override_admits(p_document uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from app.document_event e
     where e.document_id   = p_document
       and e.event_kind    = 'override'
       and e.override_code = 'inventory.negative_stock.override'
       and e.approved_stock_digest = app.document_stock_digest(p_document))
$$;
comment on function app.stock_override_admits(uuid) is
  'Code review 2 (Phase 4): true when an inventory.negative_stock.override event on the document approved its '
  'CURRENT stock content. Asked by app.assert_stock_available() and by applyMovements; nothing else decides it.';

-- ── 5. 0031's trigger function, with the existence test replaced by the door above ────────────────────
-- Everything else is 0031's body as it stands: availability is summed from app.inventory_movement (this
-- transaction's earlier rows included), there is no session flag and no policy flag. The refusal says when an
-- override exists but approved other lines, so the operator knows the fix is to record it again.
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

  if app.stock_override_admits(new.document_id) then
    return new;
  end if;

  if exists (
    select 1 from app.document_event e
     where e.document_id   = new.document_id
       and e.event_kind    = 'override'
       and e.override_code = 'inventory.negative_stock.override'
  ) then
    raise exception 'ERR_STOCK_INSUFFICIENT: item % warehouse % lot % holds %, this movement needs %; the negative-stock override on document % approved other stock lines than it now carries — record the override again',
      new.item_id, new.warehouse_id, new.lot_id, available, (- new.quantity), new.document_id
      using errcode = 'check_violation';
  end if;

  raise exception 'ERR_STOCK_INSUFFICIENT: item % warehouse % lot % holds %, this movement needs %',
    new.item_id, new.warehouse_id, new.lot_id, available, (- new.quantity)
    using errcode = 'check_violation';
end $$;

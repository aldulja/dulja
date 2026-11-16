-- ── 0032 · app.document_line — the inventory columns, the item_id key, and the base quantity ───
-- contracts §4.3.4's 3A row: warehouse_id, lot_id, unit_id, unit_quantity, and the (tenant_id, item_id)
-- key 2A left open. Expand only — every column is nullable, so the deploy is the expand half of
-- expand/contract (spec:2057) and no live row needs a backfill.
-- spec:2043: "Quantity is stored once, in the item's base unit; the entered unit and quantity are kept
-- for display." unit_id/unit_quantity are that display pair, and the trigger below is what makes the
-- sentence true on every write path rather than in the one handler that remembers (SAH-066).
-- Nothing in this migration writes a row: hazard 10, and FORCE ROW LEVEL SECURITY binds app_migrator
-- too (spec:1366), so a migration with no tenant set could not insert one in any case.

-- ── 1. the four columns ─────────────────────────────────────────────────────────────────────────
-- spec:2043 (§3.9 Quantities) and contracts §4.3.4's 3A row fix all four names and types.
alter table app.document_line add column warehouse_id  uuid;
alter table app.document_line add column lot_id        uuid;           -- NULLABLE: applyMovements
                                                                       -- resolves the item's 'NONE'
                                                                       -- sentinel lot (§4.7.3, ADR 0034)
alter table app.document_line add column unit_id       uuid;
alter table app.document_line add column unit_quantity numeric(19,6);  -- the quantity AS ENTERED

-- ── 2. the four foreign keys, all composite (tenant_id, x) (spec:106, SAH-073) ──────────────────
-- §4.3.4: "3A's 0032 adds (tenant_id, item_id) → app.item … and adds its field to DocumentLineInput in
-- the same PR as its key, never before". 2A's own tests wrote arbitrary uuids into item_id, which was
-- legal exactly until this statement; they are fixed in this PR.
alter table app.document_line add constraint document_line_item_fk
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id);
alter table app.document_line add constraint document_line_warehouse_fk
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id);
alter table app.document_line add constraint document_line_lot_fk
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id);
alter table app.document_line add constraint document_line_unit_fk
  foreign key (tenant_id, unit_id)      references app.unit_of_measure(tenant_id, id);
-- Partial: a JOURNAL line carries no warehouse, and most lines in an accounting-only tenant never will.
create index document_line_warehouse_idx on app.document_line (warehouse_id) where warehouse_id is not null;
-- No branch_isolation policy on this table, now or ever: §3.5.1 step 7 and §4.5.6 both say a
-- warehouse_id alone does not qualify, and document_line is isolated through its parent document.

-- ── 3. the base quantity, derived in SQL so no write path can skip it (SAH-066) ─────────────────
-- Behaviour, in three branches:
--   * no entered pair (unit_id or unit_quantity null) -> quantity is left exactly as written. A JOURNAL
--     line has neither, and a line typed directly in base units has neither.
--   * pair present, quantity null -> quantity := round(unit_quantity * numerator / denominator, 6).
--   * pair present, quantity supplied -> the two must agree, or ERR_VALIDATION_FAILED naming both
--     figures. Overwriting a supplied value silently would hide a caller bug; the round() is symmetric
--     across sign (Postgres numeric round() is half away from zero), so a reversal's negated pair agrees
--     with its negated quantity by construction and reverse.ts needs no special case.
-- The base unit needs no unit_conversion row: unit_id = item.base_unit_id resolves to 1/1.
-- Every raise is a check_violation token in the `TOKEN: text` form (plan0A:1130-1141), which
-- fromDatabaseError maps to ERR_VALIDATION_FAILED; §4.2.4's row gains this function as a raiser.
create function app.document_line_base_quantity() returns trigger
language plpgsql as $$
declare
  base_unit uuid;
  num       bigint;
  den       bigint;
  derived   numeric(19,6);
begin
  if new.unit_id is null or new.unit_quantity is null then
    return new;
  end if;
  if new.item_id is null then
    raise exception 'ERR_VALIDATION_FAILED: line % carries a unit and a unit quantity but no item', new.line_no
      using errcode = 'check_violation';
  end if;

  select i.base_unit_id into base_unit from app.item i where i.id = new.item_id;
  if base_unit = new.unit_id then
    num := 1; den := 1;
  else
    select c.numerator, c.denominator into num, den
      from app.unit_conversion c
     where c.item_id = new.item_id and c.unit_id = new.unit_id;
    if num is null then
      raise exception 'ERR_VALIDATION_FAILED: no unit conversion for item % and unit % on line %',
        new.item_id, new.unit_id, new.line_no using errcode = 'check_violation';
    end if;
  end if;

  derived := round(new.unit_quantity * num::numeric / den::numeric, 6);
  if new.quantity is null then
    new.quantity := derived;
  elsif new.quantity <> derived then
    raise exception 'ERR_VALIDATION_FAILED: line % says % base units but % of that unit is %',
      new.line_no, new.quantity, new.unit_quantity, derived using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger document_line_base_quantity before insert or update on app.document_line
  for each row execute function app.document_line_base_quantity();

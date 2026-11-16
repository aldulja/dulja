-- ── 0031 · app.inventory_movement, app.stock_on_hand, and the warehouse / lot link columns ─────
-- The movement ledger and its synchronous projection, given verbatim by contracts §4.7.3, plus the three link
-- columns other slices assigned to this file: document.warehouse_id / to_warehouse_id (§4.3.4's 3A row) and
-- attachment.lot_id (2C's own note, spec:1067 "3 (lot link)"). The file's name says all four things it does,
-- per §3.4.2's rule that a name understating its contents is renamed, not left.
-- Nothing in this migration writes a row: hazard 10 — FORCE ROW LEVEL SECURITY binds app_migrator and a
-- migration has no tenant set, so per-tenant rows are seed-pack data. The writer is Task 8's applyMovements.

-- ── 1. inventory_movement — append-only and signed, exactly as ledger_entry is ────────────────────────
create table app.inventory_movement (                        -- IMMUTABLE, audit-exempt (plan0A:1624-1629)
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  document_id     uuid not null,
  line_no         int not null,                              -- the source document_line.line_no
  movement_no     int not null check (movement_no > 0),      -- 1-based per document; the unique key. A `transfer`
                                                             -- line emits TWO movements (issue at warehouse,
                                                             -- receipt at to_warehouse), so line_no alone is not
                                                             -- unique — TRANSFER/TRANSFER_RECEIPT would collide.
  item_id         uuid not null,
  warehouse_id    uuid not null,
  lot_id          uuid not null,                             -- NOT NULL: stock_on_hand's primary key contains
                                                             -- lot_id, so a NULL here would fail the step-12
                                                             -- MERGE at runtime. Every item has one sentinel lot
                                                             -- coded 'NONE' created with it (migration 0029);
                                                             -- applyMovements resolves a line's null lot_id to it
                                                             -- before insert (LEGACY-050, ADR 0034).
  unit_id         uuid not null,
  quantity        numeric(19,6) not null check (quantity <> 0),   -- base unit; + receipt, − issue (spec:2043)
  value           numeric(19,4) not null,                    -- mandatory (LEGACY-007); base currency; sign follows quantity
  effective_date  date not null,                             -- the accounting date, never derived from posted_at (spec:2039)
  posting_seq     bigint not null,                           -- document.posting_seq, assigned at step 8 (§4.3.5)
  posted_at       timestamptz not null default now(),        -- the posting instant (spec:1370's ledger_entry pattern)
  created_at      timestamptz not null default now(),        -- spec:1370 exempts ONLY ledger_entry from created_at;
                                                             -- this table is neither a join nor a counter table
  posted_by       uuid not null default app.current_actor() references app.principal(id),   -- stamped
  unique (document_id, movement_no),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)  references app.document(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id),
  foreign key (tenant_id, unit_id)      references app.unit_of_measure(tenant_id, id)
);
-- The total chronological key of spec:1225 and §4.3.5, as an index and not as a plan hint (LEGACY-067).
create index inventory_movement_chrono_idx on app.inventory_movement
  (company_id, item_id, warehouse_id, effective_date, posting_seq, line_no, movement_no);
call app_meta.enable_tenant_rls('app.inventory_movement');
call app_meta.attach_stamp('app.inventory_movement', 'posted_by');
-- No attach_audit: the table is in AUDIT_EXEMPT (spec:1370, §3.5.3) — auditing an append-only movement ledger
-- would serialise every post behind the per-tenant audit lock to record what the row already is.
create trigger inventory_movement_immutable before update or delete on app.inventory_movement
  for each row execute function app.forbid_change();
revoke update, delete on app.inventory_movement from app_rw;

-- ── 2. assert_stock_available — §4.7.3's comment, as code (test 18, LEGACY-048, spec:2436) ───────────────
-- Availability is summed from THIS table, which already includes the current transaction's earlier rows, and
-- NEVER from stock_on_hand, which is MERGEd only at step 12. The one door is an override document_event
-- recorded by a second principal (§4.5.3): document_event_override_guard is what proves the second principal
-- held the code at the document's branch, so this function only has to see that the event exists.
-- There is deliberately NO session flag and NO policy flag here. spec:2436 requires the refusal "regardless of
-- session flags, user attributes, or write path", and policy.inventory.allowNegative is a user attribute.
create function app.assert_stock_available() returns trigger
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
create trigger inventory_movement_stock_available before insert on app.inventory_movement
  for each row execute function app.assert_stock_available();

-- ── 3. stock_on_hand — the synchronous projection (D14), MERGEd in the posting transaction ────────────
create table app.stock_on_hand (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  item_id      uuid not null,
  warehouse_id uuid not null,
  lot_id       uuid not null,
  quantity     numeric(19,6) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (company_id, item_id, warehouse_id, lot_id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id)
);
-- No `id` and no unique (tenant_id, id): the natural key IS the key, which is why the table joins NO_ID_TABLES
-- in lint-schema.ts in this same PR (§3.5.3). No attach_audit either — it is derived (AUDIT_EXEMPT).
-- `lot_id` is NOT NULL on both sides: every item has one sentinel lot coded 'NONE' and applyMovements resolves
-- a line's null lot to it, so the primary key never contains NULL (LEGACY-050). document_line.lot_id stays
-- nullable — the user need not enter a lot; the posting service is what resolves the sentinel.
call app_meta.enable_tenant_rls('app.stock_on_hand');

-- ── 4. pick_lots_fefo — FEFO over the projection, not over a replay of history (LEGACY-067, ADR 0036) ────
-- Reads the SYNCHRONOUS projection, so outside a posting transaction it is current to the last commit. The
-- ordering is total — expiry, then lot code, then lot id — so two identical calls cannot disagree; LEGACY-067's
-- root cause was an answer that depended on which index the planner chose.
-- Returns fewer rows than asked when the warehouse cannot satisfy the quantity: refusing is
-- assert_stock_available's job, and a picker that raised would hide a partial pick a user may legitimately want.
create function app.pick_lots_fefo(p_item_id uuid, p_warehouse_id uuid, p_quantity numeric)
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

-- ── 5. the three link columns (§4.3.4's 3A header row; 2C's attachment note, spec:1067) ───────────────
alter table app.document add column warehouse_id    uuid;      -- header default; a line's warehouse_id overrides
alter table app.document add column to_warehouse_id uuid;      -- the transfer destination (3D's TRANSFER)
alter table app.document add constraint document_warehouse_fk
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id);
alter table app.document add constraint document_to_warehouse_fk
  foreign key (tenant_id, to_warehouse_id) references app.warehouse(tenant_id, id);

alter table app.attachment add column lot_id uuid;             -- spec:1067 "linked to a document or a lot"
alter table app.attachment add constraint attachment_lot_fk
  foreign key (tenant_id, lot_id) references app.lot(tenant_id, id);
-- Exactly one owner. 2C left document_id nullable for this column's arrival and shipped no check, so the
-- constraint lands here with the second option: an attachment with neither owner is unreachable by either
-- read path, and one with both would need two different permission codes at once (§4.5.8).
alter table app.attachment add constraint attachment_owner_check
  check (num_nonnulls(document_id, lot_id) = 1);
create index attachment_lot_idx on app.attachment (lot_id) where lot_id is not null;

-- 0038_create_landed_cost_allocation.sql
-- Slice 3C. The stored allocation of an import shipment's freight, duty and clearance across its goods lines.
-- spec:1020  — "Imported goods carry freight, duty, clearance and handling that must be allocated across a
--               shipment and into unit cost — otherwise every margin figure is wrong."
-- spec:1049  — the import-shipment document carries freight, duty and clearance into landed cost per lot.
-- SAH-049    — an aggregate with no unique key duplicates under an upsert race and is then double-updated
--               forever. `unique (cost_line_id, target_line_id)` is that key, and it is the ONLY replacement
--               mechanism this table has: app_rw holds no DELETE (contracts §3.5.4 is closed).
-- SAH-017/018 — nothing derived is stored. There is no `weight` column: the basis is `method` plus the target
--               line's own amount / quantity / custom_fields.weight_kg, and the trigger pins both lines to the
--               same document so those columns cannot come from somewhere else.

-- ── 1. app.landed_cost_allocation ─────────────────────────────────────────────
create table app.landed_cost_allocation (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references app.tenant(id),
  company_id            uuid not null,
  shipment_document_id  uuid not null,                                   -- the SHIPMENT / GOODS_RECEIPT draft
  cost_line_id          uuid not null,                                   -- the freight/duty/clearance line (kind = 'account')
  target_line_id        uuid not null,                                   -- the goods line receiving a share (kind = 'item')
  method                text not null
    check (method in ('by_value', 'by_quantity', 'by_weight')),          -- the §2.4 card's three methods, closed
  allocated_amount      numeric(19,4) not null check (allocated_amount >= 0),
                                                                          -- DOCUMENT currency; ZERO IS LEGAL, and the
                                                                          -- handler writes every pair on every call so a
                                                                          -- re-allocation cannot leave a stale share
  created_at            timestamptz not null default now(),
  check (cost_line_id <> target_line_id),                                -- a line never allocates onto itself
  unique (tenant_id, id),
  unique (cost_line_id, target_line_id),                                 -- the upsert key (SAH-049)
  -- Composite FKs: an FK check bypasses RLS, so a plain reference would let tenant A point at tenant B's row.
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  -- Every reference cascades from the DRAFT document: re-lining or deleting the draft releases the allocation,
  -- which is the only release path (contracts §3.5.4; app_rw holds no DELETE here).
  foreign key (tenant_id, shipment_document_id) references app.document(tenant_id, id)      on delete cascade,
  foreign key (tenant_id, cost_line_id)         references app.document_line(tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_line_id)       references app.document_line(tenant_id, id) on delete cascade
);

create index landed_cost_allocation_document_idx on app.landed_cost_allocation (shipment_document_id);
create index landed_cost_allocation_target_idx   on app.landed_cost_allocation (target_line_id);

call app_meta.enable_tenant_rls('app.landed_cost_allocation');
call app_meta.attach_audit('app.landed_cost_allocation');
-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE: §3.5.4 is closed.

-- ── 2. The draft-only and same-document guard (spec:2173 — the data layer is the control) ──
create function app.assert_landed_cost_allocation_draft() returns trigger language plpgsql as $$
declare
  v_status     app.document_status;
  v_cost_doc   uuid;
  v_target_doc uuid;
begin
  -- Draft-only, and this is arithmetic rather than policy: 3B's replay recomputes a receipt's layer as
  -- unit_cost = value / quantity from the IMMUTABLE inventory_movement.value, so after post there is nothing
  -- an allocation could change. A correction is reverseDocument plus a re-post.
  select d.status into v_status from app.document d where d.id = new.shipment_document_id;
  if v_status is null then
    raise exception 'ERR_NOT_FOUND: document % is not visible', new.shipment_document_id
      using errcode = 'check_violation';
  end if;
  if v_status <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is % — landed cost is allocated on a draft, because a posted movement''s value is immutable',
      new.shipment_document_id, v_status
      using errcode = 'check_violation';
  end if;

  -- Same document. The composite FKs prove only the TENANT; without this a company could allocate one
  -- document's freight across another document's goods lines and inflate that document's layers.
  select l.document_id into v_cost_doc   from app.document_line l where l.id = new.cost_line_id;
  select l.document_id into v_target_doc from app.document_line l where l.id = new.target_line_id;
  if v_cost_doc is distinct from new.shipment_document_id
     or v_target_doc is distinct from new.shipment_document_id then
    raise exception 'ERR_VALIDATION_FAILED: cost line % and target line % must both belong to document %',
      new.cost_line_id, new.target_line_id, new.shipment_document_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger landed_cost_allocation_draft_only before insert or update on app.landed_cost_allocation
  for each row execute function app.assert_landed_cost_allocation_draft();

-- ── 0029 · app.warehouse, app.lot, app.variant, and the per-item sentinel lot ──────────────────
-- spec:1182 (§3.3 Warehouse tree ── StockBalance), spec:1022–1023 (§3.0.3 Batch/lot with expiry;
-- Multi-branch stock), spec:161 (§0.4 Batch → Lot), spec:1048 (§3.0.4 Inventory core).
-- LEGACY-071: the tree check is ONE recursive CTE in ONE function, not a recursive procedure called per
-- row in three modules. LEGACY-050: every item gets a sentinel lot so the stock_on_hand primary key,
-- which contains lot_id, never holds NULL (ADR 0034).

-- ── 1. warehouses, as a tree, one branch each ───────────────────────────────────────────────────
-- branch_id is a BRANCH dimension_value (spec:2166). It is NOT NULL — head-office stores carry the
-- head-office value — which is what makes 6C's Form A″ branch_isolation policy total. `in_transit` is
-- the two-step-transfer waypoint spec:1053 needs; 3D uses it and Form A″ exempts it from branch
-- isolation so both branches of a transfer can see the goods in flight (§4.5.6).
create table app.warehouse (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  kind        text not null default 'stock' constraint warehouse_kind_check check (kind in ('stock', 'in_transit')),
  branch_id   uuid not null,
  parent_id   uuid,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, parent_id)  references app.warehouse(tenant_id, id)
);
create index warehouse_parent_idx on app.warehouse (parent_id) where parent_id is not null;
create index warehouse_branch_idx on app.warehouse (company_id, branch_id);

-- LEGACY-071: cycle detection as one recursive CTE walking UP from the proposed parent. The old system
-- called a recursive procedure per row inside a trigger, duplicated in at least three modules, and
-- RecursiveRecord was the most-raised exception in the corpus. This is the only such check in Dulja.
create function app.warehouse_no_cycle() returns trigger language plpgsql as $$
begin
  if new.parent_id is null then
    return new;
  end if;
  if new.parent_id = new.id then
    raise exception 'ERR_WAREHOUSE_TREE_CYCLE: warehouse % cannot be its own parent', new.id
      using errcode = 'check_violation';
  end if;
  if exists (
    with recursive ancestor as (
      select w.id, w.parent_id
        from app.warehouse w
       where w.id = new.parent_id
      union all
      select w.id, w.parent_id
        from app.warehouse w
        join ancestor an on w.id = an.parent_id
    )
    select 1 from ancestor where ancestor.id = new.id
  ) then
    raise exception 'ERR_WAREHOUSE_TREE_CYCLE: making warehouse % a child of % would close a cycle',
      new.id, new.parent_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger warehouse_no_cycle before insert or update of parent_id on app.warehouse
  for each row execute function app.warehouse_no_cycle();

-- ── 2. lots, with expiry ────────────────────────────────────────────────────────────────────────
create table app.lot (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  item_id          uuid not null,
  code             text not null,
  expires_on       date,                                          -- spec:1022; FEFO and the alert job read it
  manufactured_on  date,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint lot_expiry_after_manufacture_check
    check (manufactured_on is null or expires_on is null or expires_on >= manufactured_on),
  unique (item_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)    references app.item(tenant_id, id)
);
-- FEFO orders by expires_on; the alert job filters on it. Partial, because the sentinel has none.
create index lot_expiry_idx on app.lot (company_id, expires_on)
  where expires_on is not null and archived_at is null;
create index lot_item_idx on app.lot (item_id);

-- LEGACY-050 / ADR 0034: one sentinel lot per item, created with the item, code 'NONE'. stock_on_hand's
-- primary key contains lot_id (§4.7.3), and a NULL there is exactly the old defect: MtoJob = NULL is
-- unknown, so the increment matched nothing and inserted an orphan, and the decrement matched nothing
-- and left the row. applyMovements resolves a line's null lot to this row before insert.
-- SECURITY INVOKER (the default): the insert runs as whoever inserted the item, under that session's
-- tenant, so app.lot's own tenant_isolation with-check is the control here as everywhere.
create function app.item_sentinel_lot() returns trigger language plpgsql as $$
begin
  insert into app.lot (tenant_id, company_id, item_id, code)
  values (new.tenant_id, new.company_id, new.id, 'NONE')
  on conflict (item_id, code) do nothing;
  return null;
end $$;

create trigger item_sentinel_lot after insert on app.item
  for each row execute function app.item_sentinel_lot();

-- No back-fill statement stands here, and that is not an omission. §3.4.8 restricts migration data to the
-- one GLOBAL table app.permission precisely because `FORCE ROW LEVEL SECURITY` binds app_migrator too
-- (spec:1366): a migration file with no `set_config` sees zero tenants, so an
-- `insert into app.lot … select … from app.item` could never insert a row — not in the runner and not in
-- the local `up`-in-stages case either, which also goes through `up(sql, dir)` on `db.migrator` with no
-- tenant set. The guarantee that every item has its sentinel is the AFTER INSERT trigger above, and it is
-- asserted where there are rows to assert over: `packages/db/test/inventory/lot.test.ts` checks that no
-- app.item row lacks a 'NONE' lot, inside `withTenant`. (0031's header makes the same point for itself:
-- "Nothing in this migration writes a row: hazard 10".)

-- ── 3. variants ─────────────────────────────────────────────────────────────────────────────────
-- spec:1181. Reserved and complete, but no document type reads it in v1: a variant is a selling
-- attribute (size, colour), and the food distributor's v1 catalogue is coded per SKU.
create table app.variant (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references app.tenant(id),
  item_id    uuid not null,
  code       text not null,
  name_en    text not null,
  name_ar    text,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (item_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references app.item(tenant_id, id)
);

-- ── 4. tenancy and audit ────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.warehouse');
call app_meta.enable_tenant_rls('app.lot');
call app_meta.enable_tenant_rls('app.variant');
call app_meta.attach_audit('app.warehouse');
call app_meta.attach_audit('app.lot');
call app_meta.attach_audit('app.variant');
-- No *_by column on any of the three. No DELETE grant (§3.5.4); removal is `archived_at`.

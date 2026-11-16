-- ── 0034. Cost layers, consumptions and the stock-valuation snapshot ─────────────────
-- contracts §4.7.3 (cost_layer verbatim; cost_consumption verbatim PLUS the four additions amendment A23
--            records — the CHECKs `quantity > 0`, `unit_cost >= 0`, `value >= 0`, and the composite
--            `foreign key (tenant_id, company_id) references app.company(tenant_id, id)` that §4.7.3's
--            block omits while cost_layer and stock_valuation both carry it)
--            and §4.6.1 (stock_valuation).
-- spec:1210  movements are immutable; cost layers are DERIVED — rebuildable, and rebuilt forward
--            from any invalidation point. qty_remaining is mutable precisely because it is derived.
-- spec:1216-1221  one layer per inventory receipt; issues consume layers per the company's method and
--            record exactly what they consumed; a back-dated document invalidates only layers at or
--            after its sequence; the replay writes an adjustment entry.
-- spec:1370, 1993  derived tables are AUDIT-EXEMPT but MUST stay updatable by app_rw.
-- SAH-004  cost is a derived function of an immutable ordered movement ledger, never a running scalar.
-- SAH-008  unit_cost >= 0 and qty_remaining >= 0 are CHECKs, not conventions: a negative computed cost
--          is a hard error and must never reach a stored row.
-- Nothing in this migration writes a row: hazard 10 — FORCE ROW LEVEL SECURITY binds app_migrator and a
-- migration has no tenant set, so every per-tenant row here is the posting service's or the replay's.

-- ── 1. cost_layer ───────────────────────────────────────────────────────────────────
create table app.cost_layer (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  item_id        uuid not null,
  warehouse_id   uuid not null,
  lot_id         uuid not null,
  movement_id    uuid not null,
  qty_in         numeric(19,6) not null,
  unit_cost      numeric(19,4) not null check (unit_cost >= 0),          -- SAH-008: never a negative stored cost
  qty_remaining  numeric(19,6) not null check (qty_remaining >= 0),      -- SAH-008: never a negative residue
  effective_at   date   not null,                                        -- = movement.effective_date
  sequence       bigint not null,                                        -- = movement.posting_seq (spec:1220 "sequence")
  invalidated_at timestamptz,                                            -- set by invalidateFrom; cleared by the replay
  created_at     timestamptz not null default now(),
  unique (movement_id),                                                  -- one receipt, one layer — the replay UPDATEs, never inserts a second
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id),
  foreign key (tenant_id, lot_id)       references app.lot(tenant_id, id),
  foreign key (tenant_id, movement_id)  references app.inventory_movement(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.cost_layer');
-- No attach_audit: cost_layer is in AUDIT_EXEMPT (plan0A:2707-2710). Auditing it would serialise every
-- recost behind the per-tenant audit lock for nothing — the movements it derives from are the record (spec:1210).
-- No attach_stamp: no *_by column, deliberately. A layer is not something a principal did; it is arithmetic
-- over movements, each of which already carries its own stamped posted_by (contracts §3.3's *_by rule).

-- The costing scope is (company, item, warehouse) — NOT the lot. AVCO has no per-lot average and FIFO walks
-- the oldest layer whatever lot it belongs to; the lot is on the row because stock_on_hand's key needs it and
-- because a consumption must say which lot left. Availability is checked per lot by 3A's assert_stock_available.
-- The ordering columns are the first four elements of the contracts §4.3.5 chronological key; line_no and
-- movement_no come from the joined movement, which is why the index carries the movement id last.
create index cost_layer_open_idx
  on app.cost_layer (company_id, item_id, warehouse_id, effective_at, sequence, movement_id)
  where invalidated_at is null and qty_remaining > 0;
create index cost_layer_invalid_idx
  on app.cost_layer (company_id, item_id, effective_at, sequence)
  where invalidated_at is not null;                                      -- the replay's resume point (SAH-054)

-- ── 2. cost_consumption ─────────────────────────────────────────────────────────────
-- spec:1218 "record exactly what they consumed". No natural unique key: an AVCO issue takes a proportional
-- slice of EVERY open layer, so one movement legitimately produces many rows, and a recost replaces the set
-- by marking it invalidated_at and inserting a fresh one.
create table app.cost_consumption (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  movement_id    uuid not null,
  layer_id       uuid not null,
  -- The three CHECKs below are amendment A23, not §4.7.3's text. `quantity > 0` is the load-bearing one: it
  -- forbids a zero-quantity consumption row, so 3C's landed cost and 3D's variance adjust a LAYER's unit_cost
  -- or post an adjustment rather than writing a nil consumption.
  quantity       numeric(19,6) not null check (quantity > 0),            -- a magnitude; the movement carries the sign
  unit_cost      numeric(19,4) not null check (unit_cost >= 0),
  value          numeric(19,4) not null check (value >= 0),
  invalidated_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  -- The company FK is amendment A23 too: §4.7.3's block declares `company_id` and no key over it, while
  -- `cost_layer` and `stock_valuation` beside it both carry one. Plan 0A's `composite_fk` rule only inspects
  -- FKs that EXIST, so `lintSchema` would have stayed green over the omission — which is exactly why it is
  -- recorded rather than left for the next reader to take for an oversight. The Global Constraints' Always
  -- list ("composite FKs `(tenant_id, <parent>_id)` to every tenant-scoped parent") is the rule it restores.
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, movement_id) references app.inventory_movement(tenant_id, id),
  foreign key (tenant_id, layer_id)    references app.cost_layer(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.cost_consumption');
-- No attach_audit (AUDIT_EXEMPT, plan0A:2707-2710); no *_by column, for the same reason as cost_layer.
create index cost_consumption_movement_idx on app.cost_consumption (movement_id) where invalidated_at is null;
create index cost_consumption_layer_idx    on app.cost_consumption (layer_id)    where invalidated_at is null;

-- ── 3. stock_valuation ──────────────────────────────────────────────────────────────
-- spec:1204 names it an ASYNCHRONOUS projection, rebuilt by a pg-boss job and compared row for row.
-- contracts §4.6.1 fixes the columns and the primary key; §3.5.3 puts it in NO_ID_TABLES (natural key) and
-- adds it to AUDIT_EXEMPT. Joining NO_ID_TABLES also exempts it from the created_at rule (the set is derived
-- as NO_ID_TABLES + {ledger_entry}, plan0A:2702) — the column is here anyway, because spec:106's Always list
-- names created_at for every new table and account_balance and stock_on_hand both carry one.
create table app.stock_valuation (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  item_id      uuid not null,
  warehouse_id uuid not null,
  as_of        date not null,
  quantity     numeric(19,6) not null default 0,
  value        numeric(19,4) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (company_id, item_id, warehouse_id, as_of),
  foreign key (tenant_id, company_id)   references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)      references app.item(tenant_id, id),
  foreign key (tenant_id, warehouse_id) references app.warehouse(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.stock_valuation');

-- ── 4. Privileges ───────────────────────────────────────────────────────────────────
-- app_rw receives select, insert, update on all three through app_migrator's default privileges
-- (plan0A:2564) — no grant statement here. DELETE is not granted: contracts §3.5.4 pins that list and 2B is
-- the only slice that extends it. A superseded consumption is marked invalidated_at, never deleted (spec:2049).

-- ── 0028 · app.unit_of_measure, app.item, app.unit_conversion ──────────────────────────────────
-- spec:1178–1181 (§3.3 Item / UnitOfMeasure / conversions), spec:1048 (§3.0.4 Inventory core),
-- spec:2043 (§3.9 Quantities: conversions are exact rationals, never floats — SAH-066),
-- spec:158–160 (§0.4 Material → Item, MatUnits.Exchange → UnitConversion).
-- Contracts §4.6.1 fixes every column below.

-- ── 1. units of measure ─────────────────────────────────────────────────────────────────────────
create table app.unit_of_measure (
  id         uuid primary key default uuidv7(),
  tenant_id  uuid not null references app.tenant(id),
  company_id uuid not null,
  code       text not null,
  name_en    text not null,
  name_ar    text,                                                  -- spec:2045 bilingual labels as columns
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

-- ── 2. the item master ──────────────────────────────────────────────────────────────────────────
-- `kind` is NOT NULL because §4.4.1's `when: { "item.kind": … }` filter and §4.4.2's ItemRef.kind are
-- total: a NULL would silently match no rule and post a document with no revenue line.
-- The four account columns are the policy paths item.revenue_account / inventory_account /
-- cogs_account / expense_account (§4.4.1). They are filled from the §4.15 codes 4000 / 1300 / 5000 /
-- 5900 by resolveItemAccounts at create — there is no DDL default, because a default cannot look a
-- code up in this company's chart, and a wrong account is SAH-064 in a new costume.
create table app.item (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  code                 text not null,
  name_en              text not null,
  name_ar              text,
  kind                 text not null check (kind in ('product', 'service', 'asset')),   -- spec:1178
  base_unit_id         uuid not null,                               -- spec:2043 quantity is stored in this unit
  barcode              text,
  revenue_account_id   uuid,
  inventory_account_id uuid,
  cogs_account_id      uuid,
  expense_account_id   uuid,
  track_lots           boolean not null default true,               -- spec:1022 food is batch-tracked
  shelf_life_days      int constraint item_shelf_life_days_check check (shelf_life_days > 0),   -- SAH-063: a guarded divisor-shaped value
  archived_at          timestamptz,                                 -- spec:2049 master data is archived, never deleted
  created_at           timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, base_unit_id)         references app.unit_of_measure(tenant_id, id),
  foreign key (tenant_id, revenue_account_id)   references app.account(tenant_id, id),
  foreign key (tenant_id, inventory_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, cogs_account_id)      references app.account(tenant_id, id),
  foreign key (tenant_id, expense_account_id)   references app.account(tenant_id, id)
);
-- the till and the back office both scan; a partial index keeps it out of the way of items with none.
create index item_barcode_idx on app.item (company_id, barcode) where barcode is not null;

-- ── 3. exact-rational unit conversion (SAH-066) ─────────────────────────────────────────────────
-- "1 <unit> = numerator / denominator base units". bigint parts, never a float: MatUnits.Exchange was
-- `double precision` against `numeric(18,4)` quantities, so 10 boxes → 30 units → 9.9999… boxes.
-- The denominator CHECK is contracts §4.6.1 verbatim (`<> 0`); the numerator CHECK is added here
-- because a zero or negative factor is the other half of what nothing in the old system rejected.
-- Both constraints are NAMED, because packages/db/test asserts on the name.
create table app.unit_conversion (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  item_id     uuid not null,
  unit_id     uuid not null,
  numerator   bigint not null constraint unit_conversion_numerator_check   check (numerator > 0),
  denominator bigint not null constraint unit_conversion_denominator_check check (denominator <> 0),
  created_at  timestamptz not null default now(),
  unique (item_id, unit_id),
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references app.item(tenant_id, id),
  foreign key (tenant_id, unit_id) references app.unit_of_measure(tenant_id, id)
);

-- ── 4. tenancy and audit (spec:106, spec:1370, contracts §3.5.1) ────────────────────────────────
call app_meta.enable_tenant_rls('app.unit_of_measure');
call app_meta.enable_tenant_rls('app.item');
call app_meta.enable_tenant_rls('app.unit_conversion');
call app_meta.attach_audit('app.unit_of_measure');
call app_meta.attach_audit('app.item');
call app_meta.attach_audit('app.unit_conversion');
-- No *_by column on any of the three, so no attach_stamp (contracts §3.3's naming rule).
-- app_rw receives select/insert/update through default privileges (plan0A:2564). No DELETE grant:
-- §3.5.4's list is pinned and 2B is the only slice that extends it; removal is `archived_at`.

-- 0030_create_price_list_promotion.sql — price lists per customer type and promotions
-- (contracts §4.6.1; spec:1025 "Wholesale, retail, branch transfer pricing"; spec:1062 the POS offers clause;
-- spec:1312 "a shop pulls only its own price list, its own warehouse, its own promotions" — which is why both
-- price_list.branch_id and promotion.branch_id are NULLABLE: null means every branch, and 6C's Form B
-- branch_isolation policy (§4.5.6) is written for exactly that shape).

-- ── 1. price_list — currency, trade level, branch and date window ─────────────────────────────────────
create table app.price_list (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  code          text not null,
  name_en       text not null,                        -- spec:2045: name_en/name_ar columns, never a JSON blob
  name_ar       text,
  currency      char(3) not null,                     -- char(3) with no FK, exactly as app.party.currency (§4.5.7)
  customer_kind text,                                 -- the trade level; spec:1025's three examples are 'retail',
                                                      -- 'wholesale' and 'branch_transfer', and a tenant may use others
                                                      -- deliberately NO check: no code branches on it (spec:2047's
                                                      -- rule is about vocabularies the code branches on), and the
                                                      -- levels are the tenant's own — spec:1025's three are examples
  branch_id     uuid,                                 -- null = every branch (spec:1312)
  valid_from    date,
  valid_to      date,
  archived_at   timestamptz,                          -- spec:2049: master data is archived, never deleted
  created_at    timestamptz not null default now(),
  constraint price_list_window_check check (valid_to is null or valid_from is null or valid_to >= valid_from),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.price_list');
call app_meta.attach_audit('app.price_list');

-- ── 2. price_list_line — item × unit × quantity break ─────────────────────────────────────────────────
create table app.price_list_line (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  price_list_id uuid not null,
  item_id       uuid not null,
  unit_id       uuid,                                 -- null = the item's base unit
  min_quantity  numeric(19,6) not null default 0,     -- spec:2043 quantities are numeric(19,6)
  unit_price    numeric(19,4) not null,               -- spec:2041 money is numeric(19,4)
  archived_at   timestamptz,                          -- see the comment below: retirement without a DELETE grant
  created_at    timestamptz not null default now(),
  constraint price_list_line_min_quantity_check check (min_quantity >= 0),
  constraint price_list_line_unit_price_check   check (unit_price >= 0),
  -- NULLS NOT DISTINCT is load-bearing: unit_id is nullable, and under the default NULLS DISTINCT two rows
  -- for (list, item, null, 0) would both be accepted and resolvePrice would have two answers for one query.
  unique nulls not distinct (price_list_id, item_id, unit_id, min_quantity),
  unique (tenant_id, id),
  foreign key (tenant_id, price_list_id) references app.price_list(tenant_id, id),
  foreign key (tenant_id, item_id)       references app.item(tenant_id, id),
  foreign key (tenant_id, unit_id)       references app.unit_of_measure(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.price_list_line');
call app_meta.attach_audit('app.price_list_line');
create index price_list_line_item_idx on app.price_list_line (item_id, price_list_id) where archived_at is null;
-- archived_at is an addition to §4.6.1's row, and it is necessary rather than convenient: contracts §3.5.4 pins
-- the app_rw DELETE grant list and names 2B as its only extender, so replacePriceListLines cannot delete a line
-- the new payload omits. It archives it instead, which is also what spec:2049 wants for master data.

-- ── 3. promotion — the offer body 6B interprets and 6A down-syncs ──────────────────────────────────────
create table app.promotion (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  code        text not null,
  name_en     text not null,
  name_ar     text,
  kind        text not null,
  definition  jsonb not null,                         -- interpreted by 6B at the till; NO code in slice 3A reads it
  starts_at   timestamptz,
  ends_at     timestamptz,
  branch_id   uuid,                                   -- null = every branch (spec:1312)
  created_at  timestamptz not null default now(),
  -- text + CHECK, never a Postgres enum (spec:2047, §3.4.4 — a label cannot be used in the migration that adds it)
  constraint promotion_kind_check   check (kind in ('percent_off', 'amount_off', 'bundle')),
  constraint promotion_window_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.promotion');
call app_meta.attach_audit('app.promotion');
create index promotion_window_idx on app.promotion (company_id, starts_at, ends_at);
-- No archived_at here, and that is §4.6.1's row read strictly: a promotion is retired by setting ends_at, which
-- is what a date-windowed offer means. app_rw holds UPDATE through default privileges (plan0A:2564).
-- No *_by column on any of the three tables, so no attach_stamp (contracts §3.3's naming rule), and no DELETE
-- grant (§3.5.4): removal is `archived_at` on the two lists and `ends_at` on a promotion.

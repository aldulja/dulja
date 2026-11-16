-- 0059_add_catalogue_revision.sql
-- §3.7.3 "Every catalogue row carries a monotonic revision. It must be assigned in COMMIT order, not sequence
-- order" (spec:1299) · contracts §4.10.2 (C1 resolved) · ADR 0054.

-- ── 1. the sequence ───────────────────────────────────────────────────────────────────────────────────
-- One sequence for the whole database, not one per tenant: the cursor is a single scalar and a per-tenant
-- sequence would make two tenants' cursors incomparable for no gain. Gaps are expected and harmless — a
-- cursor asks for "> since", never for "the next one".
create sequence app.catalogue_revision_seq as bigint start with 1 no cycle;
grant usage, select on sequence app.catalogue_revision_seq to app_rw;

-- ── 2. tombstones (spec:1300 "Deletions travel as tombstones, never as silent absence") ────────────────
create table app.catalogue_tombstone (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  company_id  uuid not null,
  stream      text not null check (stream in ('item','price_list','price_list_line','promotion','customer','tax_code','cashier','branch_pos_policy')),
  row_id      uuid not null,
  revision    bigint not null,
  branch_id   uuid,                                   -- NULL = every branch (a company-wide price list or promotion)
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (stream, row_id),                            -- one tombstone per row; a resurrection is an upsert, not a second death
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
create index catalogue_tombstone_cursor_idx on app.catalogue_tombstone (company_id, revision);
call app_meta.enable_tenant_rls('app.catalogue_tombstone');
call app_meta.attach_audit('app.catalogue_tombstone');
-- branch_isolation is Form B and is attached by 6C's migration 0068 (§4.5.6, Task 0 amendment 4): branch_id is
-- nullable and a NULL row must stay VISIBLE, or a company-wide deletion never reaches any branch.

-- ── 3. the trigger (C1: the SAME advisory key the audit chain takes — §4.1's fixed literals) ───────────
-- A plain sequence hands out 100 to a transaction that commits AFTER a client has already read through 105,
-- and that row is never seen (spec:1299). Taking the lock BEFORE nextval and holding it to commit makes commit
-- order equal revision order. Reusing 'tenant-serial:' rather than spec:1299's 'catalogue:' is C1's resolution:
-- the audit chain already serialises per tenant on that key, and two keys would let a catalogue write and an
-- audit write deadlock against each other.
create function app.catalogue_revision() returns trigger language plpgsql as $$
declare
  v_stream     text := tg_argv[0];
  v_company    uuid := null;
  v_branch     uuid := null;
  v_archived   timestamptz := null;
  v_old_arch   timestamptz := null;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  new.revision := nextval('app.catalogue_revision_seq');

  -- Archival is this system's deletion (spec:2049 "Master data: archived_at, never DELETE"), so the tombstone
  -- is written on the archived_at NULL -> value transition and nowhere else. `app.promotion` has NO
  -- `archived_at` column at all (3A, phase-3a:2443: "a promotion is retired by setting ends_at"), so
  -- `to_jsonb(new) ->> 'archived_at'` is NULL for that stream and this branch never fires for it — which is
  -- correct and deliberate: a retired promotion travels as an UPSERT carrying the shortened `ends_at`, and the
  -- till's own window check retires it. A tombstone would be wrong there, because a promotion whose window was
  -- shortened is not deleted and must not vanish from the till's catalogue.
  v_archived := (to_jsonb(new) ->> 'archived_at')::timestamptz;
  if tg_op = 'UPDATE' then v_old_arch := (to_jsonb(old) ->> 'archived_at')::timestamptz; end if;
  if v_archived is null or v_old_arch is not null then
    return new;
  end if;

  -- The company and branch a tombstone must carry, per stream, resolved from the trigger's own literal
  -- argument and never from a column the row may not have.
  --   `price_list_line` has NEITHER `company_id` NOR `branch_id` (3A, phase-3a:2391-2410) — it reaches both
  --   through its parent list — so reading `to_jsonb(new) ->> 'company_id'` there yields NULL and the insert
  --   would violate `catalogue_tombstone.company_id NOT NULL`. That would break 3A's OWN retirement path
  --   (`replacePriceListLines` archives a line it cannot delete) the moment this migration landed, so the
  --   parent is looked up instead.
  --   `price_list` and `promotion` carry a nullable `branch_id`; `item`, `party` and `tax_code` are
  --   company-wide and carry NULL, which Form B reads as "every branch".
  if v_stream = 'price_list_line' then
    select p.company_id, p.branch_id into v_company, v_branch
      from app.price_list p where p.id = new.price_list_id;
  else
    v_company := (to_jsonb(new) ->> 'company_id')::uuid;
    if v_stream in ('price_list', 'promotion') then
      v_branch := (to_jsonb(new) ->> 'branch_id')::uuid;
    end if;
  end if;

  insert into app.catalogue_tombstone (tenant_id, company_id, stream, row_id, revision, branch_id)
  values (new.tenant_id, v_company, v_stream, new.id, new.revision, v_branch)
  on conflict (stream, row_id) do update set revision = excluded.revision, branch_id = excluded.branch_id;
  return new;
end $$;

-- ── 4. the six stream tables that already exist ───────────────────────────────────────────────────────
-- `default nextval(...)` and NOT the `default 0` of an earlier draft: on ADD COLUMN Postgres evaluates a
-- VOLATILE default once per existing row, so every pre-6A row gets a distinct increasing revision in one pass.
-- A `default 0` would hide every pre-existing row behind `revision > 0` from a fresh till (since = 0) and would
-- make thousands of rows share one keyset position, which acceptance test 20 would catch as a skipped page.
-- A backfill UPDATE is not an option: FORCE ROW LEVEL SECURITY binds app_migrator, so a migration sees no rows.
alter table app.item            add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.price_list      add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.price_list_line add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.promotion       add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.party           add column revision bigint not null default nextval('app.catalogue_revision_seq');
alter table app.tax_code        add column revision bigint not null default nextval('app.catalogue_revision_seq');

create index item_revision_idx            on app.item (company_id, revision);
create index price_list_revision_idx      on app.price_list (company_id, revision);
create index price_list_line_revision_idx on app.price_list_line (revision);
create index promotion_revision_idx       on app.promotion (company_id, revision);
create index party_revision_idx           on app.party (company_id, revision);
create index tax_code_revision_idx        on app.tax_code (company_id, revision);

create trigger catalogue_revision before insert or update on app.item            for each row execute function app.catalogue_revision('item');
create trigger catalogue_revision before insert or update on app.price_list      for each row execute function app.catalogue_revision('price_list');
create trigger catalogue_revision before insert or update on app.price_list_line for each row execute function app.catalogue_revision('price_list_line');
create trigger catalogue_revision before insert or update on app.promotion       for each row execute function app.catalogue_revision('promotion');
create trigger catalogue_revision before insert or update on app.party           for each row execute function app.catalogue_revision('customer');
create trigger catalogue_revision before insert or update on app.tax_code        for each row execute function app.catalogue_revision('tax_code');

comment on column app.item.revision is
  'Catalogue revision, assigned in commit order by app.catalogue_revision() (spec:1299, contracts §4.10.2).';
comment on table app.catalogue_tombstone is
  'One row per archived catalogue row, so a deletion reaches an offline till as a change and not as an absence (spec:1300).';

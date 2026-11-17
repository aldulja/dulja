-- 0066_create_branch_pos_policy.sql — the per-branch POS limit row (§4.6.4; spec:1324).
-- "Limits live in a relational branch_pos_policy row per branch (§4.1: never a blob), maintained under
-- admin.company.manage; sync apply re-verifies against that row, never against the snapshot."

create table app.branch_pos_policy (
  id                       uuid primary key default uuidv7(),
  tenant_id                uuid not null references app.tenant(id),
  company_id               uuid not null,
  branch_id                uuid not null,
  max_line_discount_pct    numeric(9,6) not null default 0,
  max_ticket_discount_pct  numeric(9,6) not null default 0,
  max_void_amount          numeric(19,4) not null default 0,
  max_price_override_pct   numeric(9,6) not null default 0,
  blind_return_allowed     boolean not null default false,
  max_blind_return_amount  numeric(19,4) not null default 0,
  max_cash_in_drawer       numeric(19,4),
  require_customer_over    numeric(19,4),
  rounding_increment       numeric(19,4) not null default 0.05,
  paid_out_allowed         boolean not null default false,          -- ⚠️ OD-10: present and OFF; 6D's till-cash tasks read it
  max_paid_out_amount      numeric(19,4) not null default 0,        -- ⚠️ OD-10
  revision                 bigint not null default 0,               -- catalogue revision (§4.10.2)
  created_at               timestamptz not null default now(),
  -- Every default is the CLOSED position: a branch with no configuration authorises nothing, so a missing
  -- row and a zeroed row refuse identically at sync apply (LEGACY-027 — an invariant is never "off by default").
  constraint branch_pos_policy_pct_range check (
    max_line_discount_pct between 0 and 1 and max_ticket_discount_pct between 0 and 1
    and max_price_override_pct between 0 and 1),
  constraint branch_pos_policy_amount_non_negative check (
    max_void_amount >= 0 and max_blind_return_amount >= 0 and max_paid_out_amount >= 0
    and rounding_increment > 0
    and (max_cash_in_drawer is null or max_cash_in_drawer >= 0)
    and (require_customer_over is null or require_customer_over >= 0)),
  unique (company_id, branch_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.branch_pos_policy');
call app_meta.attach_audit('app.branch_pos_policy');   -- a limit change is exactly the write an auditor asks about

-- down-synced to the terminals of this branch only (stream 'branch_pos_policy'; spec:1312, §4.10.2)
create trigger catalogue_revision before insert or update on app.branch_pos_policy
  for each row execute function app.catalogue_revision('branch_pos_policy');
create index branch_pos_policy_cursor_idx on app.branch_pos_policy (company_id, branch_id, revision);

-- ── the down-sync stream 6A's readCatalogue calls (§4.10.2; 6A:2913) ─────────────────────────────────
-- The twin of 0065's app.pos_cashier_sync, and it ships in the SAME file as its table for the same reason:
-- readCatalogue probes `to_regclass('app.branch_pos_policy')` and executes
--   select ... from app.branch_pos_policy_sync($company, $branch, $since)
-- as soon as that is not null. 6A fixes the signature; this function is the only thing 6C changes when the
-- table's columns settle. There is no `archived_at` and no revocation here: a limit row is edited, never
-- deleted (spec:2049), so this stream has no tombstone and no exclusion.
create function app.branch_pos_policy_sync(p_company_id uuid, p_branch_id uuid, p_since bigint)
returns table (id uuid, revision bigint, "row" jsonb)
language sql stable as $$
  select b.id, b.revision, (to_jsonb(b) - 'tenant_id') || jsonb_build_object(
      'max_line_discount_pct', b.max_line_discount_pct::text,
      'max_ticket_discount_pct', b.max_ticket_discount_pct::text,
      'max_void_amount', b.max_void_amount::text,
      'max_price_override_pct', b.max_price_override_pct::text,
      'max_blind_return_amount', b.max_blind_return_amount::text,
      'max_cash_in_drawer', b.max_cash_in_drawer::text,
      'require_customer_over', b.require_customer_over::text,
      'rounding_increment', b.rounding_increment::text,
      'max_paid_out_amount', b.max_paid_out_amount::text,
      'revision', b.revision::text)
    from app.branch_pos_policy b
   where b.company_id = p_company_id
     and b.branch_id = p_branch_id
     and b.revision > p_since
$$;
grant execute on function app.branch_pos_policy_sync(uuid, uuid, bigint) to app_rw;

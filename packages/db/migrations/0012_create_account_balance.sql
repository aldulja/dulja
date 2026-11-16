-- 0012_create_account_balance.sql — the only projection Phase 1 maintains (contracts §4.3.3; spec:2031).
-- The legacy system's aggregate tables were keyed on less than the grain they aggregated, so two tenants'
-- rows collided (SAH-001) and a concurrent upsert silently lost an amount (SAH-049); its upsert never fired
-- on UPDATE, so re-keying a posting destroyed the balance (SAH-002). The key here IS the grain, the write is
-- one MERGE, and 1B's integrity job rebuilds the table from ledger_entry and compares row for row.

-- ── 1. the projection ─────────────────────────────────────────────────────────────────────────────────
create table app.account_balance (
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  account_id        uuid not null,
  fiscal_period_id  uuid not null,
  currency          char(3) not null,
  debit             numeric(19,4) not null default 0,
  credit            numeric(19,4) not null default 0,
  base_debit        numeric(19,4) not null default 0,
  base_credit       numeric(19,4) not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (company_id, account_id, fiscal_period_id, currency),   -- the full key the MERGE targets (SAH-002/049)
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, account_id)       references app.account(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id),
  -- The seventh currency-code column in the schema, and the first added after 0008 made the other six
  -- composite foreign keys into app.currency. A code with no policy row behind it is an amount whose
  -- rounding is undefined; the refusal belongs in the data layer, not a handler (0008's header).
  foreign key (tenant_id, currency)         references app.currency(tenant_id, code)
);

-- ── 2. isolation ──────────────────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.account_balance');
-- Derived, so no audit trigger: account_balance is already in AUDIT_EXEMPT (plan0A:2706-2709). It joins
-- NO_ID_TABLES in lint-schema.ts (natural key). app_rw keeps select, insert and update through the default
-- privileges of 0001 — the MERGE needs all three — and holds no DELETE: a projection is rebuilt, not trimmed.

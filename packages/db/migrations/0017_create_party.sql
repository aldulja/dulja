-- 0017_create_party.sql — app.party, the entity spec:1169 splits out of the legacy Account's twenty Is*
-- flags (contracts §4.5.7, verbatim). Party is a SINGLE table with one `kind` discriminator (SAH-072: "one
-- discriminator, not 30 booleans"). `student` and `dealer` are reserved so a later module is data, not a
-- migration (F-16). The receivable and payable links are what the posting policy's
-- party.receivable_account / party.payable_account references resolve against (contracts §4.4.1).

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────────
create table app.party (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  kind                   text not null constraint party_kind_check
                           check (kind in ('customer', 'vendor', 'employee', 'student', 'dealer')),
  code                   text not null,
  name_en                text not null,
  name_ar                text,                                     -- bilingual master data as columns, not a blob (spec:2045)
  receivable_account_id  uuid,                                     -- policy path party.receivable_account (contracts §4.4.1)
  payable_account_id     uuid,                                     -- policy path party.payable_account
  currency               char(3),                                  -- statement currency; null means the company's base currency
  tax_registration       text,
  email                  text,
  phone                  text,
  address                jsonb not null default '{}'::jsonb,
  archived_at            timestamptz,                              -- master data is archived, never deleted (spec:2049)
  created_at             timestamptz not null default now(),
  constraint party_company_id_code_key unique (company_id, code),
  unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain `references` would let one tenant's party point at
  -- another tenant's account if the uuid were known (SAH-035, contracts §3.5.1).
  foreign key (tenant_id, company_id)            references app.company(tenant_id, id),
  foreign key (tenant_id, receivable_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, payable_account_id)    references app.account(tenant_id, id)
);

-- ── 2. tenancy and audit (spec:106; contracts §3.5.1) ─────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.party');
call app_meta.attach_audit('app.party');

-- ── 3. the lookups the party API and the posting snapshot make (SAH-070: index what filters) ──────────
create index party_company_kind_idx on app.party (company_id, kind) where archived_at is null;

-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE grant:
-- contracts §3.5.4 pins the DELETE list and 2B is the only slice that extends it.

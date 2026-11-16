-- 0071_create_till_banking_link.sql — ⚠️ OD-10, answered yes on 2026-11-04 (docs/owner/od-10/decision.md).
-- The facts about a TILL_BANKING the reconciliation list reads in one place: which SHIFT the banked cash came
-- from, which bank account it went to, on which value date, and whether the notes left the safe or the
-- drawer. `Reconcilable` (§4.8.3) needs the bank account and value date per banking; the shift is the one
-- the shop needs to act on an unreconciled banking ("1,000 banked from KL01's Tuesday drawer").
-- Contracts amendment A16 registers the row in §4.6.1 and §3.5.3 (no linter-set membership).

create table app.till_banking_link (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  branch_id            uuid not null,
  -- One link per banking document: the document IS the banking, and a second link would be a second
  -- statement about one event.
  banking_document_id  uuid not null,
  shift_id             uuid not null,
  bank_account_id      uuid not null,
  from_safe            boolean not null,
  value_date           date not null,
  amount               numeric(19,4) not null,
  currency             char(3) not null,
  reference            text,
  created_at           timestamptz not null default now(),
  -- A magnitude, never a signed figure: RECONCILABLE_DIRECTION.till_banking = 'in' carries the direction.
  constraint till_banking_link_amount_positive check (amount > 0),
  unique (banking_document_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)          references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)           references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, banking_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, shift_id)            references app.shift(tenant_id, id),
  foreign key (tenant_id, bank_account_id)     references app.account(tenant_id, id)
);

-- The Reconcilable source lists by (company, bank account, value-date range); a shift view reads by shift.
create index till_banking_link_bank_date_idx on app.till_banking_link (company_id, bank_account_id, value_date);
create index till_banking_link_shift_idx     on app.till_banking_link (shift_id);

call app_meta.enable_tenant_rls('app.till_banking_link');
call app_meta.attach_audit('app.till_banking_link');
-- Form A (§4.5.6): a NOT NULL branch key, attached in the table's own migration (§3.5.1 step 7).
create policy branch_isolation on app.till_banking_link as restrictive
  using (app.actor_in_branch(company_id, branch_id));

-- No `attach_stamp`: there is no `*_by` column. The banking's actor is `document.created_by` — the terminal —
-- and its human is `document.attributed_to`; duplicating either here would be a second spelling of one fact.
-- No `forbid_change` trigger: a match is recorded on 4B's `bank_match`, not here (amendment A16).

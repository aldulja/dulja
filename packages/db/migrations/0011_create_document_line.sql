-- 0011_create_document_line.sql — the document line table (contracts §4.3.4; spec:1748 the document header).
-- Phase 1 needs only the columns a JOURNAL uses. Every later slice ADDS nullable or defaulted columns to this
-- same table (2A kind/item/amounts, 3A warehouse/lot/unit, 3D count quantities, 5A the tax-code FK) — expand
-- only, never a rename (spec:2057, contracts §3.4.7).
-- document_line deliberately has NO branch key and never gains one (contracts §3.5.1 item 7, §4.5.6): it is
-- branch-isolated through its parent document, so 6C's branch_isolation_policy rule does not name it.

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────────
create table app.document_line (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  document_id    uuid not null,
  line_no        int not null check (line_no > 0),
  description    text,
  account_id     uuid,                                   -- 'account' lines (JOURNAL); item lines resolve accounts through the policy
  debit          numeric(19,4) not null default 0 check (debit >= 0),     -- document currency (spec:2041)
  credit         numeric(19,4) not null default 0 check (credit >= 0),
  dimensions     jsonb not null default '{}'::jsonb,     -- {"<dimension_type.code>": "<dimension_value.id>"}; BRANCH is never here — it is document.branch_id
  custom_fields  jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  check (not (debit > 0 and credit > 0)),                -- one side per line, exactly as ledger_entry (spec:1815)
  unique (document_id, line_no),
  unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain references would let tenant A's line point at
  -- tenant B's account if the uuid were known (LEGACY-035, spec:1820).
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id) on delete cascade,
  foreign key (tenant_id, account_id)  references app.account(tenant_id, id)
);

-- ── 2. isolation and audit ────────────────────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.document_line');
call app_meta.attach_audit('app.document_line');          -- before/after images of every draft edit (spec:106)

-- app_rw receives select, insert, update through the default privileges of migration 0001 (plan0A:2564).
-- No DELETE: the cascade from document runs with the table owner's rights, and 2B's migration 0023 is the
-- one slice that grants app_rw DELETE here, guarded by document_delete_draft_only (contracts §3.5.4).
-- No extra index: `unique (document_id, line_no)` already backs every lookup by document (LEGACY-070).

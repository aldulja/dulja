-- 0054_create_tax_transaction_return_and_document_tax_inclusive.sql
-- Contracts §4.9.2 (tax_transaction, tax_return) and §4.3.4's 5A row (document.tax_inclusive).
-- The file name states all three because §3.4.2 requires it (amendment A1; 2A's 0018_… is the precedent).
--
-- SAH-011 (VAT half): procCalculateVATReturn accumulated without coalesce, so ONE bill line with a NULL
-- base nulled Output_Total for the whole period while Output_Tax still reported a figure — a return filed
-- with tax and no base. Here all four monetary columns are NOT NULL with no default, so a tax without a
-- base is not representable. SAH-059: the return reads THIS table with both period bounds always bound
-- (packages/db/src/tax/returns.ts), never a concatenated query that can lose its date filter.

-- ── 1. tax_transaction — one row per posted tax line, written ONLY by the posting service at step 11 ───
create table app.tax_transaction (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  document_id       uuid not null,
  line_no           int not null check (line_no > 0),           -- the SOURCE document_line.line_no
  tax_code_id       uuid not null,
  regime_id         uuid not null,                              -- denormalised from the code: the code may be
                                                                -- archived later; a filed return must not move
  base              numeric(19,4) not null,                     -- document currency, SIGNED (a credit note is
  tax               numeric(19,4) not null,                     -- genuinely negative tax — §4.4.2 A9's exception)
  base_base         numeric(19,4) not null,                     -- company base currency, via toBase
  tax_base          numeric(19,4) not null,
  effective_date    date not null,                              -- the ACCOUNTING date, never posted_at (spec:2039)
  fiscal_period_id  uuid not null,
  posting_seq       bigint not null,                            -- §4.3.5; assigned at §4.3.2 step 8
  created_at        timestamptz not null default now(),
  unique (document_id, line_no, tax_code_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_id)      references app.document(tenant_id, id),
  foreign key (tenant_id, tax_code_id)      references app.tax_code(tenant_id, id),
  foreign key (tenant_id, regime_id)        references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_transaction');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3). The table is append-only, so an audit copy is a second copy of
-- the same rows; correction is a reversing document, which writes its own negative rows (SAH-041).
create trigger tax_transaction_immutable before update or delete on app.tax_transaction
  for each row execute function app.forbid_change();
revoke update, delete on app.tax_transaction from app_rw;
create index tax_transaction_period_idx
  on app.tax_transaction (company_id, regime_id, effective_date);   -- the return's one read path

-- ── 2. tax_return ─────────────────────────────────────────────────────────────────────────────────────
create table app.tax_return (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  regime_id       uuid not null,                                -- SAH-020: a return NAMES its regime
  period_start    date not null,
  period_end      date not null check (period_end >= period_start),
  status          text not null default 'draft',
  payload         text,                                          -- the canonical JSON the pack produced
  payload_sha256  bytea,                                         -- sha256(payload); test 26's byte-identity
  -- SINGLE-column reference, exactly as plan0A:1474 `closed_by`, plan0A:1794 `posted_by`, 4A's
  -- `unallocated_by` and 4B's `unmatched_by`. `app.principal` is GLOBAL (§3.5.3, §3.6.1) and carries no
  -- `unique (tenant_id, id)`, so a composite `(tenant_id, generated_by)` key has nothing to point at and
  -- PostgreSQL refuses the DDL outright: "number of referencing and referenced columns for foreign key
  -- disagree". §3.5.1's composite rule is about tenant-SCOPED parents; a global parent is the exception
  -- every earlier slice already takes.
  generated_by    uuid references app.principal(id),             -- NULL until generated; stamped then (SAH-044)
  filed_at        timestamptz,                                   -- written by 5B under accounting.tax.file
  attachment_id   uuid,                                          -- 5B or the print path; NULL in 5A
  created_at      timestamptz not null default now(),
  constraint tax_return_status_check check (status in ('draft', 'generated', 'filed')),
  -- A generated return has both halves or neither: the SAH-011 shape applied to the return row itself.
  constraint tax_return_payload_pair_check
    check ((payload is null) = (payload_sha256 is null)),
  constraint tax_return_generated_has_payload_check
    check (status = 'draft' or (payload is not null and generated_by is not null)),
  unique (company_id, regime_id, period_start),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)    references app.company(tenant_id, id),
  foreign key (tenant_id, regime_id)     references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, attachment_id) references app.attachment(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_return');
call app_meta.attach_audit('app.tax_return');
call app_meta.attach_stamp('app.tax_return', 'generated_by');   -- NULL while draft; stamped at generation

-- ── 3. document.tax_inclusive (§4.3.4's 5A row) ───────────────────────────────────────────────────────
-- §4.4.1's tax.inclusive may be the literal "header.tax_inclusive", which every 4A invoice policy already
-- names (phase-4a:2762). Documents posted in Phases 1-4 read false, which is what they were computed as.
alter table app.document add column tax_inclusive boolean not null default false;
comment on column app.document.tax_inclusive is
  'Line amounts include tax when true. Resolved by policy.tax.inclusive = "header.tax_inclusive" (§4.4.1).';

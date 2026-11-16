-- ── 0026 · app.print_template ─────────────────────────────────────────────────────────────────────
-- spec:1240 — the one thing kept from the legacy report designer: "text-defined, diffable,
-- version-controlled" templates. Contracts §4.5.9 fixes these columns.
-- `engine` holds a Code from ADR 0016's Decision (0E): the chosen engine is Chromium print-to-PDF and
-- "the closed value set of app.print_template.engine is {chromium}". The decision is made once, there;
-- this CHECK is its vocabulary, and no later slice re-evaluates engines (contracts hazard 30). Admitting
-- a second engine is a later migration widening this CHECK, plus its adapter (ADR 0016 Consequences).

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────
create table app.print_template (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  document_type_id  uuid not null,
  code              text not null,
  version           int  not null check (version > 0),
  name_en           text not null,
  name_ar           text,
  engine            text not null check (engine in ('chromium')),                            -- ADR 0016
  source            text not null,                    -- the template text: front matter + body (ADR 0032)
  paper             text not null default 'A4' check (paper in ('A4', 'A5', 'receipt')),  -- matches §4.11.1 layout.paper
  created_at        timestamptz not null default now(),
  unique (document_type_id, code, version),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);

-- ── 2. resolution ─────────────────────────────────────────────────────────────────────────────────
-- the print endpoint resolves "the highest version of <code> for this type in this company".
create index print_template_resolve_idx on app.print_template (company_id, document_type_id, code, version desc);

-- ── 3. tenancy and audit (spec:106, §3.3; the §4.5.9 snippet omits these two calls) ──────────────
call app_meta.enable_tenant_rls('app.print_template');
call app_meta.attach_audit('app.print_template');

-- No *_by column, so no attach_stamp. No DELETE grant and no archived_at: a template version is
-- superseded by a higher `version`, never removed (spec:2049; §3.5.4 is unchanged by this slice).

-- 0053_create_tax_regime_code.sql
-- Contracts §4.9.2 (tax_regime, tax_code) plus amendment A2 (tax_regime.source).
--
-- LEGACY-020: procCalculateVATReturn and procCalculateGSTReturn read the SAME TaxCodes.Kind column with
-- incompatible meanings (1 = standard-rated output vs 1 = TX input) and nothing said which regime a code
-- belonged to, so a VAT tenant running the GST return reported sales as purchases with no warning. Here
-- every code carries regime_id NOT NULL, a regime is versioned and effective-dated, and a return names the
-- regime it was built for (0054). LEGACY-019: the rounding rule is a column ON THE CODE, applied by the one
-- rounding function at persist time (spec:2228, ADR 0050) rather than configured in ten columns nothing reads.

-- ── 1. tax_regime ─────────────────────────────────────────────────────────────────────────────────────
create table app.tax_regime (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  code            text not null,                                   -- 'SYNTH-MY-v1' until OD-15 (hazard 2)
  jurisdiction    char(2) not null,                                -- ISO 3166-1 alpha-2; 'MY' for v1 (D21)
  version         int not null check (version > 0),                 -- spec:2227 "versioned regimes"
  effective_from  date not null,
  effective_to    date,
  name_en         text not null,
  name_ar         text,
  source          text not null,                                    -- A2: where the rates and boxes came from
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (company_id, code, version),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_regime');
call app_meta.attach_audit('app.tax_regime');
comment on column app.tax_regime.source is
  'Provenance of this regime version: the publication or seed file its rates and boxes came from. LEGACY-020.';

-- ── 2. tax_code ───────────────────────────────────────────────────────────────────────────────────────
create table app.tax_code (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  regime_id          uuid not null,                                 -- LEGACY-020: the discriminator, never null
  code               text not null,
  name_en            text not null,
  name_ar            text,
  rate               numeric(19,8) not null check (rate >= 0),      -- decimal fraction: 0.11000000 is 11%
  kind               text not null,
  rounding_mode      text not null default 'HALF_AWAY_FROM_ZERO',   -- spec:2228, LEGACY-019
  output_account_id  uuid,                                          -- §4.15 2300; §4.4.1 tax_code.output_account
  input_account_id   uuid,                                          -- §4.15 1350; §4.4.1 tax_code.input_account
  effective_from     date not null,
  effective_to       date,
  archived_at        timestamptz,                                   -- spec:2049: master data is archived
  created_at         timestamptz not null default now(),
  constraint tax_code_kind_check
    check (kind in ('output', 'input', 'exempt', 'zero', 'out_of_scope')),
  constraint tax_code_rounding_mode_check
    check (rounding_mode in ('HALF_AWAY_FROM_ZERO', 'HALF_EVEN', 'TOWARD_ZERO', 'AWAY_FROM_ZERO')),
  -- An output code needs an output account and an input code an input account, or postDocument would
  -- resolve tax_code.output_account to null at post (§4.4.1) instead of failing at configuration time.
  constraint tax_code_account_for_kind_check
    check ((kind <> 'output' or output_account_id is not null)
       and (kind <> 'input'  or input_account_id  is not null)),
  check (effective_to is null or effective_to >= effective_from),
  unique (company_id, code, effective_from),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, regime_id)         references app.tax_regime(tenant_id, id),
  foreign key (tenant_id, output_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, input_account_id)  references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.tax_code');
call app_meta.attach_audit('app.tax_code');
create index tax_code_regime_idx on app.tax_code (regime_id, effective_from desc);
-- app_rw receives select, insert, update through default privileges (plan0A:2564); no DELETE (§3.5.4).

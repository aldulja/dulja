-- 0092_create_employee_ytd.sql
-- §3.10.1 Year-to-date (spec:2084): "employee_ytd (per employee per tax year) is a projection rebuilt from
-- posted lines nightly and compared (D14); employee_ytd_opening rows are loaded at cut-over so a mid-year
-- switch computes PCB correctly (Phase 9)."
-- contracts §4.12.8 (round 18 B6, B7, B14): MERGE'd by the PAYROLL posting at §4.3.2 step 12, alongside
-- account_balance and stock_on_hand. spec:1978 groups it with account_balance/cost_layer and spec:98 forbids
-- writing such a table outside the posting service — enforced by `posting-only-tables` (§3.7.5).
-- Everything 0092 will ever contain is in this one file: a migration is written once and never edited after it
-- has run (§3.4.7), so the two jsonb helpers the MERGE uses and the two aggregates the rebuild uses are here too.

-- ── 1. the projection ───────────────────────────────────────────────────────────────────────────────
create table app.employee_ytd (
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  employee_id   uuid not null,
  tax_year      smallint not null,
  gross         numeric(19,4) not null default 0,
  net           numeric(19,4) not null default 0,
  by_component  jsonb not null default '{}'::jsonb,   -- {"<pay_component.code>": "<amount>"}
  by_scheme     jsonb not null default '{}'::jsonb,   -- {"<statutory_scheme.code>": {"employee": "…", "employer": "…"}}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (company_id, employee_id, tax_year),
  constraint employee_ytd_tax_year_check check (tax_year between 2000 and 2200),
  constraint employee_ytd_by_component_check check (jsonb_typeof(by_component) = 'object'),
  constraint employee_ytd_by_scheme_check check (jsonb_typeof(by_scheme) = 'object'),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);
comment on table app.employee_ytd is
  'contracts §4.12.8 — a POSTING-SERVICE projection of posted PAYROLL deltas. Written only by postDocument step 12; the nightly hr.employee_ytd.rebuild compares and never writes (spec:98).';
comment on column app.employee_ytd.tax_year is
  'round 18 B7 — the calendar year of payroll_run.pay_date. A convention 8C fixes and OD-23 confirms; NOT a statutory claim.';

call app_meta.enable_tenant_rls('app.employee_ytd');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3), like account_balance and stock_on_hand — a derived row whose
-- before/after image is a second copy of a figure the ledger already carries.

-- ── 2. the cut-over openings 9B loads (spec:2084) ───────────────────────────────────────────────────
-- NOT audit-exempt and NOT posting-service-only: a LOADED figure with a provenance. It is never merged into
-- app.employee_ytd (B14); a YTD reading adds it at read time (`ytdFromEmployeeYtd`).
create table app.employee_ytd_opening (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  employee_id   uuid not null,
  tax_year      smallint not null,
  gross         numeric(19,4) not null default 0,
  net           numeric(19,4) not null default 0,
  by_component  jsonb not null default '{}'::jsonb,
  by_scheme     jsonb not null default '{}'::jsonb,
  source        text not null,                        -- 'legacy:<run>' (9B) or 'manual:<reason>'
  loaded_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at    timestamptz not null default now(),
  constraint employee_ytd_opening_tax_year_check check (tax_year between 2000 and 2200),
  constraint employee_ytd_opening_source_check check (length(source) between 1 and 200),
  constraint employee_ytd_opening_by_component_check check (jsonb_typeof(by_component) = 'object'),
  constraint employee_ytd_opening_by_scheme_check check (jsonb_typeof(by_scheme) = 'object'),
  constraint employee_ytd_opening_natural_key unique (company_id, employee_id, tax_year),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);
comment on table app.employee_ytd_opening is
  'spec:2084 — the cut-over figures a mid-year switch starts from. Loaded by 9B''s importer through upsertEmployeeYtdOpening; audited, because a loaded figure has a provenance. Added at READ time, never merged into employee_ytd (round 18 B14).';

call app_meta.enable_tenant_rls('app.employee_ytd_opening');
call app_meta.attach_audit('app.employee_ytd_opening');
call app_meta.attach_stamp('app.employee_ytd_opening', 'loaded_by');

create index employee_ytd_company_year_idx on app.employee_ytd (company_id, tax_year);
create index employee_ytd_opening_company_year_idx on app.employee_ytd_opening (company_id, tax_year);

-- ── 3. THE one aggregation (round 18 B6) ────────────────────────────────────────────────────────────
-- Consumed by §4.3.2 step 12's MERGE and by the nightly rebuild. One function, two callers: two hand-written
-- jsonb aggregations would differ on numeric text formatting the first time a share ended in a trailing zero,
-- and "employee_ytd rebuilds bit-identically" (the Phase 8 DoD) would be false.
--
-- jsonb values are fixed-scale STRINGS (`to_char(…, 'FM999999999999990.0000')`, fifteen integer positions — the
-- range of numeric(19,4); a narrower mask renders `#`s silently): jsonb stores a numeric by Postgres's own rules,
-- so 100.0000 and 100.00 would be the same value written two ways. The same discipline as `Money.toString()`.
--
-- **The sign convention.** `payroll_line.amount` is a MAGNITUDE (8B constrains it >= 0, §4.4.2 A9), so no
-- measure infers a direction from it. `net` is SIGNED, and the sign comes from the source line's own
-- `document_line.credit - document_line.debit` over the run's `kind = 'account'` lines: 8B's rule 6 credits the
-- net-pay line and its rule 7 debits one, so a correction that carries a debit net moves `net` DOWN (ADR 0077
-- decision 5). `gross`, `by_component` and `by_scheme` stay MAGNITUDES: a `kind = 'payroll'` line carries no
-- debit/credit in 8B's model, so there is no direction to read.
--
-- **The status predicate admits `issued` as well as `posted`.** §4.3.2 fixes the order: step 7 issues, step 12
-- MERGEs, step 13 writes `posted`, so a function demanding `posted` would return nothing every time step 12
-- called it. A draft, submitted or approved run contributes nothing ("generated from posted lines only",
-- spec:2083), which keeps step 12 safe to call unconditionally; the REBUILD narrows to `posted` in its own
-- document list. A document with no payroll_run row returns zero rows and never scans payroll_line.
create function app.employee_ytd_delta(p_document_id uuid)
returns table (
  company_id   uuid,
  employee_id  uuid,
  tax_year     smallint,
  gross        numeric(19,4),
  net          numeric(19,4),
  by_component jsonb,
  by_scheme    jsonb
)
language sql stable as $$
  with run as (
    select r.company_id, extract(year from r.pay_date)::smallint as tax_year
      from app.payroll_run r
      join app.document d on d.id = r.document_id
     where r.document_id = p_document_id
       and d.status in ('issued', 'posted')
  ),
  line as (
    select pl.employee_id, pl.amount, pl.share,
           dl.debit, dl.credit,                    -- the DIRECTION of an `account` line; see the sign note above
           pc.code as component_code, pc.kind as component_kind,
           ss.code as scheme_code, dl.kind as line_kind
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      left join app.pay_component    pc on pc.id = pl.component_id
      left join app.statutory_scheme ss on ss.id = pl.scheme_id
     where dl.document_id = p_document_id
       and exists (select 1 from run)
  ),
  per_employee as (
    select l.employee_id,
           -- Gross is the sum of EARNING components. A deduction reduces net, never gross; an employer share is
           -- the employer's cost and is in neither (spec:2101).
           coalesce(sum(l.amount) filter (where l.component_kind = 'earning'), 0)::numeric(19,4) as gross,
           -- Net is read off the net-pay `account` line, so this projection and the ledger cannot disagree.
           coalesce(sum(l.credit - l.debit) filter (where l.line_kind = 'account'), 0)::numeric(19,4) as net
      from line l
     group by l.employee_id
  ),
  -- TWO stages: `jsonb_object_agg(k, sum(v))` nests aggregates (42803). A component may appear on more than one
  -- line of one run for one employee, so it is summed per (employee, component) first.
  per_component as (
    select l.employee_id, l.component_code, sum(l.amount) as amount
      from line l
     where l.component_code is not null
     group by l.employee_id, l.component_code
  ),
  components_rolled as (
    select c.employee_id,
           jsonb_object_agg(c.component_code, to_char(c.amount, 'FM999999999999990.0000')) as by_component
      from per_component c
     group by c.employee_id
  ),
  schemes as (
    select l.employee_id, l.scheme_code,
           to_char(coalesce(sum(l.amount) filter (where l.share = 'employee'), 0), 'FM999999999999990.0000') as employee_share,
           to_char(coalesce(sum(l.amount) filter (where l.share = 'employer'), 0), 'FM999999999999990.0000') as employer_share
      from line l
     where l.scheme_code is not null
     group by l.employee_id, l.scheme_code
  ),
  schemes_rolled as (
    select s.employee_id,
           jsonb_object_agg(s.scheme_code,
             jsonb_build_object('employee', s.employee_share, 'employer', s.employer_share)) as by_scheme
      from schemes s
     group by s.employee_id
  )
  select r.company_id, p.employee_id, r.tax_year, p.gross, p.net,
         coalesce(cr.by_component, '{}'::jsonb), coalesce(sr.by_scheme, '{}'::jsonb)
    from per_employee p
    cross join run r
    left join components_rolled cr on cr.employee_id = p.employee_id
    left join schemes_rolled    sr on sr.employee_id = p.employee_id
$$;
grant execute on function app.employee_ytd_delta(uuid) to app_rw;

-- ── 4. jsonb money arithmetic — the two binary helpers the step-12 MERGE uses ───────────────────────
-- `||` would REPLACE a key rather than add to it, so a February run would overwrite January's BASIC. These add,
-- keeping the fixed-scale string form app.employee_ytd_delta produces so the projection and its rebuild compare
-- byte for byte. `#>> '{}'` renders a scalar jsonb as text (`->>` reads a FIELD and would return NULL here).
-- `stable`, not `immutable`: `to_char(numeric, text)` is STABLE (it reads lc_numeric), and a function is never
-- more stable than what it calls.
create function app.jsonb_add_money(a jsonb, b jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k, to_char(v, 'FM999999999999990.0000')), '{}'::jsonb)
    from (
      select k, sum(v) as v
        from (
          select key as k, (value #>> '{}')::numeric as v from jsonb_each(coalesce(a, '{}'::jsonb))
          union all
          select key as k, (value #>> '{}')::numeric as v from jsonb_each(coalesce(b, '{}'::jsonb))
        ) parts
       group by k
    ) summed
$$;

create function app.jsonb_add_scheme(a jsonb, b jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object(
           'employee', to_char(e, 'FM999999999999990.0000'),
           'employer', to_char(r, 'FM999999999999990.0000'))), '{}'::jsonb)
    from (
      select k, coalesce(sum(e), 0) as e, coalesce(sum(r), 0) as r
        from (
          select key as k, (value ->> 'employee')::numeric as e, (value ->> 'employer')::numeric as r
            from jsonb_each(coalesce(a, '{}'::jsonb))
          union all
          select key as k, (value ->> 'employee')::numeric as e, (value ->> 'employer')::numeric as r
            from jsonb_each(coalesce(b, '{}'::jsonb))
        ) parts
       group by k
    ) summed
$$;
grant execute on function app.jsonb_add_money(jsonb, jsonb) to app_rw;
grant execute on function app.jsonb_add_scheme(jsonb, jsonb) to app_rw;

-- ── 5. the AGGREGATE forms the rebuild folds a whole year's deltas with ──────────────────────────────
-- Built from the very functions the MERGE uses, which is what keeps the maintained and rebuilt objects
-- byte-identical.
create aggregate app.jsonb_add_money_agg(jsonb) (
  sfunc = app.jsonb_add_money, stype = jsonb, initcond = '{}'
);
create aggregate app.jsonb_add_scheme_agg(jsonb) (
  sfunc = app.jsonb_add_scheme, stype = jsonb, initcond = '{}'
);
grant execute on function app.jsonb_add_money_agg(jsonb) to app_rw;
grant execute on function app.jsonb_add_scheme_agg(jsonb) to app_rw;

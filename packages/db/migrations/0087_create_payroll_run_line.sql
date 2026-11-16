-- 0087_create_payroll_run_line.sql
-- §3.10.1 "Payroll run" (spec:2081): a run is a Document of type PAYROLL using the document state machine, not
-- its own. These two tables are 1:1 EXTENSIONS — the header lives in app.document and the amounts live in
-- app.document_line; nothing here duplicates a column those tables already own.
-- Contracts §4.12.6 (columns), §3.5.3 (both tables join the no-id set), round 17 A5 (the two guards).

-- ── 1. document_line.kind — the FULL union, both phases' labels (§4.3.4) ──────────────────────────────
-- 6A's 0061 writes the identical list and, in this tree, has already run (round 17 A17 item 1). Phase 8 may
-- execute before or after Phase 6 (spec:2301), so a file listing only "the labels admitted so far" would drop
-- the other phase's label when it ran second. The constraint is dropped BY NAME because 2A named it
-- explicitly for exactly this reason, and re-adding the identical list is a no-op on the schema.
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text','tender','payroll'));

-- ── 2. app.payroll_run — the 1:1 header extension ────────────────────────────────────────────────────
create table app.payroll_run (
  -- The PK and NOTHING else. A plain `references app.document(id)` would be a `composite_fk` violation: an FK
  -- check bypasses RLS, so a single-column reference to a tenant-scoped parent lets tenant A's row point at
  -- tenant B's document. The tenant-safe reference and the cascade are the composite FK further down.
  document_id     uuid primary key,
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  kind            text not null check (kind in ('regular','supplementary','final')),   -- spec:2081
  period_start    date not null,
  period_end      date not null,
  pay_date        date not null,
  -- SAH-013: what was ORIGINALLY applied. [{ "schemeId": uuid, "version": int }], written by the run service
  -- from the pure calculator's `pinnedTables` and never re-read from statutory_rate_table afterwards.
  pinned_tables   jsonb not null default '[]'::jsonb,
  calculated_at   timestamptz not null default now(),
  calculated_by   uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at      timestamptz not null default now(),
  check (period_end >= period_start),
  check (pay_date >= period_start),
  check (jsonb_typeof(pinned_tables) = 'array'),
  unique (tenant_id, document_id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id) on delete cascade
);
comment on table app.payroll_run is
  'spec:2081 — a payroll run is a PAYROLL document; this row carries the pay period, the run kind and the pinned rate-table versions (SAH-013).';
call app_meta.enable_tenant_rls('app.payroll_run');
call app_meta.attach_audit('app.payroll_run', 'tenant_column', 'document_id');
call app_meta.attach_stamp('app.payroll_run', 'calculated_by');

create index payroll_run_period_idx on app.payroll_run (company_id, period_start, period_end);

-- ── 3. app.payroll_line — the 1:1 line extension ─────────────────────────────────────────────────────
create table app.payroll_line (
  -- The PK and nothing else, for the `composite_fk` reason stated on payroll_run above.
  document_line_id  uuid primary key,
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  employee_id       uuid not null,
  component_id      uuid,                        -- a pay_component line (earning or deduction)
  scheme_id         uuid,                        -- a statutory line
  share             text check (share in ('employee','employer')),
  quantity          numeric(19,6),               -- days for a quantity-based component (unpaid leave)
  -- A MAGNITUDE. §4.4.2 amendment A9 makes `side` the sole carrier of direction for a planned ledger line,
  -- and the policy's rules choose the side; a negative amount here would post a deduction as an earning.
  amount            numeric(19,4) not null,
  rate_table_id     uuid,                        -- SAH-013: the version this line pinned
  rate_table_version int,
  override_reason   text,                        -- spec:2087 — a manual statutory override, never silent
  -- Stamped (app.stamp_actor overwrites any supplied value with the session actor); null unless
  -- override_reason is set. The employee the line is ABOUT is employee_id, never a *_by column (SAH-044).
  entered_by        uuid references app.principal(id),
  created_at        timestamptz not null default now(),
  constraint payroll_line_amount_check check (amount >= 0),
  -- The three shapes the PAYROLL policy's `when` filters select, made mutually exclusive so no line can match
  -- two rules (round 17 A5). Component line: component_id only. Statutory line: scheme_id + share. Net-pay or
  -- advance line: neither, and the policy reaches it through `when: { "line.kind": "account" }`.
  constraint payroll_line_shape_check check (
       (component_id is not null and scheme_id is null and share is null)
    or (component_id is null and scheme_id is not null and share is not null)
    or (component_id is null and scheme_id is null and share is null)),
  -- spec:2087 — an override carries a reason AND the principal who entered it, or neither.
  constraint payroll_line_override_check check (
    (override_reason is null and entered_by is null) or (override_reason is not null and entered_by is not null)),
  unique (tenant_id, document_line_id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, document_line_id)  references app.document_line(tenant_id, id) on delete cascade,
  foreign key (tenant_id, employee_id)       references app.employee(tenant_id, id),
  foreign key (tenant_id, component_id)      references app.pay_component(tenant_id, id),
  foreign key (tenant_id, scheme_id)         references app.statutory_scheme(tenant_id, id),
  foreign key (tenant_id, rate_table_id)     references app.statutory_rate_table(tenant_id, id)
);
comment on table app.payroll_line is
  'spec:2081 — one row per employee per component or scheme share, pinning the rate-table version it used (SAH-013).';
call app_meta.enable_tenant_rls('app.payroll_line');
call app_meta.attach_audit('app.payroll_line', 'tenant_column', 'document_line_id');
call app_meta.attach_stamp('app.payroll_line', 'entered_by');

create index payroll_line_employee_idx on app.payroll_line (company_id, employee_id);
create index payroll_line_scheme_idx   on app.payroll_line (company_id, scheme_id);

-- ── 4. Period lock reaches the LINES (spec:2105, SAH-031) ────────────────────────────────────────────
-- SAH-031 is verbatim "Period locks … do not reach the line items". `assert_period_open` guards ledger_entry
-- and `document_line_delete_draft_only` (2B, 0023) guards document_line, but app.payroll_line is a table those
-- two have never heard of — and it carries every figure a payslip and a statutory schedule are generated from.
-- The guard is the same shape as 2B's app.forbid_line_delete_unless_draft and raises the same token.
-- The predicate is 2B's: `s is not null and s <> 'draft'`, NOT `s is distinct from 'draft'`. During the ON
-- DELETE CASCADE from document_line the parent row is ALREADY GONE — the RI cascade runs as an AFTER trigger
-- on the parent and issues its child DELETE with the parent's removal visible — so the SELECT below finds
-- nothing and `s` is NULL. `is distinct from` would treat that NULL as "not draft" and refuse every legitimate
-- recalculation of a draft run. The guard refuses only when a NON-DRAFT parent is still visible, which is the
-- direct `update`/`delete` case it exists for.
create function app.forbid_payroll_line_change_unless_draft() returns trigger language plpgsql as $$
declare
  s app.document_status;
begin
  select d.status into s
    from app.document d join app.document_line l on l.document_id = d.id
   where l.id = coalesce(new.document_line_id, old.document_line_id);
  if s is not null and s <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: payroll line % belongs to a document that is %; a posted run is corrected by a supplementary run, never edited in place (spec:2081, SAH-041)',
      coalesce(new.document_line_id, old.document_line_id), s
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger payroll_line_change_draft_only
  before update or delete on app.payroll_line
  for each row execute function app.forbid_payroll_line_change_unless_draft();

-- ── 5. Privileges ────────────────────────────────────────────────────────────────────────────────────
-- app_rw receives select, insert, update through default privileges — §3.5.1 item 6 says NO GRANT STATEMENT,
-- and this file issues none. DELETE is granted only per §3.5.4, whose list is closed — so payroll_line rows are
-- removed ONLY by the CASCADE from document_line when a draft's lines are replaced, which the draft-only
-- trigger above admits because the parent row is already gone by the time it runs.

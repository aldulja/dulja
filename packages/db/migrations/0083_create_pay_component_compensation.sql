-- ── 0083_create_pay_component_compensation.sql ─────────────────────────────────────────────────
-- §3.10.1 "Pay components" and "Compensation lines" (spec:2078-2079). Three tables:
--   pay_component        — a typed catalogue, kind is TWO-valued and never three (§4.6.1)
--   pay_component_scheme — the join that replaces "subject to X" booleans (RC-3, spec:2078)
--   compensation_line    — effective-dated; the history IS the closed rows (ADR 0072)
-- The account columns are NULLABLE: 8B seeds the payroll accounts and sets them (§4.12.2, §4.15,
-- 8A amendment A2). This slice writes no account code (hazard 33).

create table app.pay_component (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  company_id         uuid not null,
  code               text not null check (length(code) between 1 and 40),
  name_en            text not null,
  name_ar            text,
  kind               text not null,
  expense_account_id uuid,                             -- 8B: the payroll expense account (§4.15)
  payable_account_id uuid,                             -- 8B: net pay payable, or the advance-recovery asset
  quantity_based     boolean not null default false,   -- days x daily rate (spec:2078 "unpaid-leave deduction")
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  constraint pay_component_kind_check check (kind in ('earning', 'deduction')),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  foreign key (tenant_id, expense_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, payable_account_id) references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pay_component');
call app_meta.attach_audit('app.pay_component');

comment on constraint pay_component_kind_check on app.pay_component is
  'spec:2079 and §4.6.1: exactly earning | deduction. An EMPLOYER contribution is the employer share of a statutory_scheme, selected in the PAYROLL policy by when: { "line.share": "employer" } and posted from statutory_scheme.employer_expense_account_id -- never a third kind here.';

-- The join table: no id, no created_at (§3.5.3 NO_ID_TABLES). Applicability is DATA, not a boolean.
create table app.pay_component_scheme (
  tenant_id    uuid not null references app.tenant(id),
  component_id uuid not null,
  scheme_id    uuid not null,                    -- app.statutory_scheme arrives in migration 0084 (A13)
  primary key (component_id, scheme_id),
  -- Global Constraint 8's `unique (tenant_id, <pk>)` form for a NO_ID_TABLES member (§3.5.3), the same
  -- shape employee_sensitive's `unique (tenant_id, employee_id)` takes.
  unique (tenant_id, component_id, scheme_id),
  foreign key (tenant_id, component_id) references app.pay_component(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pay_component_scheme');
-- NO SPACE after the comma: app.audit_row() splits key_cols on ',' and reads `rec ->> k` per element, so
-- 'component_id, scheme_id' would make the second key ' scheme_id', NULL, and silently dropped.
call app_meta.attach_audit('app.pay_component_scheme', 'tenant_column', 'component_id,scheme_id');
comment on table app.pay_component_scheme is
  'spec:2078 RC-3: "no subject to X booleans". The scheme FK is added by migration 0084, which creates app.statutory_scheme; ordering, not an omission. Rows arrive with OD-23: which components a scheme applies to is a STATUTORY claim and this repository states none (spec:2080).';

create table app.compensation_line (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  employee_id    uuid not null,
  component_id   uuid not null,
  effective_from date not null,
  effective_to   date,
  amount         numeric(19,4),
  quantity       numeric(19,6),
  entered_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check (amount is not null or quantity is not null),
  foreign key (tenant_id, employee_id)  references app.employee(tenant_id, id),
  foreign key (tenant_id, component_id) references app.pay_component(tenant_id, id)
);

-- At most one OPEN line per (employee, component). A raise is a new row; the old one is closed (ADR 0072).
create unique index compensation_line_open_idx
  on app.compensation_line (employee_id, component_id) where effective_to is null;
create index compensation_line_period_idx
  on app.compensation_line (employee_id, effective_from, effective_to);

call app_meta.enable_tenant_rls('app.compensation_line');
call app_meta.attach_audit('app.compensation_line');
call app_meta.attach_stamp('app.compensation_line', 'entered_by');

-- The compensation gate (spec:2450, test 32): RESTRICTIVE, no `with check`, the same shape as 0082's.
create policy compensation_gate on app.compensation_line as restrictive
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

-- R4 (spec:2175): nobody writes their own compensation.
create trigger compensation_line_no_self_pay
  before insert or update on app.compensation_line
  for each row execute function app.forbid_self_pay('employee_id');

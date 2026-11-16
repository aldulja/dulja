-- 0088_create_employee_dimension.sql
-- §4.12.7 and spec:2101: "Every line carries BRANCH … and EMPLOYEE (one dimension value per employee), so
-- branch staff cost and per-employee payables are ledger projections." Contracts round 17, A2 (the file name).
--
-- WHY A TRIGGER AND NOT A SERVICE CALL (ADR 0075): the employee master has three writers — 6C's cashier
-- onboarding, 8A's HR screens and 9B's importer — and spec:2101 wants the dimension value to exist for EVERY
-- employee, not for the ones a particular path remembered. A trigger is the only place all three meet.
--
-- WHY NO BACKFILL: FORCE ROW LEVEL SECURITY binds app_migrator (spec:1366), so this file sees zero tenants and
-- cannot write a per-tenant row (hazard 10). Employees inserted before this migration are repaired by
-- app.ensure_employee_dimension_value / ensureEmployeeDimensionValue, which the run service calls per employee.
-- That is a completeness gap closed at first use, never a silent missing dimension: the PAYROLL policy declares
-- `dimensions.required: ["BRANCH","EMPLOYEE"]`, so a line without one refuses at post with
-- ERR_POLICY_REQUIRES_MISSING rather than posting untagged.
--
-- Neither function is SECURITY DEFINER: each runs as its caller, under its caller's RLS. The trigger's caller is
-- whoever inserted the employee, and 6C's branch_isolation on app.employee is a RESTRICTIVE policy whose USING
-- clause also checks the insert — so the inserting actor can always read the row it just wrote.

-- ── 1. the resolver, shared by the trigger and by the repair path ─────────────────────────────────────
create function app.ensure_employee_dimension_type(p_company_id uuid) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from app.dimension_type where company_id = p_company_id and code = 'EMPLOYEE';
  if v_id is null then
    insert into app.dimension_type (tenant_id, company_id, code, name_en, name_ar)
    select c.tenant_id, c.id, 'EMPLOYEE', 'Employee', 'الموظف'
      from app.company c where c.id = p_company_id
    on conflict (company_id, code) do nothing;
    select id into v_id from app.dimension_type where company_id = p_company_id and code = 'EMPLOYEE';
  end if;
  return v_id;
end $$;

create function app.ensure_employee_dimension_value(p_company_id uuid, p_employee_id uuid) returns uuid
language plpgsql as $$
declare
  v_type   uuid;
  v_id     uuid;
  v_code   text;
  v_name   text;
  v_tenant uuid;
begin
  -- Bound to the SUPPLIED company: an employee of another company of the same tenant is not found here, so the
  -- repair path cannot tag one company's ledger with another company's employee (RLS bounds the tenant only).
  select e.employee_number, p.name_en, e.tenant_id
    into v_code, v_name, v_tenant
    from app.employee e join app.party p on p.id = e.party_id
   where e.id = p_employee_id and e.company_id = p_company_id;
  if v_code is null then
    raise exception 'ERR_NOT_FOUND: no employee % in company %', p_employee_id, p_company_id
      using errcode = 'check_violation';
  end if;

  v_type := app.ensure_employee_dimension_type(p_company_id);
  select id into v_id from app.dimension_value where dimension_type_id = v_type and code = v_code;
  if v_id is null then
    insert into app.dimension_value (tenant_id, dimension_type_id, code, name_en)
    values (v_tenant, v_type, v_code, v_name)
    on conflict (dimension_type_id, code) do nothing;
    select id into v_id from app.dimension_value where dimension_type_id = v_type and code = v_code;
  end if;
  return v_id;
end $$;

-- ── 2. the trigger (§4.12.7) ─────────────────────────────────────────────────────────────────────────
create function app.employee_dimension() returns trigger language plpgsql as $$
begin
  perform app.ensure_employee_dimension_value(new.company_id, new.id);
  return new;
end $$;

create trigger employee_dimension_value
  after insert on app.employee
  for each row execute function app.employee_dimension();

comment on function app.employee_dimension() is
  'spec:2101 — one EMPLOYEE dimension value per employee, created on insert so every writer of app.employee produces one.';

-- ── 3. no index is created here, and that is a decision, not an omission ─────────────────────────────
-- The two lookups are `dimension_type (company_id, code)` and `dimension_value (dimension_type_id, code)`.
-- 0001 already declares `unique (company_id, code)` on app.dimension_type and `unique (dimension_type_id, code)`
-- on app.dimension_value, and Postgres backs every unique constraint with a unique index on exactly those
-- columns in exactly that order — so both lookups are already index scans.

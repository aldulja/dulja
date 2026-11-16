-- ── 0080_alter_employee_extend.sql ──────────────────────────────────────────────────────────────
-- §3.10.1 "Employee master" (spec:2075): position, employment type, a statutory-profile note and
-- archived_at. Expand only — every column is nullable, so the deployment is one PR and not two
-- (§3.4.7). HR master data is archived, never deleted (spec:2049).
-- The same file creates app.forbid_self_pay(), the ONE implementation of §4.2.2 R4 (spec:2175),
-- and attaches it to employee.terminated_on. Migrations 0081, 0082 and 0083 attach the same
-- function to the other three write targets the rule names.

-- ── 1. The four columns ─────────────────────────────────────────────────────────────────────────
alter table app.employee add column position               text;
alter table app.employee add column employment_type        text;
alter table app.employee add column statutory_profile_note text;
alter table app.employee add column archived_at            timestamptz;

alter table app.employee add constraint employee_employment_type_check
  check (employment_type is null or employment_type in ('full_time', 'part_time', 'contract', 'hourly'));

comment on column app.employee.employment_type is
  '§4.6.1. Hourly and part-time staff are a payroll SCOPE question (OD-14, spec:2093): the label exists so the master can record what the owner already knows, and no calculator branches on it until 8B is told to.';
comment on column app.employee.statutory_profile_note is
  'Free text for the payroll officer. The statutory INPUTS live in app.employee_statutory_profile (migration 0082); this column never carries one.';

-- ── 2. R4 — no self-pay (spec:2175, LEGACY-045) ────────────────────────────────────────────────────
-- TG_ARGV[0] names the column of NEW that holds the employee id: 'id' on app.employee itself,
-- 'employee_id' on the three child tables. format(%I) is applied to a literal written in a
-- migration file and never to request input (§3.3).
-- SECURITY INVOKER on purpose: the lookup must stay under RLS, and the row R4 is about — the
-- actor's OWN employee row — is visible to that actor whenever the actor can write the target at
-- all (the child tables' gates read the same employee row). A SECURITY DEFINER here would bypass
-- tenant_isolation as well, which is a tenancy hole rather than a branch one.
create function app.forbid_self_pay() returns trigger language plpgsql as $$
declare
  v_employee_id uuid;
  v_principal   uuid;
begin
  execute format('select ($1).%I', tg_argv[0]) into v_employee_id using new;
  select e.principal_id into v_principal from app.employee e where e.id = v_employee_id;
  if v_principal is not null and v_principal = app.current_actor() then
    -- PL/pgSQL's RAISE placeholder is `%` and nothing else. Two placeholders, two arguments.
    raise exception 'ERR_HR_SELF_PAY: principal % may not write their own % row (R4, spec:2175)',
      app.current_actor(), tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger employee_no_self_pay
  before update of terminated_on on app.employee
  for each row execute function app.forbid_self_pay('id');

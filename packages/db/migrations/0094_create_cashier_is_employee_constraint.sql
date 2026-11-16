-- 0094_create_cashier_is_employee_constraint.sql — 8C Task 11 (ADR 0078 decision 5, a proposal; contracts round 18 B13).
-- spec:2090, verbatim: "A **deferrable constraint trigger** on both `pos_cashier` and `employee` enforces **cashiers are
-- employees**: an unrevoked `pos_cashier` must reference an employee with `terminated_on IS NULL`."
--
-- DEFERRABLE INITIALLY DEFERRED is not a nicety. 0093's trigger writes `employee.terminated_on` first and
-- `pos_cashier.revoked_at` last, inside ONE transaction; an immediate constraint would see the intermediate state — a
-- live credential pointing at a terminated employee — and abort the very path spec:2090 mandates. Deferred to COMMIT,
-- the check reads the table as it then stands, so the two writes are one act.
--
-- The token follows the §4.1 form (errcode check_violation, message 'TOKEN: text'); `ERR_HR_CASHIER_NOT_EMPLOYEE` (409)
-- joins ERRORS in the same commit as this file (the `error-codes` lint scans migrations).
--
-- WHO the check reads as — the TENANT'S SYSTEM PRINCIPAL, the caller's actor restored straight after (0093's own swap,
-- ADR 0061's `refresh_pos_cashier` precedent). Both tables carry a RESTRICTIVE branch_isolation form: `pos_cashier`
-- Form A on the CREDENTIAL's branch, `employee` Form A′ on the employee's HOME branch, and the two may differ. A
-- check that read as the actor would find no row when either side is hidden from them, and a constraint that cannot see
-- the violation passes it: a clerk restricted to the credential's branch could un-revoke the credential of an employee
-- whose home branch they cannot see. The swap only READS — the function writes nothing — and it grants nothing.
--
-- The moved row is addressed through `to_jsonb(new)`, never `new.<column>`: `app.pos_cashier` has no `id` column (its
-- primary key is `principal_id`, a NO_ID_TABLES member), and plpgsql resolves every `new.<field>` while it builds the
-- query's parameter list — before any row is examined — so a `tg_table_name` guard does not save a literal `new.id`.
create function app.assert_cashier_is_employee() returns trigger language plpgsql as $$
declare
  moved    jsonb := to_jsonb(new);
  v_caller text  := current_setting('app.actor_id', true);
  v_tenant uuid  := coalesce(app.current_tenant(), (to_jsonb(new) ->> 'tenant_id')::uuid);
  v_system uuid;
  bad      record;
begin
  select p.id into v_system
    from app.principal p join app.membership m on m.principal_id = p.id
   where p.kind = 'system' and m.tenant_id = v_tenant;
  if v_system is not null then
    perform set_config('app.actor_id', v_system::text, true);
  end if;

  -- One query serves both attachments: whichever table moved, the question is the same.
  select c.principal_id, c.employee_id, e.employee_number, e.terminated_on
    into bad
    from app.pos_cashier c
    join app.employee e on e.tenant_id = c.tenant_id and e.id = c.employee_id
   where c.revoked_at is null
     and e.terminated_on is not null
     and (tg_table_name <> 'pos_cashier' or c.principal_id = (moved ->> 'principal_id')::uuid)
     and (tg_table_name <> 'employee'    or c.employee_id  = (moved ->> 'id')::uuid)
   limit 1;

  if v_system is not null then
    perform set_config('app.actor_id', coalesce(v_caller, ''), true);
  end if;

  if bad.principal_id is not null then
    raise exception
      'ERR_HR_CASHIER_NOT_EMPLOYEE: cashier % references terminated employee % (terminated %)',
      bad.principal_id, bad.employee_number, bad.terminated_on
      using errcode = 'check_violation';
  end if;
  return null;   -- AFTER (constraint) trigger: the return value is ignored
end $$;

-- `update of employee_id, revoked_at`, not every update: the only writes that can make a credential live or move it to
-- another employee. 6C's snapshot refreshes and the PIN endpoints touch neither column, so they queue no check.
create constraint trigger pos_cashier_is_employee
  after insert or update of employee_id, revoked_at on app.pos_cashier
  deferrable initially deferred
  for each row execute function app.assert_cashier_is_employee();

create constraint trigger employee_cashier_still_employed
  after update of terminated_on on app.employee
  deferrable initially deferred
  for each row execute function app.assert_cashier_is_employee();

comment on function app.assert_cashier_is_employee() is
  'spec:2090 — cashiers are employees (ADR 0078 decision 5): an unrevoked pos_cashier must reference an employee with terminated_on IS NULL. Deferred to COMMIT so 0093''s terminate-then-revoke is one act; reads as the tenant''s system principal so a branch-hidden row cannot pass the check vacuously.';

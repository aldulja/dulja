-- 0090_create_compensation_change_returns_run.sql
-- R3, spec:2174, verbatim: "a compensation change effective in the period of a run in `submitted` or
-- `approved` status returns that run to `draft` (the one backward transition the state machine allows,
-- recorded in document_event with reason `compensation_changed`) and requires re-submission and
-- re-approval; a change effective in a period whose run is already `posted` never touches that run — it is
-- picked up by the next `supplementary` run. The approval screen lists everyone who changed compensation in
-- the period."
--
-- WHY A TRIGGER (and why migration 0090 is not spare — round 17 A1): R3 is a data-layer rule. Putting it in the
-- compensation handler would leave the seed CLI, the Phase 9 importer and any direct `app_rw` update outside
-- it, which is SAH-032's shape — an authority rule the data layer does not hold.
--
-- The file has two parts:
--   1. the R3 trigger on app.compensation_line;
--   2. the bounded, company-bound lookup behind the rule's last sentence (8B T11 decision, recorded in
--      docs/review/2026-11-07-phase-8-decisions.md as a security widening). The approver who reads that list
--      holds `hr.payroll.read` and usually NOT `hr.compensation.read` (the seeded `accountant` does not), and 8A's
--      RESTRICTIVE `compensation_gate` hides every compensation_line row from such a session. The lookup answers
--      exactly three facts per change — WHO entered it, for WHICH employee, effective WHEN — and never an amount,
--      a quantity or a component.

-- ── 1. R3 ────────────────────────────────────────────────────────────────────────────────────────────────
-- One employee's change over one effective window. Called for the NEW row and for the OLD row: an UPDATE that
-- moves a line out of a period (or onto another employee) changes the figures of the run it left as much as
-- of the run it entered.
create function app.return_runs_for_compensation(p_employee_id uuid, p_from date, p_to date)
returns void language plpgsql as $$
declare
  r record;
begin
  -- Only the two statuses R3 names. `draft` needs nothing (it is already there) and `posted`, `issued`, `void`
  -- and `reversed` are never touched: a posted run's figures are history (SAH-041).
  --
  -- The join through payroll_line is what scopes the rule to THIS employee's runs: a join on payroll_run alone
  -- would bounce every overlapping run, including a supplementary or final run for somebody else. `group by`
  -- makes one run appear once however many lines the employee has on it.
  for r in
    select d.id
      from app.payroll_run pr
      join app.document d on d.id = pr.document_id
      join app.document_line dl on dl.document_id = d.id
      join app.payroll_line pl on pl.document_line_id = dl.id and pl.employee_id = p_employee_id
     where d.status in ('submitted', 'approved')
       and pr.period_start <= coalesce(p_to, pr.period_end)
       and pr.period_end   >= p_from
     group by d.id
  loop
    -- §4.5.2's transaction settings, which 2B's AFTER UPDATE OF status trigger reads to write the event's reason
    -- (`nullif(current_setting('app.event_reason', true), '')`) and which 2B's BEFORE trigger REQUIRES on the
    -- backward edge. Set per iteration, not once before the loop: nothing between two iterations may change them.
    perform set_config('app.event_reason', 'compensation_changed', true);
    perform set_config('app.event_attributed_to', '', true);
    update app.document set status = 'draft' where id = r.id;
  end loop;
end $$;

comment on function app.return_runs_for_compensation(uuid, date, date) is
  'spec:2174 R3 — returns every submitted or approved payroll run of the employee whose period overlaps the window to draft, with reason compensation_changed.';

create function app.compensation_change_returns_run() returns trigger language plpgsql as $$
begin
  if tg_op <> 'DELETE' then
    perform app.return_runs_for_compensation(new.employee_id, new.effective_from, new.effective_to);
  end if;
  if tg_op <> 'INSERT' then
    perform app.return_runs_for_compensation(old.employee_id, old.effective_from, old.effective_to);
  end if;
  return null;
end $$;

comment on function app.compensation_change_returns_run() is
  'spec:2174 R3 — a compensation change inside a submitted or approved run''s period returns the run to draft so the approver always approves the figures that will post.';

create trigger compensation_line_returns_run
  after insert or update or delete on app.compensation_line
  for each row execute function app.compensation_change_returns_run();

-- ── 2. "everyone who changed compensation in the period" — the bounded lookup ───────────────────────────
-- The 0068/0119 pattern (ADR 0062, ADR 0043's amendment): owned by app_auth (NOLOGIN, no BYPASSRLS, assumable
-- only by app_migrator), a fixed search_path, exact column grants it cannot write through, the current tenant
-- bound explicitly and tenant_isolation still applying to app_auth inside it, and never a policy predicate.
--
-- So that app_auth reads the rows at all, `compensation_gate` is scoped to the two data roles exactly as 0068
-- scoped Form A′ on app.employee: for app_rw and app_migrator it is the SAME policy, and app_auth gains SELECT on
-- four compensation_line columns — none of them `amount`, `quantity` or `component_id` — so the gate's whole
-- content (the figures) stays behind it.
drop policy compensation_gate on app.compensation_line;
create policy compensation_gate on app.compensation_line as restrictive to app_rw, app_migrator
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

grant select (tenant_id, employee_id, effective_from, entered_by) on app.compensation_line to app_auth;
-- app.actor_has, evaluated as app_auth inside the lookup, reads principal and membership (0001 granted both) and
-- role_assignment and role_assignment_branch (0068 granted the columns it reads); role_permission is the one
-- table it reads that app_auth could not.
grant select (tenant_id, role_id, permission_code) on app.role_permission to app_auth;

-- Answered only to a session holding `hr.payroll.read` (the approver and the auditor read a run with it) or
-- `hr.compensation.read` (who sees the rows anyway) company-wide in the supplied company. A system principal
-- passes `actor_has` as everywhere else (spec:2179). The caller narrows the answer to the run's own employees.
create function app.compensation_changes_in_period(p_company_id uuid, p_from date, p_to date)
returns table (principal_id uuid, employee_id uuid, effective_from date)
language sql stable security definer set search_path = app, pg_temp as $$
  select distinct cl.entered_by, cl.employee_id, cl.effective_from
    from app.compensation_line cl
    join app.employee e on e.tenant_id = cl.tenant_id and e.id = cl.employee_id
   where cl.tenant_id = app.current_tenant()
     and e.company_id = p_company_id
     and cl.effective_from between p_from and p_to
     and (app.actor_has('hr.payroll.read', p_company_id)
          or app.actor_has('hr.compensation.read', p_company_id))
$$;
comment on function app.compensation_changes_in_period(uuid, date, date) is
  '8B T11 (spec:2174 R3, last sentence): who entered a compensation change of which employee of the supplied company, effective inside [p_from, p_to] — never an amount, quantity or component — answered only to a holder of hr.payroll.read or hr.compensation.read in that company. Bounded: three columns, no write, owned by app_auth (no BYPASSRLS), never a policy predicate.';
revoke all on function app.compensation_changes_in_period(uuid, date, date) from public;
grant execute on function app.compensation_changes_in_period(uuid, date, date) to app_rw;
grant create on schema app to app_auth;
alter function app.compensation_changes_in_period(uuid, date, date) owner to app_auth;
revoke create on schema app from app_auth;

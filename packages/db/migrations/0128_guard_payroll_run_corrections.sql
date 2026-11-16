-- ── 0128 · payroll run corrections: one regular run per period, R3 over employment and statutory inputs, and a
--    supplementary run that cannot post a stale delta ───────────────────────────────────────────────────────────
-- Full review 2026-11-15, findings HRP-02, HRP-08 and HRP-12 (docs/review/2026-11-15-full-review.md). The number was
-- allocated to this fix by the review's orchestrator under §3.4.1's tail rule; the register row is the orchestrator's.
--
-- Three data-layer rules, each holding for every writer (the run service, the seed CLI, the Phase 9 importer and a
-- direct app_rw statement), as R3 itself does (0090):
--
--   1. HRP-08 — at most one `regular` payroll run per company over any span of days that is not void. Two regular
--      runs for one month credit every employee's net pay to 2400 twice; approval was the only safeguard.
--   2. HRP-12 — R3 (spec:2174) returned a submitted or approved run to draft on a compensation change only, but a run's
--      figures also come from `employee.hired_on`/`terminated_on` (proration) and `employee_statutory_profile` (the
--      scheme inputs). A change to either inside a run's period now returns the run the same way, with its own reason.
--   3. HRP-02 — a supplementary run carries the period's corrected figures LESS what the period's posted runs already
--      carried (ADR 0076's amendment). Its delta is computed against the runs posted when it was calculated, so if
--      another run of its period posts after that, the delta is stale: posting it is refused until it is recalculated.

-- ── 1. one regular run per company and period ──────────────────────────────────────────────────────────────────
-- The advisory lock serialises two writers of the same company, so the second's read sees the first's committed row
-- (read committed takes a fresh snapshot per statement). A void run does not count: voiding the first is how a
-- preparer starts again.
create function app.forbid_second_regular_payroll_run() returns trigger language plpgsql as $$
declare
  other uuid;
begin
  if new.kind <> 'regular' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payroll_regular_run:' || new.company_id::text, 0));
  select pr.document_id into other
    from app.payroll_run pr
    join app.document d on d.id = pr.document_id
   where pr.company_id = new.company_id
     and pr.kind = 'regular'
     and pr.document_id <> new.document_id
     and d.status <> 'void'
     and pr.period_start <= new.period_end
     and pr.period_end >= new.period_start
   limit 1;
  if other is not null then
    raise exception 'ERR_VALIDATION_FAILED: a regular payroll run (%) already covers part of %..%; correct a posted period with a supplementary run, or void the other run first',
      other, new.period_start, new.period_end
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

comment on function app.forbid_second_regular_payroll_run() is
  'HRP-08 — refuses a regular payroll run whose period overlaps another non-void regular run of the same company.';

create trigger payroll_run_one_regular_per_period
  before insert or update of kind, company_id, period_start, period_end on app.payroll_run
  for each row execute function app.forbid_second_regular_payroll_run();

-- ── 2. R3 over employment dates and the statutory profile ──────────────────────────────────────────────────────
-- 0090's `app.return_runs_for_compensation`, with the reason as a parameter. 0090's function is left exactly as it
-- is: its reason `compensation_changed` is the one R3 names.
create function app.return_payroll_runs(p_employee_id uuid, p_from date, p_to date, p_reason text)
returns void language plpgsql as $$
declare
  r record;
begin
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
    perform set_config('app.event_reason', p_reason, true);
    perform set_config('app.event_attributed_to', '', true);
    update app.document set status = 'draft' where id = r.id;
  end loop;
end $$;

comment on function app.return_payroll_runs(uuid, date, date, text) is
  'HRP-12 — returns every submitted or approved payroll run of the employee whose period overlaps the window to draft, recording the reason.';

-- A date that moved changes the proration of every period between its old and new value; a date set or cleared
-- (terminated_on null ↔ a date) changes every period from that date on, so the window is open-ended.
create function app.employment_change_returns_run() returns trigger language plpgsql as $$
begin
  if old.hired_on is distinct from new.hired_on then
    perform app.return_payroll_runs(new.id, least(old.hired_on, new.hired_on),
                                    greatest(old.hired_on, new.hired_on), 'employment_changed');
  end if;
  if old.terminated_on is distinct from new.terminated_on then
    perform app.return_payroll_runs(
      new.id,
      least(coalesce(old.terminated_on, new.terminated_on), coalesce(new.terminated_on, old.terminated_on)),
      case when old.terminated_on is null or new.terminated_on is null then null
           else greatest(old.terminated_on, new.terminated_on) end,
      'employment_changed');
  end if;
  return null;
end $$;

comment on function app.employment_change_returns_run() is
  'HRP-12 — a hire or termination date moved inside a submitted or approved run''s period returns the run to draft.';

create trigger employee_employment_change_returns_run
  after update of hired_on, terminated_on on app.employee
  for each row execute function app.employment_change_returns_run();

create function app.statutory_profile_change_returns_run() returns trigger language plpgsql as $$
begin
  if tg_op <> 'DELETE' then
    perform app.return_payroll_runs(new.employee_id, new.effective_from, new.effective_to,
                                    'statutory_profile_changed');
  end if;
  if tg_op <> 'INSERT' then
    perform app.return_payroll_runs(old.employee_id, old.effective_from, old.effective_to,
                                    'statutory_profile_changed');
  end if;
  return null;
end $$;

comment on function app.statutory_profile_change_returns_run() is
  'HRP-12 — a statutory profile change inside a submitted or approved run''s period returns the run to draft.';

create trigger employee_statutory_profile_returns_run
  after insert or update or delete on app.employee_statutory_profile
  for each row execute function app.statutory_profile_change_returns_run();

-- ── 3. a supplementary run's delta must still be current when it posts ─────────────────────────────────────────
-- `payroll_run.calculated_at` is the calculation's transaction time (0087's default; a recalculation sets it again).
-- A run of an overlapping period sharing one of its employees whose `posted_at` is LATER was not netted, so the
-- supplementary run would pay it again. The run is refused; it stays where it is, and recalculating it (from draft)
-- nets the new run.
create function app.forbid_stale_supplementary_payroll_post() returns trigger language plpgsql as $$
declare
  stale uuid;
  calculated timestamptz;
begin
  select me.calculated_at into calculated
    from app.payroll_run me
   where me.document_id = new.id and me.kind = 'supplementary';
  if calculated is null then
    return new;
  end if;
  select d2.id into stale
    from app.payroll_run me
    join app.payroll_run pr on pr.company_id = me.company_id and pr.document_id <> me.document_id
    join app.document d2 on d2.id = pr.document_id
   where me.document_id = new.id
     and d2.status = 'posted'
     and d2.posted_at > me.calculated_at
     and pr.period_start <= me.period_end
     and pr.period_end >= me.period_start
     and exists (select 1
                   from app.document_line la
                   join app.payroll_line a on a.document_line_id = la.id
                   join app.payroll_line b on b.employee_id = a.employee_id
                   join app.document_line lb on lb.id = b.document_line_id
                  where la.document_id = new.id and lb.document_id = d2.id)
   limit 1;
  if stale is not null then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: supplementary payroll run % was calculated at % and payroll run % of its period posted since; return it to draft and recalculate it so it carries the difference from what is now posted (ADR 0076)',
      new.id, calculated, stale
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

comment on function app.forbid_stale_supplementary_payroll_post() is
  'HRP-02 — refuses posting a supplementary payroll run when another run of its period, sharing an employee, posted after it was calculated.';

create trigger document_supplementary_payroll_current
  before update of status on app.document
  for each row when (new.status = 'posted' and old.status is distinct from new.status)
  execute function app.forbid_stale_supplementary_payroll_post();

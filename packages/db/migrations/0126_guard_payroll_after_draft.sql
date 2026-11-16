-- ── 0126 · a posted payroll is frozen for every principal; an employee never changes company; a verifier only signs ──
-- Full review 2026-11-15 (not a slice), findings DBS-03, DBS-09 and DBS-10; number allocated by the review's
-- orchestrator in Plan Contracts §3.4.1's tail. Proposed amendments: ADR 0074 (DBS-03, DBS-09), ADR 0076 (DBS-03)
-- and ADR 0073 (DBS-10).
--
-- 1. DBS-03. 0087's `forbid_payroll_line_change_unless_draft` read the parent status through app.document under the
--    caller's RLS and refused only `s is not null and s <> 'draft'`. The NULL branch exists for the ON DELETE CASCADE
--    from document_line, but a principal who cannot SEE the document — restricted to another branch, or an employee
--    holding no role at all — also reads NULL, and payroll_line carried tenant RLS only, so both rewrote a posted run's
--    line (the reviewer reproduced UPDATE 1 for each). app.payroll_run had no freeze: a posted run's pay_date, period,
--    kind and pinned_tables (SAH-013's record of what was applied) were writable.
--    The fix, in four parts:
--    (a) RESTRICTIVE parent-visibility policies on payroll_line and payroll_run, the 0068/0119 shape: a row is READ
--        under a readable document and WRITTEN only under a writable one (`app.actor_in_branch` at its branch).
--    (b) The line guard fails closed. On INSERT and UPDATE the parent document_line exists (the FK says so), so a
--        NULL status can only mean a document the caller cannot see, and it is refused. On DELETE the NULL is still
--        admitted: app_rw holds no DELETE on payroll_line (§3.5.4's list is closed), so the one DELETE that reaches
--        the trigger is the CASCADE, during which the parent row is already gone. An UPDATE that moves a line checks
--        the parent it leaves AND the parent it joins. INSERT is now guarded too.
--    (c) payroll_run is frozen once its document leaves draft, as 0117 freezes the header: a whole-row comparison,
--        so a column a later slice adds is frozen with no edit here. Its INSERT needs a visible draft document.
--        No service writes either table after draft: run.ts inserts both and updates payroll_run's pinned_tables
--        and calculated_at only while recalculating a draft, and the posting path writes neither.
--    (d) R4 (spec:2175, SAH-045) reaches payroll_line: nobody UPDATEs their own line, and nobody INSERTs an
--        OVERRIDE on their own line (spec:2087's manual statutory override). A calculated INSERT is not refused —
--        the preparer of a run may be one of its employees, and the figures come from compensation that R4
--        already guards; the run is then submitted and approved by someone else (R1, R3). Whether that is enough
--        is an owner question recorded in ADR 0074's amendment.
-- 2. DBS-09. sensitive_gate and compensation_gate (0081, 0082, 0083, 0090) derive the company from the employee row,
--    and nothing froze employee.company_id: a writer with HR codes in company A and any role in B could move a B
--    employee into A and read their sealed columns and compensation. It is frozen, as 0107 froze
--    fiscal_period.company_id. No service writes the column after insert.
-- 3. DBS-10. 0084's verifier froze a table's content only once `old.verified_at is not null`; on the verify edge it
--    checked only that the actor was not the loader, so the verifier could rewrite definition and source in the
--    statement that signed them. On that edge every column except verified_at and verified_by is now frozen, and
--    the actor must hold hr.statutory_table.verify in the scheme's company (the route's gate, now also the data
--    layer's, spec:2173). 8A's verifyRateTable writes exactly those two columns.

-- ── 1(a) parent visibility ────────────────────────────────────────────────────────────────────────────────────────
-- document_line's own RESTRICTIVE document_parent_visibility already hides a line whose document is hidden, so the
-- read form joins document_line alone; the write form names the document's branch, as 0119's does.
create policy document_parent_visibility on app.payroll_line as restrictive
  using (exists (select 1 from app.document_line l
                  where l.tenant_id = payroll_line.tenant_id and l.company_id = payroll_line.company_id
                    and l.id = payroll_line.document_line_id))
  with check (exists (select 1 from app.document_line l
                        join app.document d on d.tenant_id = l.tenant_id and d.id = l.document_id
                       where l.tenant_id = payroll_line.tenant_id and l.company_id = payroll_line.company_id
                         and l.id = payroll_line.document_line_id
                         and app.actor_in_branch(d.company_id, d.branch_id)));

create policy document_parent_visibility on app.payroll_run as restrictive
  using (exists (select 1 from app.document d
                  where d.tenant_id = payroll_run.tenant_id and d.company_id = payroll_run.company_id
                    and d.id = payroll_run.document_id))
  with check (exists (select 1 from app.document d
                        where d.tenant_id = payroll_run.tenant_id and d.company_id = payroll_run.company_id
                          and d.id = payroll_run.document_id
                          and app.actor_in_branch(d.company_id, d.branch_id)));

-- ── 1(b) the line guard, failing closed ──────────────────────────────────────────────────────────────────────────
create or replace function app.forbid_payroll_line_change_unless_draft() returns trigger language plpgsql as $$
declare
  v_line uuid;
  s      app.document_status;
begin
  foreach v_line in array case tg_op when 'INSERT' then array[new.document_line_id]
                                     when 'DELETE' then array[old.document_line_id]
                                     else array[old.document_line_id, new.document_line_id] end loop
    s := null;
    select d.status into s
      from app.document d join app.document_line l on l.document_id = d.id
     where l.id = v_line;
    if s is null and tg_op = 'DELETE' then
      continue;                          -- the CASCADE from document_line: the parent is already gone
    end if;
    if s is distinct from 'draft' then
      raise exception 'ERR_DOC_NOT_DRAFT: payroll line % belongs to a document that is %; a posted run is corrected by a supplementary run, never edited in place (spec:2081, SAH-041)',
        v_line, coalesce(s::text, 'not visible to this principal')
        using errcode = 'check_violation';
    end if;
  end loop;
  return coalesce(new, old);
end $$;

drop trigger payroll_line_change_draft_only on app.payroll_line;
create trigger payroll_line_change_draft_only
  before insert or update or delete on app.payroll_line
  for each row execute function app.forbid_payroll_line_change_unless_draft();

-- ── 1(c) payroll_run frozen after draft ──────────────────────────────────────────────────────────────────────────
create function app.payroll_run_frozen_after_draft() returns trigger language plpgsql as $$
declare
  s app.document_status;
begin
  select d.status into s from app.document d where d.id = new.document_id;
  if tg_op = 'UPDATE' then
    if to_jsonb(new) is not distinct from to_jsonb(old) then
      return new;
    end if;
    if new.document_id is distinct from old.document_id then
      raise exception 'ERR_DOC_NOT_DRAFT: payroll run % cannot move to another document', old.document_id
        using errcode = 'check_violation';
    end if;
  end if;
  if s is distinct from 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: payroll run % belongs to a document that is %; its pay date, period, kind and pinned rate tables are frozen once it leaves draft (spec:2081, SAH-013, SAH-041)',
      new.document_id, coalesce(s::text, 'not visible to this principal')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger payroll_run_frozen_after_draft
  before insert or update on app.payroll_run
  for each row execute function app.payroll_run_frozen_after_draft();

-- ── 1(d) R4 on payroll_line ──────────────────────────────────────────────────────────────────────────────────────
create trigger payroll_line_no_self_pay
  before update on app.payroll_line
  for each row execute function app.forbid_self_pay('employee_id');
create trigger payroll_line_override_no_self_pay
  before insert on app.payroll_line
  for each row when (new.override_reason is not null) execute function app.forbid_self_pay('employee_id');

-- ── 2. employee.company_id is immutable ──────────────────────────────────────────────────────────────────────────
create function app.employee_company_immutable() returns trigger language plpgsql as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'ERR_VALIDATION_FAILED: employee % cannot move to another company; the HR gates and every payroll, YTD and leave row are bound to the company it was hired into',
      old.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger employee_company_immutable
  before update of company_id on app.employee
  for each row execute function app.employee_company_immutable();

-- ── 3. the verifying UPDATE changes only the verification ────────────────────────────────────────────────────────
create or replace function app.assert_rate_table_verifier() returns trigger language plpgsql as $$
declare
  v_company uuid;
begin
  if tg_op = 'INSERT' then
    if new.verified_at is not null or new.verified_by is not null then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is loaded unverified; verification requires a different principal (spec:2080)',
        new.version, new.scheme_id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.verified_at is null and new.verified_at is not null then
    if app.current_actor() = old.loaded_by then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % was loaded by this principal; verification requires a different principal (spec:2080)',
        old.version, old.scheme_id using errcode = 'check_violation';
    end if;
    -- verified_by is excluded because stamp_verified_by replaces it with the session actor whichever trigger
    -- fires first; every other column is what the loader wrote and the verifier is signing.
    if (to_jsonb(new) - array['verified_at', 'verified_by']) is distinct from
       (to_jsonb(old) - array['verified_at', 'verified_by']) then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is verified as loaded; the verifying statement may set only verified_at and verified_by (SAH-020, spec:2080)',
        old.version, old.scheme_id using errcode = 'check_violation';
    end if;
    select sc.company_id into v_company from app.statutory_scheme sc where sc.id = old.scheme_id;
    if not coalesce(app.actor_has('hr.statutory_table.verify', v_company), false) then
      raise exception 'ERR_RBAC_FORBIDDEN: principal % does not hold hr.statutory_table.verify in company %',
        app.current_actor(), v_company using errcode = 'check_violation';
    end if;
  end if;
  if old.verified_at is not null and (
       new.definition     is distinct from old.definition
    or new.version        is distinct from old.version
    or new.scheme_id      is distinct from old.scheme_id
    or new.effective_from is distinct from old.effective_from
    or new.source         is distinct from old.source
    or new.verified_at    is distinct from old.verified_at) then
    -- effective_to is deliberately NOT in the list above and the message must not claim it is: a
    -- successor version has to be able to close its predecessor's open window, which is an UPDATE of
    -- effective_to on a verified row. Every other field is frozen, the verification itself included.
    raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is already verified; its definition, version, effective_from, source and verification are frozen (effective_to may still be closed by a successor). Load a NEW version rather than editing a signed one (SAH-041, spec:2080)',
      old.version, old.scheme_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

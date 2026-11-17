-- 0126 down: restores 0087's line guard (UPDATE and DELETE only, NULL admitted), 0084's verifier, and drops the
-- payroll parent-visibility policies, the payroll_run freeze, R4 on payroll_line and the employee company freeze.
-- Down-migrating reopens DBS-03, DBS-09 and DBS-10.
drop trigger employee_company_immutable on app.employee;
drop function app.employee_company_immutable();

drop trigger payroll_line_override_no_self_pay on app.payroll_line;
drop trigger payroll_line_no_self_pay on app.payroll_line;

drop trigger payroll_run_frozen_after_draft on app.payroll_run;
drop function app.payroll_run_frozen_after_draft();

drop policy document_parent_visibility on app.payroll_run;
drop policy document_parent_visibility on app.payroll_line;

drop trigger payroll_line_change_draft_only on app.payroll_line;
create or replace function app.forbid_payroll_line_change_unless_draft() returns trigger language plpgsql as $$
declare
  s app.document_status;
begin
  select d.status into s
    from app.document d join app.document_line l on l.document_id = d.id
   where l.id = coalesce(new.document_line_id, old.document_line_id);
  if s is not null and s <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: payroll line % belongs to a document that is %; a posted run is corrected by a supplementary run, never edited in place (spec:2081, LEGACY-041)',
      coalesce(new.document_line_id, old.document_line_id), s
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create trigger payroll_line_change_draft_only
  before update or delete on app.payroll_line
  for each row execute function app.forbid_payroll_line_change_unless_draft();

create or replace function app.assert_rate_table_verifier() returns trigger language plpgsql as $$
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
    raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is already verified; its definition, version, effective_from, source and verification are frozen (effective_to may still be closed by a successor). Load a NEW version rather than editing a signed one (LEGACY-041, spec:2080)',
      old.version, old.scheme_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

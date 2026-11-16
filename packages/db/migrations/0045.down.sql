-- Drops exactly what 0045 added, in reverse dependency order (§3.4.5). The three tables are 0001's, 0017's and
-- 0021's and are NEVER dropped here — only this file's columns, constraints, functions and triggers.
-- 0022's app.document_status_before(), restored byte for byte (0045 §5 replaced it).
create or replace function app.document_status_before() returns trigger language plpgsql as $$
declare
  v_policy   jsonb;
  v_required boolean;
  v_approve  text;
  v_post     text;
  v_gate     text;
begin
  -- An UPDATE that lists status but does not change it is not a transition (a no-op re-save).
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_policy := app.effective_policy(new.document_type_id, new.effective_date);
  if v_policy is null then
    raise exception 'ERR_POLICY_NOT_FOUND: no posting policy of document type % is effective on %',
      new.document_type_id, to_char(new.effective_date, 'YYYY-MM-DD') using errcode = 'check_violation';
  end if;
  v_required := coalesce((v_policy -> 'approval' ->> 'required')::boolean, false);
  v_approve  := v_policy -> 'approval' ->> 'approve';
  v_post     := v_policy -> 'approval' ->> 'post';

  -- ── 2a. the matrix (contracts §4.5.1). Every pair not named here is illegal. ──────────────────────
  if old.status = 'draft' and new.status = 'submitted' then
    null;                                                        -- always

  elsif old.status in ('draft', 'submitted') and new.status = 'issued' then
    if v_required then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: % → issued needs approval.required = false; document % must be approved first',
        old.status, new.id using errcode = 'check_violation';
    end if;

  elsif old.status = 'submitted' and new.status = 'approved' then
    null;                                                        -- R1 and R2 below

  elsif old.status in ('submitted', 'approved') and new.status = 'draft' then
    -- The one backward edge (spec:1188, 2081). R3 uses reason 'compensation_changed'; every caller must give one.
    if nullif(current_setting('app.event_reason', true), '') is null then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: returning document % from % to draft is a recalculation and needs a reason (spec:2081)',
        new.id, old.status using errcode = 'check_violation';
    end if;

  elsif old.status = 'approved' and new.status = 'issued' then
    null;                                                        -- authority was checked at approved

  elsif old.status = 'issued' and new.status in ('posted', 'void') then
    null;                                                        -- R1 and R2 below

  elsif old.status = 'posted' and new.status = 'reversed' then
    -- "Only by reverseDocument" expressed in data: 1A posts the reversing document BEFORE flipping the
    -- original, so a posted document carrying reverses_document_id = this one is that call's signature (D13).
    if not exists (select 1 from app.document r where r.reverses_document_id = new.id and r.status = 'posted') then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: document % can only be marked reversed by reverseDocument, which posts the reversing document first (D13, spec:2224)',
        new.id using errcode = 'check_violation';
    end if;

  else
    raise exception 'ERR_DOC_STATUS_ILLEGAL: % → % is not a legal transition for document % (contracts §4.5.1)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- ── 2b. R1 maker <> checker (spec:2172). Read from document_event, which only triggers write. ─────
  if v_required and new.status in ('approved', 'posted') then
    if not exists (select 1 from app.document_event e
                    where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted') then
      raise exception 'ERR_SOD_NO_SUBMISSION: document % has no submitted event; its type requires a maker before a checker',
        new.id using errcode = 'check_violation';
    end if;
    if exists (select 1 from app.document_event e
                where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted'
                  and e.actor_id = app.current_actor()) then
      raise exception 'ERR_SOD_MAKER_IS_CHECKER: principal % submitted document % and cannot % it',
        app.current_actor(), new.id, case when new.status = 'approved' then 'approve' else 'post' end
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── 2c. R2 authority at transition time (spec:2173). NULL branch never fails open (SAH-042, SAH-050). ─
  if new.status = 'approved' then
    v_gate := coalesce(v_approve, v_post);          -- for approval.required = false types approve is null
  elsif new.status in ('posted', 'void') then
    v_gate := v_post;
  else
    v_gate := null;                                 -- submitted, draft and issued evaluate no code (ADR 0029)
  end if;

  if v_gate is null and new.status in ('approved', 'posted', 'void') then
    raise exception 'ERR_POLICY_INVALID: the policy effective for document % declares no approval.%',
      new.id, case when new.status = 'approved' then 'approve and no approval.post' else 'post' end
      using errcode = 'check_violation';
  end if;
  if v_gate is not null and not app.actor_has(v_gate, new.company_id, new.branch_id) then
    raise exception 'ERR_RBAC_FORBIDDEN: principal % does not hold % at branch % of company %',
      app.current_actor(), v_gate, new.branch_id, new.company_id using errcode = 'check_violation';
  end if;

  return new;
end $$;
drop function if exists app.party_control_account(app.party);
drop trigger if exists party_control_account_pinned on app.party;
drop function if exists app.assert_party_control_unchanged();
drop trigger if exists payment_term_days_pinned on app.payment_term;
drop function if exists app.assert_payment_term_days_unpinned();
drop trigger if exists document_credit_control on app.document;
drop function if exists app.assert_credit_available();
drop function if exists app.party_credit_exposure(uuid, uuid);
drop function if exists app.party_open_balance(uuid, date);
drop trigger if exists document_event_credit_override_amount on app.document_event;
drop function if exists app.stamp_credit_override();
alter table app.document_event drop constraint if exists document_event_approved_base_total_check;
alter table app.document_event drop column if exists approved_base_total;
drop function if exists app.policy_extends_credit(jsonb);
drop function if exists app.document_base_total(uuid, numeric);
alter table app.document drop constraint if exists document_payment_term_fk;
alter table app.document drop column if exists payment_term_id;
alter table app.party drop constraint if exists party_price_list_fk;
alter table app.party drop constraint if exists party_payment_term_fk;
alter table app.party drop constraint if exists party_credit_limit_check;
alter table app.party drop column if exists price_list_id;
alter table app.party drop column if exists credit_hold;
alter table app.party drop column if exists payment_term_id;
alter table app.party drop column if exists credit_limit;

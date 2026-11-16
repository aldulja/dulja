-- 0022_create_document_status_triggers.sql ────────────────────────────────────────────────────────────────
-- The document state machine, in the data layer. spec:2172-2173; contracts §4.5.1; ADR 0029.
-- SAH-032: a user could raise a document's approval level above their own because the check lived in the UI.
-- Here it lives in a BEFORE UPDATE OF status trigger, so the API, a pg-boss job and psql as app_rw are all
-- governed identically (acceptance tests 10 and 31).

-- ── 1. the SQL twin of the posting service's resolvePolicy (contracts §4.3.1, §4.5.2) ─────────────────
-- The policy EFFECTIVE FOR THE DOCUMENT'S effective_date — never document.posting_policy_id, which §3.8 pins
-- only at post and is NULL at approval (spec:2172). Ties on effective_from are broken by the highest version.
create function app.effective_policy(p_document_type_id uuid, p_on date) returns jsonb
language sql stable as $$
  select p.definition
    from app.posting_policy p
   where p.document_type_id = p_document_type_id
     and p.effective_from <= p_on
   order by p.effective_from desc, p.version desc
   limit 1
$$;

-- ── 2. the BEFORE trigger: the legal-transition matrix, R1 and R2 ────────────────────────────────────
create function app.document_status_before() returns trigger language plpgsql as $$
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

-- Trigger names fire alphabetically within a timing class: document_status_before runs before stamp_created_by
-- and stamp_posted_by, neither of which this function reads.
create trigger document_status_before before update of status on app.document
  for each row execute function app.document_status_before();

-- ── 3. the AFTER trigger: the record itself (spec:2172 clause 1) ─────────────────────────────────────
-- Handlers never insert document_event. The reason and the attributed principal arrive as transaction
-- settings, which is the convention contracts §4.5.2 fixes for spec:2172's "reason from a transaction setting".
create function app.document_status_after() returns trigger language plpgsql as $$
begin
  insert into app.document_event (tenant_id, company_id, document_id, event_kind, from_status, to_status,
                                  attributed_to, reason)
  values (new.tenant_id, new.company_id, new.id, 'transition', old.status, new.status,
          nullif(current_setting('app.event_attributed_to', true), '')::uuid,
          nullif(current_setting('app.event_reason', true), ''));
  return null;                                       -- row-level AFTER triggers ignore the return value
end $$;

create trigger document_status_after after update of status on app.document
  for each row when (old.status is distinct from new.status) execute function app.document_status_after();

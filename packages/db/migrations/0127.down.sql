-- 0127.down.sql — restores 0045's and 0116's bodies exactly as they wrote them, 0119's branch_isolation on
-- app.document for every role, and removes the five lookups, their helper and app_auth's grants. Development
-- and CI only (spec:2057).

create or replace function app.party_open_balance(p_party_id uuid, p_as_of date) returns numeric
language plpgsql stable as $$
declare
  v_account_id uuid;
  v_limit      numeric(19,4);
  v_found      boolean;
begin
  select true, p.receivable_account_id, p.credit_limit
    into v_found, v_account_id, v_limit
    from app.party p where p.id = p_party_id;
  if v_found is not true then
    raise exception 'ERR_NOT_FOUND: party % is not visible', p_party_id using errcode = 'check_violation';
  end if;
  if v_account_id is null then
    if v_limit is null then return 0::numeric(19,4); end if;
    raise exception
      'ERR_POLICY_REQUIRES_MISSING: party % carries a credit limit but no receivable control account — set '
      'party.receivable_account_id (§4.15 1200 trade receivables is the default) or clear the limit',
      p_party_id using errcode = 'check_violation';
  end if;
  -- coalesce at the accumulation boundary (SAH-011): a party with no posted row owes 0, never NULL.
  return (
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)
      from app.ledger_entry l
      join app.document     d on d.id = l.document_id
     where d.party_id = p_party_id
       and (p_as_of is null or d.effective_date <= p_as_of)
       and l.account_id = v_account_id);
end $$;
comment on function app.party_open_balance(uuid, date) is
  'contracts §4.8.1: the party balance the credit-control trigger and creditStatus() both read. Base currency, '
  'posted rows only, on the party''s own receivable control account (§4.15 1200 by default); a NULL date is no '
  'date cut. Raises ERR_POLICY_REQUIRES_MISSING when a party carries a limit and no control account — SAH-042, '
  'never a silent 0.';

create or replace function app.party_credit_exposure(p_party_id uuid, p_excluding_document_id uuid) returns numeric
language sql stable as $$
  select app.party_open_balance(p_party_id, null)
       + coalesce((
           select sum(app.document_base_total(d.id, d.exchange_rate))
             from app.document d
            where d.party_id = p_party_id
              and d.status = 'issued'
              and d.id is distinct from p_excluding_document_id
              and app.policy_extends_credit(app.effective_policy(d.document_type_id, d.effective_date))),
           0)::numeric(19,4)
$$;
comment on function app.party_credit_exposure(uuid, uuid) is
  'contracts §4.8.1 (Phase 4 review A6): the figure credit control compares — posted receivable balance with no '
  'date cut, plus the party''s other issued-but-unposted credit-extending documents (app.policy_extends_credit), '
  'in base.';

create or replace view app.document_open_quantity with (security_invoker = true) as
select l.tenant_id,
       l.company_id,
       l.document_id,
       l.id                                                   as document_line_id,
       l.line_no,
       l.item_id,
       l.quantity                                             as ordered_quantity,
       coalesce(k.linked, 0)::numeric(19,6)                    as linked_quantity,
       (l.quantity - coalesce(k.linked, 0))::numeric(19,6)     as open_quantity
  from app.document_line l
  join app.document d on d.id = l.document_id
  left join lateral (
         select sum(x.quantity) as linked
           from app.document_link x
           join app.document t on t.id = x.target_document_id
          where x.source_line_id = l.id
            and (t.status not in ('void', 'reversed')      -- a voided fulfilment releases its quantity;
                 or (t.status = 'reversed'                 -- a reversed one only while its chain nets
                     and app.document_claim_stands(t.id)))
       ) k on true
 where l.quantity is not null
   and d.status not in ('void', 'reversed');                  -- a voided order has no open quantity

-- The replace keeps the view's privileges; 0037's revoke is restated so this file states the whole surface.
revoke insert, update on app.document_open_quantity from app_rw;

create or replace function app.assert_document_link_within_open_quantity() returns trigger language plpgsql as $$
declare
  v_ordered        numeric(19,6);
  v_linked         numeric(19,6);
  v_source         app.document_status;
  v_target         app.document_status;
  v_source_company uuid;
  v_target_company uuid;
begin
  select d.status, d.company_id into v_target, v_target_company
    from app.document d where d.id = new.target_document_id;
  if v_target is null or v_target_company is distinct from new.company_id then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: target document % is not visible', new.target_document_id
      using errcode = 'check_violation';
  end if;
  if v_target <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is % — a fulfilment link is recorded on a draft', new.target_document_id, v_target
      using errcode = 'check_violation';
  end if;
  select d.status, d.company_id into v_source, v_source_company
    from app.document d where d.id = new.source_document_id;
  if v_source is null or v_source_company is distinct from new.company_id then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: source document % is not visible', new.source_document_id
      using errcode = 'check_violation';
  end if;
  if v_source not in ('issued', 'posted') then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: source document % is % — only an issued or posted document can be fulfilled',
      new.source_document_id, v_source
      using errcode = 'check_violation';
  end if;

  -- 0109, narrowed by 0110: each line is a line OF the document it is paired with. Company is already
  -- proved above, on the documents. The table's `(source_line_id is null) = (target_line_id is null)`
  -- CHECK makes the pair total, so testing one for null tests both.
  if new.source_line_id is not null then
    perform 1 from app.document_line l
     where l.id = new.source_line_id and l.document_id = new.source_document_id;
    if not found then
      raise exception 'ERR_VALIDATION_FAILED: source line % is not a line of document %',
        new.source_line_id, new.source_document_id using errcode = 'check_violation';
    end if;
    perform 1 from app.document_line l
     where l.id = new.target_line_id and l.document_id = new.target_document_id;
    if not found then
      raise exception 'ERR_VALIDATION_FAILED: target line % is not a line of document %',
        new.target_line_id, new.target_document_id using errcode = 'check_violation';
    end if;
  end if;

  if new.source_line_id is null or new.quantity is null then
    return new;                                               -- a header-only or amount-only link has no quantity to bound
  end if;

  -- SAH-017's concurrency face — lock the SOURCE LINE, then read, correct at READ COMMITTED because each
  -- statement takes a fresh snapshot (3a:5719-5727 applied to this table; 0037's comment has the argument).
  perform pg_advisory_xact_lock(hashtextextended('document_link:' || new.source_line_id::text, 0));

  select l.quantity into v_ordered from app.document_line l where l.id = new.source_line_id;
  if v_ordered is null then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % carries no quantity to fulfil', new.source_line_id
      using errcode = 'check_violation';
  end if;
  -- 0116: the view's rule, word for word — a reversed fulfilment still holds its quantity while its reversal
  -- chain has a live even-depth end (app.document_claim_stands).
  select coalesce(sum(x.quantity), 0) into v_linked
    from app.document_link x
    join app.document t on t.id = x.target_document_id
   where x.source_line_id = new.source_line_id
     and (t.status not in ('void', 'reversed')
          or (t.status = 'reversed' and app.document_claim_stands(t.id)))
     and x.id <> new.id;
  if v_linked + new.quantity > v_ordered then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % has % open of % ordered; % requested',
      new.source_line_id, v_ordered - v_linked, v_ordered, new.quantity
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function app.assert_reinstated_claim_within_open_quantity() returns trigger language plpgsql as $$
declare
  v_claim  record;
  v_linked numeric(19,6);
  v_how    text := case when tg_op = 'INSERT' then 'drafting document'
                        when new.status = 'reversed' and old.status <> 'reversed' then 'reversing document'
                        else 're-pointing reverses_document_id of document' end;
  v_source record;
begin
  -- The source-status bound (code review 4), for a reinstated `returns` claim.
  select x.source_document_id, sd.status, up.id as claimant into v_source
    from app.document_chain_ancestors(new.id) up (id)
    join app.document_link x on x.target_document_id = up.id and x.link_kind = 'returns'
    join app.document sd on sd.id = x.source_document_id
   where sd.status in ('reversed', 'void')
     and app.document_claim_stands(up.id)
   order by up.id, x.source_document_id
   limit 1;
  if found then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: % % reinstates the returns claim of document % against source document %, which is % — a return stands only against an issued or posted document',
      v_how, new.id, v_source.claimant, v_source.source_document_id, v_source.status
      using errcode = 'check_violation';
  end if;

  for v_claim in
    select distinct on (x.source_line_id)
           x.source_line_id, x.target_document_id, sl.quantity::numeric(19,6) as ordered
      from app.document_chain_ancestors(new.id) up (id)
      join app.document_link x on x.target_document_id = up.id and x.quantity is not null
      join app.document_line sl on sl.id = x.source_line_id
     where app.document_claim_stands(up.id)
     order by x.source_line_id, x.target_document_id
  loop
    -- Lock, then read: this statement's fresh snapshot sees a link committed while the lock was waited on.
    perform pg_advisory_xact_lock(hashtextextended('document_link:' || v_claim.source_line_id::text, 0));
    select coalesce(sum(x.quantity), 0) into v_linked
      from app.document_link x
      join app.document t on t.id = x.target_document_id
     where x.source_line_id = v_claim.source_line_id
       and (t.status not in ('void', 'reversed')
            or (t.status = 'reversed' and app.document_claim_stands(t.id)));
    if v_linked > v_claim.ordered then
      raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % would carry % linked against % ordered: % % reinstates the claim of document %, and that quantity has since been fulfilled again — void or reverse the later fulfilment first',
        v_claim.source_line_id, v_linked, v_claim.ordered, v_how, new.id, v_claim.target_document_id
        using errcode = 'check_violation';
    end if;
  end loop;
  return null;                                       -- row-level AFTER triggers ignore the return value
end;
$$;
comment on function app.assert_reinstated_claim_within_open_quantity() is
  'Code review 3 (R9): when a change of a reversal chain reinstates a fulfilment''s claim — a flip to reversed '
  '(the reversal of its reversal), or a document drafted or re-pointed under a reversed member — re-checks each '
  'source line it is linked against under the link guard''s advisory lock (ERR_DOC_LINK_OVER_FULFILLED), and '
  'refuses a reinstated returns claim whose source is reversed or void (ERR_DOC_STATUS_ILLEGAL, code review 4).';

create or replace function app.assert_payment_term_days_unpinned() returns trigger language plpgsql as $$
begin
  if (new.due_days, new.discount_days, new.discount_pct)
       is not distinct from (old.due_days, old.discount_days, old.discount_pct) then
    return new;
  end if;
  if exists (select 1 from app.document d where d.payment_term_id = old.id and d.status <> 'draft') then
    raise exception
      'ERR_CONFLICT_REFERENCE: payment term % is pinned on a document that is no longer a draft; its days and '
      'discount are what that document is aged on (SAH-013) — create a new term instead', old.code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.assert_payment_term_days_unpinned() is
  'Phase 4 review A8, SAH-013: refuses changing due_days, discount_days or discount_pct of a payment term that '
  'a non-draft document pins (ERR_CONFLICT_REFERENCE).';

create or replace function app.assert_party_control_unchanged() returns trigger language plpgsql as $$
begin
  if new.receivable_account_id is not distinct from old.receivable_account_id
     and new.payable_account_id is not distinct from old.payable_account_id then
    return new;
  end if;
  if exists (select 1 from app.document d
              where d.party_id = old.id and d.status in ('posted', 'reversed')) then
    raise exception
      'ERR_CONFLICT_REFERENCE: party % has posted documents; their ledger rows, ageing and allocations are read '
      'on its control account, which therefore cannot change — open a new party instead', old.code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.assert_party_control_unchanged() is
  'Phase 4 review B1: refuses changing party.receivable_account_id / payable_account_id once a document of '
  'the party has posted (ERR_CONFLICT_REFERENCE).';

drop function app.party_company_open_balance(uuid, uuid, date);
drop function app.party_company_pending_credit(uuid, uuid, uuid);
drop function app.source_line_linked_quantity(uuid, uuid, uuid);
drop function app.party_has_posted_document(uuid, uuid);
drop function app.payment_term_is_pinned(uuid, uuid);
drop function app.actor_live_in_company(uuid);

revoke execute on function app.document_claim_stands(uuid) from app_auth;
revoke select (id, tenant_id, company_id, source_document_id, source_line_id, target_document_id, link_kind,
               quantity) on app.document_link from app_auth;
revoke select (tenant_id, document_type_id, version, effective_from, definition) on app.posting_policy from app_auth;
revoke select (id, tenant_id, company_id, receivable_account_id) on app.party from app_auth;
revoke select (tenant_id, document_id, account_id, base_debit, base_credit) on app.ledger_entry from app_auth;
revoke select (id, tenant_id, company_id, document_id, kind, amount, total_incl_tax) on app.document_line from app_auth;
revoke select (id, tenant_id, company_id, party_id, status, effective_date, exchange_rate, document_type_id,
               reverses_document_id, payment_term_id) on app.document from app_auth;

drop policy branch_isolation on app.document;
create policy branch_isolation on app.document as restrictive
  using (app.actor_in_branch(company_id, branch_id)
         or (status = 'posted'
             and exists (select 1 from app.warehouse w
                          where w.tenant_id = document.tenant_id and w.company_id = document.company_id
                            and w.id = document.to_warehouse_id and w.kind = 'in_transit'
                            and app.actor_in_branch(w.company_id, w.branch_id))))
  with check (app.actor_in_branch(company_id, branch_id));

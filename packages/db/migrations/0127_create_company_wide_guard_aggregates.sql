-- 0127_create_company_wide_guard_aggregates.sql — ADR 0095 (Proposed): company-wide guard aggregates under
-- branch isolation. Full review 2026-11-15, findings DBS-04 (high), DBS-07 = INV-08 (medium) and DBS-18 (low).
-- Not a slice: the number is the orchestrator's allocation under Plan Contracts §3.4.1's tail rule.
--
-- Five data-layer guards sum or test rows across a whole COMPANY, but ran as SECURITY INVOKER and read
-- app.document under the caller's RLS. 0068's RESTRICTIVE branch_isolation (0119's Form A) hides every other
-- branch's documents from a principal restricted to some branches, so for that principal each guard answered
-- over their own branches only:
--   - credit control (0045, 0061): a clerk restricted to branch BRB issued 900 to a customer with a limit of
--     1,000 and 900 already issued at HQ — exposure 1,800, no override asked (DBS-04);
--   - the over-fulfilment guard and app.document_open_quantity (0037 → 0116): a principal restricted to the
--     source's branch did not see a fulfilment drafted in another branch and linked the same quantity again —
--     LEGACY-017's control bypassed (DBS-07 = INV-08);
--   - the payment-term and party-control "pinned" guards (0045 §4a, §4b): a document at another branch did not
--     pin the term or the control account (DBS-18).
--
-- The fix is the 0068 / 0119 / 0090 pattern: one narrowly scoped lookup per question, `app_auth`-owned
-- SECURITY DEFINER (app_auth has no LOGIN and no BYPASSRLS; tenant_isolation still applies inside), bound
-- explicitly to the current tenant and to the company the caller names, answered only to a principal with a
-- live role in that company (or the tenant's system principal, as app.actor_in_branch admits it), and
-- returning one aggregate — a base total, a quantity or a boolean — never a row. None is a policy predicate.
-- The guards and the view keep their names, signatures and errors; only the cross-branch read moves into the
-- lookup. For app_auth to see other branches' documents, `branch_isolation` on app.document is scoped
-- `to app_rw, app_migrator` (0119 did the same on app.warehouse, 0090 on compensation_gate); its predicate is
-- 0119's, unchanged, so nothing changes for any role that can log in.

-- ── 0. who may ask: a live role in the company, or the tenant's system principal ────────────────────────
create function app.actor_live_in_company(p_company_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from app.principal p join app.membership m on m.principal_id = p.id
                  where p.id = app.current_actor() and p.kind = 'system' and m.tenant_id = app.current_tenant())
      or exists (select 1 from app.role_assignment ra
                  where ra.tenant_id = app.current_tenant() and ra.principal_id = app.current_actor()
                    and ra.company_id = p_company_id and (ra.expires_at is null or ra.expires_at > now()))
$$;
comment on function app.actor_live_in_company(uuid) is
  'ADR 0095: true when the current actor holds a live (unexpired) role assignment in the company, whatever its '
  'branch restriction, or is the tenant''s system principal — app.actor_in_branch without the branch clause. '
  'Asked by the 0127 lookups before they answer.';
revoke all on function app.actor_live_in_company(uuid) from public;
grant execute on function app.actor_live_in_company(uuid) to app_auth;

-- ── 1. app_auth reads documents of every branch (and nothing else gains) ────────────────────────────────
drop policy branch_isolation on app.document;
create policy branch_isolation on app.document as restrictive to app_rw, app_migrator
  using (app.actor_in_branch(company_id, branch_id)
         or (status = 'posted'
             and exists (select 1 from app.warehouse w
                          where w.tenant_id = document.tenant_id and w.company_id = document.company_id
                            and w.id = document.to_warehouse_id and w.kind = 'in_transit'
                            and app.actor_in_branch(w.company_id, w.branch_id))))
  with check (app.actor_in_branch(company_id, branch_id));

-- Column grants: exactly what the five lookups and the invoker helpers they call read.
grant select (id, tenant_id, company_id, party_id, status, effective_date, exchange_rate, document_type_id,
              reverses_document_id, payment_term_id) on app.document to app_auth;
grant select (id, tenant_id, company_id, document_id, kind, amount, total_incl_tax) on app.document_line to app_auth;
grant select (tenant_id, document_id, account_id, base_debit, base_credit) on app.ledger_entry to app_auth;
grant select (id, tenant_id, company_id, receivable_account_id) on app.party to app_auth;
grant select (tenant_id, document_type_id, version, effective_from, definition) on app.posting_policy to app_auth;
grant select (id, tenant_id, company_id, source_document_id, source_line_id, target_document_id, link_kind,
              quantity) on app.document_link to app_auth;
grant execute on function app.document_claim_stands(uuid) to app_auth;

-- ── 2. the five lookups ─────────────────────────────────────────────────────────────────────────────────
-- (a) DBS-04: the party's POSTED receivable balance in base, on the party's own receivable control account
--     (read here, never supplied by the caller), every branch of the company.
create function app.party_company_open_balance(p_company_id uuid, p_party_id uuid, p_as_of date) returns numeric
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  v_account_id uuid;
begin
  if not app.actor_live_in_company(p_company_id) then
    raise exception 'ERR_NOT_FOUND: company % is not visible', p_company_id using errcode = 'check_violation';
  end if;
  select p.receivable_account_id into v_account_id
    from app.party p
   where p.tenant_id = app.current_tenant() and p.company_id = p_company_id and p.id = p_party_id;
  if v_account_id is null then return 0::numeric(19,4); end if;
  return (
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)
      from app.ledger_entry l
      join app.document     d on d.tenant_id = l.tenant_id and d.id = l.document_id
     where l.tenant_id = app.current_tenant()
       and d.company_id = p_company_id
       and d.party_id = p_party_id
       and (p_as_of is null or d.effective_date <= p_as_of)
       and l.account_id = v_account_id);
end $$;
comment on function app.party_company_open_balance(uuid, uuid, date) is
  'ADR 0095 (DBS-04): one base total — the party''s posted balance on its own receivable control account, over '
  'every branch of the company, for app.party_open_balance. Tenant- and company-bound, answered only to a live '
  'role in the company (else ERR_NOT_FOUND); app_auth-owned SECURITY DEFINER, never a policy predicate.';

-- (b) DBS-04: the party's other issued-but-unposted credit-extending documents, in base, every branch.
create function app.party_company_pending_credit(p_company_id uuid, p_party_id uuid,
                                                 p_excluding_document_id uuid) returns numeric
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if not app.actor_live_in_company(p_company_id) then
    raise exception 'ERR_NOT_FOUND: company % is not visible', p_company_id using errcode = 'check_violation';
  end if;
  return coalesce((
    select sum(app.document_base_total(d.id, d.exchange_rate))
      from app.document d
     where d.tenant_id = app.current_tenant()
       and d.company_id = p_company_id
       and d.party_id = p_party_id
       and d.status = 'issued'
       and d.id is distinct from p_excluding_document_id
       and app.policy_extends_credit(app.effective_policy(d.document_type_id, d.effective_date))),
    0)::numeric(19,4);
end $$;
comment on function app.party_company_pending_credit(uuid, uuid, uuid) is
  'ADR 0095 (DBS-04): one base total — the party''s issued, unposted, credit-extending documents other than the '
  'one named, over every branch of the company, for app.party_credit_exposure. Tenant- and company-bound, '
  'answered only to a live role in the company (else ERR_NOT_FOUND); app_auth-owned SECURITY DEFINER.';

-- (c) DBS-07 = INV-08: the quantity linked against one source line, every branch — 0116's rule word for word
--     (a voided fulfilment releases its quantity; a reversed one holds it while its chain has a live
--     even-depth end), optionally excluding one link (the guard's own row).
create function app.source_line_linked_quantity(p_company_id uuid, p_source_line_id uuid,
                                                p_excluding_link_id uuid) returns numeric
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if not app.actor_live_in_company(p_company_id) then
    raise exception 'ERR_NOT_FOUND: company % is not visible', p_company_id using errcode = 'check_violation';
  end if;
  return (
    select coalesce(sum(x.quantity), 0)::numeric(19,6)
      from app.document_link x
      join app.document t on t.tenant_id = x.tenant_id and t.id = x.target_document_id
     where x.tenant_id = app.current_tenant()
       and x.company_id = p_company_id
       and x.source_line_id = p_source_line_id
       and (t.status not in ('void', 'reversed')
            or (t.status = 'reversed' and app.document_claim_stands(t.id)))
       and x.id is distinct from p_excluding_link_id);
end $$;
comment on function app.source_line_linked_quantity(uuid, uuid, uuid) is
  'ADR 0095 (DBS-07, INV-08): one quantity — the sum of standing links against a source line, over every branch '
  'of the company, for the over-fulfilment guards (LEGACY-017) and app.document_open_quantity. Tenant- and '
  'company-bound, answered only to a live role in the company (else ERR_NOT_FOUND); app_auth-owned SECURITY '
  'DEFINER, never a policy predicate.';

-- (d) DBS-18: has any document of the party, in any branch, posted (or been reversed after posting)?
create function app.party_has_posted_document(p_company_id uuid, p_party_id uuid) returns boolean
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if not app.actor_live_in_company(p_company_id) then
    raise exception 'ERR_NOT_FOUND: company % is not visible', p_company_id using errcode = 'check_violation';
  end if;
  return exists (select 1 from app.document d
                  where d.tenant_id = app.current_tenant() and d.company_id = p_company_id
                    and d.party_id = p_party_id and d.status in ('posted', 'reversed'));
end $$;
comment on function app.party_has_posted_document(uuid, uuid) is
  'ADR 0095 (DBS-18): one boolean — whether a document of the party has posted, in any branch of the company, for '
  'app.assert_party_control_unchanged. Tenant- and company-bound, answered only to a live role in the company '
  '(else ERR_NOT_FOUND); app_auth-owned SECURITY DEFINER.';

-- (e) DBS-18: does any non-draft document, in any branch, pin the payment term?
create function app.payment_term_is_pinned(p_company_id uuid, p_payment_term_id uuid) returns boolean
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if not app.actor_live_in_company(p_company_id) then
    raise exception 'ERR_NOT_FOUND: company % is not visible', p_company_id using errcode = 'check_violation';
  end if;
  return exists (select 1 from app.document d
                  where d.tenant_id = app.current_tenant() and d.company_id = p_company_id
                    and d.payment_term_id = p_payment_term_id and d.status <> 'draft');
end $$;
comment on function app.payment_term_is_pinned(uuid, uuid) is
  'ADR 0095 (DBS-18): one boolean — whether a non-draft document in any branch of the company pins the payment '
  'term, for app.assert_payment_term_days_unpinned. Tenant- and company-bound, answered only to a live role in '
  'the company (else ERR_NOT_FOUND); app_auth-owned SECURITY DEFINER.';

revoke all on function app.party_company_open_balance(uuid, uuid, date) from public;
revoke all on function app.party_company_pending_credit(uuid, uuid, uuid) from public;
revoke all on function app.source_line_linked_quantity(uuid, uuid, uuid) from public;
revoke all on function app.party_has_posted_document(uuid, uuid) from public;
revoke all on function app.payment_term_is_pinned(uuid, uuid) from public;
grant execute on function app.party_company_open_balance(uuid, uuid, date) to app_rw;
grant execute on function app.party_company_pending_credit(uuid, uuid, uuid) to app_rw;
grant execute on function app.source_line_linked_quantity(uuid, uuid, uuid) to app_rw;
grant execute on function app.party_has_posted_document(uuid, uuid) to app_rw;
grant execute on function app.payment_term_is_pinned(uuid, uuid) to app_rw;
grant create on schema app to app_auth;
alter function app.party_company_open_balance(uuid, uuid, date) owner to app_auth;
alter function app.party_company_pending_credit(uuid, uuid, uuid) owner to app_auth;
alter function app.source_line_linked_quantity(uuid, uuid, uuid) owner to app_auth;
alter function app.party_has_posted_document(uuid, uuid) owner to app_auth;
alter function app.payment_term_is_pinned(uuid, uuid) owner to app_auth;
revoke create on schema app from app_auth;

-- ── 3. the guards call them (bodies otherwise as 0045 / 0116 wrote them) ─────────────────────────────────

create or replace function app.party_open_balance(p_party_id uuid, p_as_of date) returns numeric
language plpgsql stable as $$
declare
  v_account_id uuid;
  v_limit      numeric(19,4);
  v_found      boolean;
  v_company_id uuid;
begin
  select true, p.receivable_account_id, p.credit_limit, p.company_id
    into v_found, v_account_id, v_limit, v_company_id
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
  -- coalesce at the accumulation boundary (LEGACY-011): a party with no posted row owes 0, never NULL.
  -- 0127 (ADR 0095, DBS-04): every branch of the company, through the bounded lookup.
  return app.party_company_open_balance(v_company_id, p_party_id, p_as_of);
end $$;
comment on function app.party_open_balance(uuid, date) is
  'contracts §4.8.1: the party balance the credit-control trigger and creditStatus() both read. Base currency, '
  'posted rows only, on the party''s own receivable control account (§4.15 1200 by default); a NULL date is no '
  'date cut. Raises ERR_POLICY_REQUIRES_MISSING when a party carries a limit and no control account — LEGACY-042, '
  'never a silent 0.';

create or replace function app.party_credit_exposure(p_party_id uuid, p_excluding_document_id uuid) returns numeric
language sql stable as $$
  select app.party_open_balance(p_party_id, null)
       -- 0127 (ADR 0095, DBS-04): every branch of the company, through the bounded lookup.
       + app.party_company_pending_credit(
           (select p.company_id from app.party p where p.id = p_party_id), p_party_id, p_excluding_document_id)
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
       k.linked                                               as linked_quantity,
       (l.quantity - k.linked)::numeric(19,6)                 as open_quantity
  from app.document_line l
  join app.document d on d.id = l.document_id
  -- 0127 (ADR 0095): the sum is company-wide whatever the reader's branches — 0116's rule, in the lookup.
  cross join lateral (
         select app.source_line_linked_quantity(l.company_id, l.id, null)::numeric(19,6) as linked
       ) k
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

  -- LEGACY-017's concurrency face — lock the SOURCE LINE, then read, correct at READ COMMITTED because each
  -- statement takes a fresh snapshot (3a:5719-5727 applied to this table; 0037's comment has the argument).
  perform pg_advisory_xact_lock(hashtextextended('document_link:' || new.source_line_id::text, 0));

  select l.quantity into v_ordered from app.document_line l where l.id = new.source_line_id;
  if v_ordered is null then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % carries no quantity to fulfil', new.source_line_id
      using errcode = 'check_violation';
  end if;
  -- 0116: the view's rule, word for word — a reversed fulfilment still holds its quantity while its reversal
  -- chain has a live even-depth end (app.document_claim_stands).
  -- 0127 (ADR 0095, DBS-07): summed over every branch of the company, not the caller's branches.
  v_linked := app.source_line_linked_quantity(new.company_id, new.source_line_id, new.id);
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
    -- 0127 (ADR 0095, DBS-07): summed over every branch of the company, not the caller's branches.
    v_linked := app.source_line_linked_quantity(new.company_id, v_claim.source_line_id, null);
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
  -- 0127 (ADR 0095, DBS-18): any branch of the company, through the bounded lookup.
  if app.payment_term_is_pinned(old.company_id, old.id) then
    raise exception
      'ERR_CONFLICT_REFERENCE: payment term % is pinned on a document that is no longer a draft; its days and '
      'discount are what that document is aged on (LEGACY-013) — create a new term instead', old.code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.assert_payment_term_days_unpinned() is
  'Phase 4 review A8, LEGACY-013: refuses changing due_days, discount_days or discount_pct of a payment term that '
  'a non-draft document pins (ERR_CONFLICT_REFERENCE).';

create or replace function app.assert_party_control_unchanged() returns trigger language plpgsql as $$
begin
  if new.receivable_account_id is not distinct from old.receivable_account_id
     and new.payable_account_id is not distinct from old.payable_account_id then
    return new;
  end if;
  -- 0127 (ADR 0095, DBS-18): any branch of the company, through the bounded lookup.
  if app.party_has_posted_document(old.company_id, old.id) then
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

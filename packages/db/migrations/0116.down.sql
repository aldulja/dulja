-- ── 0116 down ──────────────────────────────────────────────────────────────────────────────────────────
-- Drops §4's triggers and functions, restores 0037's view body and 0110's body of
-- app.assert_document_link_within_open_quantity(), then drops app.document_claim_stands (the view must stop
-- depending on it first). Down-migrating this reopens the gap 0116 closed: a reinstated fulfilment (the
-- reversal of its reversal) no longer holds its quantity, so the view overstates the open quantity, the guard
-- links against units already out, and a reversal (or a drafted chain member) that reinstates a claim is
-- checked against nothing.

-- §4 first: the triggers and their function read app.document_claim_stands.
drop trigger if exists document_reinstated_claim_on_insert_within_open_quantity on app.document;
drop trigger if exists document_reinstated_claim_within_open_quantity on app.document;
drop function if exists app.assert_reinstated_claim_within_open_quantity();
drop function if exists app.document_chain_ancestors(uuid);

-- 0037's view, verbatim. CREATE OR REPLACE keeps the privileges; 0037's revoke is restated regardless.
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
            and t.status not in ('void', 'reversed')          -- a voided or reversed fulfilment releases its quantity
       ) k on true
 where l.quantity is not null
   and d.status not in ('void', 'reversed');                  -- a voided order has no open quantity

revoke insert, update on app.document_open_quantity from app_rw;

-- 0110's function body, verbatim.
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
  select coalesce(sum(x.quantity), 0) into v_linked
    from app.document_link x
    join app.document t on t.id = x.target_document_id
   where x.source_line_id = new.source_line_id
     and t.status not in ('void', 'reversed')
     and x.id <> new.id;
  if v_linked + new.quantity > v_ordered then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % has % open of % ordered; % requested',
      new.source_line_id, v_ordered - v_linked, v_ordered, new.quantity
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop function if exists app.document_claim_stands(uuid);

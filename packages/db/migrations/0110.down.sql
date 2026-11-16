-- Restores 0109's body of app.assert_document_link_within_open_quantity(): line ownership checked, the
-- two documents NOT bound to the link's company. Down-migrating this reopens the header-only-link hole
-- 0110 closes, and says so. The trigger is untouched; only the function body changes.
create or replace function app.assert_document_link_within_open_quantity() returns trigger language plpgsql as $$
declare
  v_ordered numeric(19,6);
  v_linked  numeric(19,6);
  v_source  app.document_status;
  v_target  app.document_status;
begin
  -- The three rules live here, not in TypeScript: packages/db may not import AppError and PostingError's code
  -- union is frozen (contracts §4.2.4), and spec:2173 wants the data layer to be the control in any case.
  select d.status into v_target from app.document d where d.id = new.target_document_id;
  if v_target is null then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: target document % is not visible', new.target_document_id
      using errcode = 'check_violation';
  end if;
  if v_target <> 'draft' then
    raise exception 'ERR_DOC_NOT_DRAFT: document % is % — a fulfilment link is recorded on a draft', new.target_document_id, v_target
      using errcode = 'check_violation';
  end if;
  select d.status into v_source from app.document d where d.id = new.source_document_id;
  if v_source is null or v_source not in ('issued', 'posted') then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: source document % is % — only an issued or posted document can be fulfilled',
      new.source_document_id, coalesce(v_source::text, 'not visible')
      using errcode = 'check_violation';
  end if;

  -- 0109: each line id must be a line OF the document it is paired with, and of this link's company.
  -- Checked before the early return below, so a header-only link cannot smuggle a target line either:
  -- the table's `(source_line_id is null) = (target_line_id is null)` CHECK makes the pair total, so
  -- testing source_line_id for null tests both.
  if new.source_line_id is not null then
    perform 1 from app.document_line l
     where l.id = new.source_line_id
       and l.document_id = new.source_document_id
       and l.company_id = new.company_id;
    if not found then
      raise exception 'ERR_VALIDATION_FAILED: source line % is not a line of document % in company %',
        new.source_line_id, new.source_document_id, new.company_id
        using errcode = 'check_violation';
    end if;
    perform 1 from app.document_line l
     where l.id = new.target_line_id
       and l.document_id = new.target_document_id
       and l.company_id = new.company_id;
    if not found then
      raise exception 'ERR_VALIDATION_FAILED: target line % is not a line of document % in company %',
        new.target_line_id, new.target_document_id, new.company_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.source_line_id is null or new.quantity is null then
    return new;                                               -- a header-only or amount-only link has no quantity to bound
  end if;

  -- SAH-017's concurrency face, and it is NOT closed by the read below on its own. `withTenant` runs at READ
  -- COMMITTED (§4.2.2; 3a:68), so without this lock two transactions each linking 6 against a 10-unit order
  -- line both read v_linked = 0, both satisfy the test, and both commit — 12 linked against 10 ordered, with
  -- no bypass and no override event. This is verbatim the class 3A found in its own step-9 guard and fixed
  -- the same way (`lockStockKeys`, 3a:5719-5727): lock the key, THEN read, which is correct precisely because
  -- each statement takes a fresh snapshot at READ COMMITTED. The key is the SOURCE LINE, because that is what
  -- the sum is over; `linkFulfilment` sorts its input by `sourceLineId` so two multi-line links can never
  -- take two locks in opposite orders.
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
     and x.id <> new.id;                                      -- the row's own default id is already set on INSERT
  if v_linked + new.quantity > v_ordered then
    raise exception 'ERR_DOC_LINK_OVER_FULFILLED: source line % has % open of % ordered; % requested',
      new.source_line_id, v_ordered - v_linked, v_ordered, new.quantity
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Restores 0037's body of app.assert_document_link_within_open_quantity() — the same function WITHOUT
-- the two line-ownership checks. The trigger itself is not dropped or recreated: 0109 only replaced the
-- function body, and `create or replace function` leaves every attached trigger pointing at it.
--
-- Down-migrating this REOPENS the cross-company hole 0109 closes. That is what a down migration is for
-- and it is stated rather than hidden: the operator who runs it is putting 0037's behaviour back.
create or replace function app.assert_document_link_within_open_quantity() returns trigger language plpgsql as $$
declare
  v_ordered numeric(19,6);
  v_linked  numeric(19,6);
  v_source  app.document_status;
  v_target  app.document_status;
begin
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
  if new.source_line_id is null or new.quantity is null then
    return new;
  end if;
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

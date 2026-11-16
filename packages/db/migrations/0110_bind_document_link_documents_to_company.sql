-- ── 0110 · a document_link's two DOCUMENTS must belong to the link's company ────────────────────
-- Phase 3 review pass, PR #6; allocated from the §3.4.1 tail (the register row names 0109–0112).
--
-- 0109 bound the two LINE ids to their documents and to new.company_id — but only inside the branch that
-- runs when source_line_id is not null. A HEADER-ONLY link (the `settles` / amount-only shape 4A will use,
-- and anything app_rw inserts directly) skipped that branch entirely, so a link with company_id = A,
-- target = A's draft and source = company B's issued document still passed every check in the function.
-- And even for line links, 0109 compared against document_line.company_id, a column nothing binds to its
-- document's company; the invariant rested on the application having set that column correctly.
--
-- The check belongs on the two reads the function ALREADY performs. Both `select d.status …` become
-- `select d.status, d.company_id …` and each asserts `d.company_id = new.company_id`. That covers every
-- link shape, and the 0109 line checks then need only `l.document_id = new.<x>_document_id` — a line
-- belongs to its document, and the document has just been proved to belong to the company.
--
-- The tokens are ERR_DOC_STATUS_ILLEGAL, the one the function already uses for "a document the caller may
-- not see": a document of another company is not confirmed to exist, and 0B's rule is 404-shaped never
-- 403-shaped for such an id. A foreign LINE id stays ERR_VALIDATION_FAILED — it is a malformed body, not a
-- document the caller cannot see — and the route now declares that 400.

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

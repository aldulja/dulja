-- ── 0116 · open quantity follows a fulfilment's reversal chain, not its own status ─────────────────────
-- Phase 4 code-review pass 3 (not a slice); number registered in Plan Contracts §3.4.1's tail.
--
-- 0037 released a fulfilment's claim on its source line as soon as the fulfilment read 'void' or 'reversed',
-- in two places that must agree: the app.document_open_quantity view and the over-fulfilment guard
-- app.assert_document_link_within_open_quantity() (0037, rewritten by 0109 and 0110). A 'reversed' document
-- has released its claim only while its reversal chain NETS. A PURCHASE_RETURN reverses into a
-- PURCHASE_RETURN, so reversing the return (R1, depth 1) gives its units back, but reversing R1 (R2, depth
-- 2 — 0048's "an ordinary live document of its kind") takes them out again while the return itself still
-- reads 'reversed'. Both readers then showed GR1's ten units open while three were out with the vendor, and
-- the guard linked a second return against the quantity R2 had already taken (SAH-017's over-fulfilment,
-- by the chain instead of by a race). reverseDocument's full-reversal guard was fixed for the same chain in
-- code review 2 (packages/db/src/posting/reverse.ts, F1); this is the data layer's half.
--
-- The rule, stated once in app.document_claim_stands below and read by both: a document's claim stands while
-- the document, or a member of its full-reversal chain at EVEN depth, is live (not void, not reversed). The
-- chain is walked down by 0048's hop rule (app.document_reversal_depth): through 'reversed' members only,
-- never through a `returns`-linked partial credit of a member. A void document never holds a claim; a
-- draft, submitted, approved, issued or posted one always does, as before; a reversed one does exactly when
-- its chain has a live even-depth end. It applies to every link kind the view sums — a reinstated receipt
-- (`receives_against`) has received the order's goods again just as a reinstated return has returned them.
--
-- A claim that comes back is bounded too (§4). The link guard fires only on app.document_link, so a claim
-- that returns by a status flip — reversing R1 makes the return's chain stand again — met no check at all: link
-- a second return of 8 against GR1 while the first return's 3 were released, then reverse R1, and GR1 read 11
-- returned against 10 received. AFTER triggers on app.document now re-check, under the same per-source-line
-- advisory lock the link guard takes, every source line whose claim a change of the chain reinstates — and,
-- for a reinstated `returns` claim, the source's status as well, the guard's other bound (code review 4): a
-- return netted, then its receipt fully reversed (admitted, since the return nets), then the return's reversal
-- reversed, returned the same goods a second time against a receipt that no longer existed. The
-- lock is what closes the race as well: a link and the reinstating reversal each lock the line before they
-- read, so whichever commits second sees the other's work and is refused. A claim stands while its chain has a
-- live member at even depth, so it comes back only when a live member joins the chain: a flip TO 'reversed'
-- (the flipped document's children join its ancestors' chains — reverseDocument's way), or a document drafted
-- or re-pointed with reverses_document_id under a reversed member (no service does that, but app_rw may).
-- Nothing leaves 'void' or 'reversed', every other status change keeps a live member live or removes it, and a
-- deleted draft or a `returns` link only removes members, so no other change needs the check. One residual:
-- app_rw's UPDATE of a `returns` link's kind on a draft target that also points reverses_document_id at the
-- link's source puts that draft back into the source's chain; the link guard bounds the link itself, not that.
--
-- Only a 'reversed' target walks its chain, so an ordinary link costs what it did under 0037. Every consumer
-- of the view keeps its columns: linkFulfilment's openQuantity (packages/db/src/documents/link.ts), the 4A
-- conversions (ar-ap/invoice.ts) and credit notes (ar-ap/credit-note.ts), whose own `done` sums — what the
-- completing conversion or credit takes its residue against — call app.document_claim_stands too.

-- ── 1. the one definition ──────────────────────────────────────────────────────────────────────────────
create function app.document_claim_stands(p_document_id uuid) returns boolean
language sql stable as $$
  with recursive chain (id, status, depth) as (
    select d.id, d.status, 0 from app.document d where d.id = p_document_id and d.status <> 'void'
    union all
    select r.id, r.status, c.depth + 1
      from chain c
      join app.document r on r.reverses_document_id = c.id
     where c.status = 'reversed'
       and not exists (select 1 from app.document_link l
                        where l.source_document_id = c.id and l.target_document_id = r.id
                          and l.link_kind = 'returns')
  )
  select exists (select 1 from chain where chain.status not in ('void', 'reversed') and chain.depth % 2 = 0)
$$;
comment on function app.document_claim_stands(uuid) is
  'Code review 3 (R9): true while the document, or a member of its full-reversal chain at even depth (0048''s '
  'hop rule), is live — not void, not reversed. A fulfilment''s open-quantity claim stands exactly then.';
revoke all on function app.document_claim_stands(uuid) from public;
grant execute on function app.document_claim_stands(uuid) to app_rw;

-- ── 2. the view (0037 §2), same columns, the chain rule for a reversed fulfilment ──────────────────────
-- security_invoker = true is restated because CREATE OR REPLACE VIEW replaces the view's options with the
-- ones it is given; without it the view would run with app_migrator's privileges and read every tenant.
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

-- ── 3. the over-fulfilment guard (0110's body; only the v_linked sum changes) ─────────────────────────
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

-- ── 4. a reinstated claim is bounded as a new link is ───────────────────────────────────────────────────
-- The changed document and every document whose chain passes through it — walked UP reverses_document_id by
-- the same hop rule (0048's app.document_reversal_depth): into a 'reversed' parent, never across a `returns`
-- link — are the only documents whose claim the change can bring back. For each of them that now holds its
-- claim (app.document_claim_stands), two bounds, the link guard's two:
--  - the SOURCE STATUS, for a `returns` claim (code review 4): refused with ERR_DOC_STATUS_ILLEGAL when the
--    document it returns against is 'reversed' or 'void'. A new link needs an issued or posted source, and
--    reverseDocument's partial guard refuses a full reversal of a document while a partial return's claim
--    stands; this is the other order — the source reversed while the return's chain netted, then the return
--    reinstated — which returned the same goods (or credited the same invoice) twice, and which the view hid
--    because it drops a reversed source's lines. `returns` only — the domain of reverseDocument's partial
--    guard: a posted `converts_to` invoice may stand against a reversed delivery by design (reverseDocument
--    admits reversing a delivery whose invoice has posted), and the other kinds are left as they were. Read
--    without a lock, as the link guard reads its source's status;
--  - the QUANTITY: every source line it is linked against is re-summed under that line's advisory lock (the
--    same key the link guard takes; lines in id order, so two such checks queue rather than deadlock) and
--    refused when the sum exceeds the ordered quantity.
-- A change that releases a claim — the ordinary reversal of a live document, an odd-depth end — finds nothing
-- standing and checks nothing; so does reverseDocument's own mirror, drafted under a document that is still
-- posted.
--
-- The walk up is app.document_chain_ancestors, a SQL function shared with reverseDocument, which takes the
-- lines' locks of its STRICT ancestors' claims before its first write (packages/db/src/posting/reverse.ts; the
-- reversed document's own claim cannot stand again, code review 4). It is one recursive CTE over one
-- reversal chain (its depth is the number of reversals), and it runs only for a write that changes a chain —
-- the WHEN clauses below — never for an ordinary write: the shape of 3A's warehouse_no_cycle, one CTE walking up
-- from the changed row, and not SAH-071's recursive procedure per row. It is a function rather than a CTE in the
-- trigger body because SAH-071's regression keeps `with recursive` out of trigger functions by name.
create function app.document_chain_ancestors(p_document_id uuid) returns setof uuid
language sql stable as $$
  with recursive up (id, parent) as (
    select d.id, d.reverses_document_id from app.document d where d.id = p_document_id
    union all
    select o.id, o.reverses_document_id
      from up u
      join app.document o on o.id = u.parent and o.status = 'reversed'
     where not exists (select 1 from app.document_link l
                        where l.source_document_id = o.id and l.target_document_id = u.id
                          and l.link_kind = 'returns')
  )
  select up.id from up
$$;
comment on function app.document_chain_ancestors(uuid) is
  'Code review 3 (R9): the document and every ancestor its full-reversal chain passes through, walked up '
  'reverses_document_id by 0048''s hop rule (into a reversed parent, never across a returns link) — the '
  'documents whose fulfilment claim a change of this document''s chain can bring back.';
revoke all on function app.document_chain_ancestors(uuid) from public;
grant execute on function app.document_chain_ancestors(uuid) to app_rw;

create function app.assert_reinstated_claim_within_open_quantity() returns trigger language plpgsql as $$
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

create trigger document_reinstated_claim_within_open_quantity
  after update of status, reverses_document_id on app.document
  for each row when ((new.status = 'reversed' and old.status is distinct from new.status)
                     or (new.reverses_document_id is not null
                         and new.reverses_document_id is distinct from old.reverses_document_id))
  execute function app.assert_reinstated_claim_within_open_quantity();
create trigger document_reinstated_claim_on_insert_within_open_quantity after insert on app.document
  for each row when (new.reverses_document_id is not null)
  execute function app.assert_reinstated_claim_within_open_quantity();

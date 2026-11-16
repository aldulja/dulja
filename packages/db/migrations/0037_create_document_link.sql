-- 0037_create_document_link.sql
-- Slice 3C. Order ↔ fulfilment links (contracts §4.6.1) and open quantity as a DERIVED VIEW.
-- spec:1050  — sales and purchase orders are non-posting commitment documents with open-quantity tracking.
-- spec:1049  — a GOODS_RECEIPT receives against a PURCHASE_ORDER and prices its GRNI accrual from it.
-- spec:2173  — the data layer is the control: the three rules below are triggers, not TypeScript, so they
--              hold for the API, for a job and for a direct app_rw statement alike.
-- SAH-017    — the old system incremented a delivered-quantity counter in place: it double-added on edit and
--              never reversed on re-pointing. Here the link is a row and the quantity is recomputed on read.
-- SAH-018    — fulfilled and returned quantity is a projection, never a stored column.
-- SAH-049    — an aggregate with no unique key duplicates under an upsert race. There is no aggregate row here
--              at all; the two partial unique indexes below key the LINK, which is the only stored thing.
-- Nothing in this migration writes a per-tenant row (hazard 10): FORCE ROW LEVEL SECURITY binds app_migrator
-- and a migration has no tenant set, so every link row is its route's.

-- ── 1. app.document_link ──────────────────────────────────────────────────────
create table app.document_link (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references app.tenant(id),
  company_id          uuid not null,
  source_document_id  uuid not null,                                   -- the order / the document being fulfilled
  source_line_id      uuid,                                            -- null = a header-only link (no quantity)
  target_document_id  uuid not null,                                   -- the fulfilment / receipt / return
  target_line_id      uuid,
  link_kind           text not null
    check (link_kind in ('fulfils', 'converts_to', 'receives_against', 'returns', 'settles')),
  quantity            numeric(19,6),                                   -- base unit, always positive
  amount              numeric(19,4),                                   -- document currency; used by 4A's 'settles'
  created_at          timestamptz not null default now(),
  check (source_document_id <> target_document_id),                    -- a document never fulfils itself
  check (quantity is null or quantity > 0),                            -- a release is a deleted draft, never a negative link
  check (amount is null or amount >= 0),
  check ((source_line_id is null) = (target_line_id is null)),         -- line-to-line or header-to-header, never mixed
  unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain reference would let tenant A point at tenant B's row.
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  -- Source side: NO ACTION. An order line that has been received against cannot be deleted (SAH-018 in the
  -- opposite direction — losing the order would strand the receipt), and an issued order cannot be deleted anyway.
  foreign key (tenant_id, source_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, source_line_id)     references app.document_line(tenant_id, id),
  -- Target side: ON DELETE CASCADE. Deleting the DRAFT target (or replacing its lines through
  -- PUT …/documents/{id}/lines) releases the open quantity. That is the only release path, because
  -- contracts §3.5.4's DELETE grant list is closed and app_rw holds no DELETE on this table.
  foreign key (tenant_id, target_document_id) references app.document(tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_line_id)     references app.document_line(tenant_id, id) on delete cascade
);

-- One link per (source line, target line, kind); and for header-only links, one per (source doc, target doc, kind).
-- Two partial indexes rather than one constraint, because a UNIQUE constraint treats NULLs as distinct and would
-- admit unlimited duplicate header links (SAH-049's shape).
create unique index document_link_line_pair_key
  on app.document_link (source_line_id, target_line_id, link_kind) where source_line_id is not null;
create unique index document_link_header_pair_key
  on app.document_link (source_document_id, target_document_id, link_kind) where source_line_id is null;
create index document_link_source_line_idx on app.document_link (source_line_id) where source_line_id is not null;
create index document_link_target_document_idx on app.document_link (target_document_id);

call app_meta.enable_tenant_rls('app.document_link');
call app_meta.attach_audit('app.document_link');
-- app_rw receives select, insert, update through default privileges (plan0A). No DELETE: §3.5.4 is closed.

-- ── 2. app.document_open_quantity — the derived view (SAH-017, SAH-018) ───────
-- security_invoker = true is MANDATORY. Without it the view executes with its owner's (app_migrator's)
-- privileges and RLS on both base tables is evaluated for app_migrator, not for the caller — which would make
-- this view a cross-tenant read of every order in the database. With it, tenant_isolation applies as normal.
create view app.document_open_quantity with (security_invoker = true) as
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

-- Plan 0A's `alter default privileges … grant select, insert, update on tables to app_rw` (plan0A:2564)
-- applies to VIEWS too, so without this revoke app_rw would hold INSERT and UPDATE on the one figure this
-- slice exists to keep derived. The view is not auto-updatable (it joins and aggregates), so the grants are
-- inert in practice — but SAH-017's claim is about the privilege surface, and Task 14 asserts the exact list.
revoke insert, update on app.document_open_quantity from app_rw;

-- ── 3. The over-fulfilment guard (the data layer is the control — spec:2173) ──
create function app.assert_document_link_within_open_quantity() returns trigger language plpgsql as $$
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
end $$;

create trigger document_link_open_quantity before insert or update on app.document_link
  for each row execute function app.assert_document_link_within_open_quantity();

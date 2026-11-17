-- 0048_create_party_ageing_item_profitability.sql
-- Slice 4B. The two ASYNCHRONOUS projections spec:1204 names beside stock_valuation: "Asynchronous ones
-- (party_ageing, item_profitability, stock_valuation history) are pg-boss jobs. All of them are rebuilt
-- from ledger_entry/inventory_movement into scratch tables nightly and compared row for row; a mismatch
-- is an incident."  Derived, never hand-edited (LEGACY-001, 002, 013, 049, 050). Contracts §4.6.1, §4.8.2,
-- round 8 amendments 3, 6 and 7.
--
-- Neither table is written by the posting service, so neither joins the posting-only-tables lint
-- (contracts §3.7.5 names all three async projections as exclusions); their only writers are
-- packages/db/src/ar-ap/ageing.ts and packages/db/src/projections/item-profitability.ts.
--
-- Migration numbering: this file applies AFTER 0049 and 0052 on a database that already holds them — the
-- runner applies every unapplied version in version order (packages/db/src/migrate.ts `up`), and nothing
-- here depends on 0049 or 0052.

-- ── 1. app.party_ageing — the as-of open-item ageing snapshot (§4.6.1, §4.8.2) ─────────────────────────
create table app.party_ageing (
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  party_id     uuid not null,
  currency     char(3) not null,                     -- the open documents' own currency (spec:2041)
  as_of        date not null,
  bucket       text not null,
  -- LEGACY-011: every monetary column is NOT NULL DEFAULT 0. One NULL in an accumulation nulled a whole
  -- period's balance in the old system and only a table rebuild recovered it.
  amount       numeric(19,4) not null default 0,      -- the open documents' own currency
  base_amount  numeric(19,4) not null default 0,      -- LEGACY-012: base = value × rate, at each open document's OWN rate
  created_at   timestamptz not null default now(),    -- spec:106's Always list, kept although the table is in NO_ID_TABLES
  updated_at   timestamptz not null default now(),
  -- §3.4.4 / hazard 11: a closed vocabulary is text + a named CHECK, never an enum label
  constraint party_ageing_bucket_check
    check (bucket in ('current', '1_30', '31_60', '61_90', 'over_90')),
  primary key (company_id, party_id, currency, as_of, bucket),   -- the full natural key the MERGE targets (LEGACY-002/049)
  -- composite: an FK check bypasses RLS, so a plain `references` would admit another tenant's row (LEGACY-035)
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)   references app.party(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.party_ageing');   -- spec:106; policy `tenant_isolation`, RLS enabled AND forced
-- Derived projection: no audit trigger (joins AUDIT_EXEMPT, §3.5.3) and no id (joins NO_ID_TABLES, and so
-- the derived NO_CREATED_AT_TABLES too — created_at is kept anyway, as account_balance and stock_on_hand
-- keep theirs, because spec:106 names it for every new table). No *_by column, so no attach_stamp.
-- No branch_isolation form: the table has no branch key and is not one of §4.5.6 Form C's five stock tables.
-- app_rw receives select/insert/update through default privileges (plan0A:2564); DELETE is NOT granted —
-- §3.5.4's list is pinned and 2B is the only slice that extends it, so the rebuild MERGEs and zeroes.
create index party_ageing_as_of_idx on app.party_ageing (company_id, as_of, party_id);   -- the report's read (§4.8.2)

-- ── 2. app.item_profitability — revenue, COGS and margin per item per fiscal period (§4.6.1) ──────────
create table app.item_profitability (
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  item_id          uuid not null,
  fiscal_period_id uuid not null,
  -- LEGACY-011: not null default 0, every measure
  quantity_sold    numeric(19,6) not null default 0,   -- base unit; an issue adds, a return subtracts (amendment 7)
  revenue_base     numeric(19,4) not null default 0,
  cogs_base        numeric(19,4) not null default 0,
  margin_base      numeric(19,4) not null default 0,   -- revenue_base − cogs_base, stored so a report never recomputes it
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (company_id, item_id, fiscal_period_id),   -- §4.6.1's natural key (LEGACY-002/049)
  foreign key (tenant_id, company_id)       references app.company(tenant_id, id),
  foreign key (tenant_id, item_id)          references app.item(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.item_profitability');   -- spec:106; policy `tenant_isolation`, RLS enabled AND forced
-- Same exemptions and privileges as party_ageing above (§3.5.3): NO_ID_TABLES, AUDIT_EXEMPT, no DELETE.
create index item_profitability_period_idx on app.item_profitability (company_id, fiscal_period_id);   -- 7B's per-period read

-- ── 2a. the ONE definition of a full reversal: chain depth parity (Phase 4 review B4) ───────────────────
-- A document's reversal DEPTH is the number of hops up reverses_document_id through documents that are
-- 'reversed' — each hop a full reversal, never a partial credit note (a `returns` target of the document it
-- credits, which points at a still-'posted' invoice anyway). An original is depth 0, its reversal 1, the
-- reversal of that reversal (the re-deposited receipt) 2, and so on. An ODD-depth document runs against its
-- kind and nets with the document it reversed; an EVEN-depth one is an ordinary live document of its kind.
-- A document is netted iff it is 'reversed' or it is an odd-depth reversal. The ageing below, 4A's allocation
-- (packages/db/src/ar-ap/allocation.ts) and 4B's bank matching (reconciliation.ts) all read these two
-- functions; before this, the latter two meant "points at a reversed document", so the re-deposit was
-- refused for allocation and matched the wrong way for ever.
create function app.document_reversal_depth(p_document_id uuid) returns int
language sql stable as $$
  with recursive up (id, parent, depth) as (
    select d.id, d.reverses_document_id, 0 from app.document d where d.id = p_document_id
    union all
    select o.id, o.reverses_document_id, u.depth + 1
      from up u
      join app.document o on o.id = u.parent and o.status = 'reversed'
     where not exists (select 1 from app.document_link l
                        where l.source_document_id = o.id and l.target_document_id = u.id
                          and l.link_kind = 'returns')
  )
  select max(up.depth) from up
$$;
comment on function app.document_reversal_depth(uuid) is
  'Phase 4 review B4: hops up reverses_document_id through reversed documents (full reversals only). Odd = a '
  'reversal that nets with its original; even = a live document of its kind. NULL for an invisible document.';

-- The date from which a document is netted out of the open items, NULL when it never is: an odd-depth
-- reversal nets with its original from its own effective date; a reversed document nets with its full
-- reversal from THAT document's effective date. Rule 4 of the ageing below, as a function.
create function app.document_netted_from(p_document_id uuid) returns date
language sql stable as $$
  select case
           when app.document_reversal_depth(d.id) % 2 = 1 then d.effective_date
           when d.status = 'reversed' then (
             select min(r.effective_date) from app.document r
              where r.reverses_document_id = d.id and r.status in ('posted', 'reversed')
                and not exists (select 1 from app.document_link l
                                 where l.source_document_id = d.id and l.target_document_id = r.id
                                   and l.link_kind = 'returns'))
         end
    from app.document d where d.id = p_document_id
$$;
comment on function app.document_netted_from(uuid) is
  'Phase 4 review B4: the date from which a document nets with its full-reversal partner (NULL = never).';
revoke all on function app.document_reversal_depth(uuid) from public;
revoke all on function app.document_netted_from(uuid) from public;
grant execute on function app.document_reversal_depth(uuid) to app_rw;
grant execute on function app.document_netted_from(uuid) to app_rw;

-- The same two definitions for EVERY document of a company at once (code review B3), for the ageing below:
-- one row per document app.document_netted_from gives a date, with that date. The two functions above walk
-- up one document's chain and stay for the single-document callers (4A's allocation, 4B's bank matching);
-- called once per posted party document, they made each ageing evaluation one recursive query per document.
-- Here the chains are walked DOWN, once: a HEAD is a reversed document that is not the full reversal of a
-- reversed one (it reverses nothing, reverses a document that is not 'reversed', or is a `returns` target of
-- it — a partial credit note), at depth 0; each document reversing a 'reversed' chain member, other than
-- through a `returns` link, is one deeper. That is document_reversal_depth's hop read from the other end, so
-- a document in no chain is depth 0 and every odd-depth document and every reversed one is in a chain. A
-- reversal is always of its own company's document (reverseDocument and creditNoteFrom copy company_id).
-- packages/db/test/ar-ap/code-review-b.test.ts asserts it equals app.document_netted_from on every document.
create function app.document_netted_from_rows(p_company uuid)
returns table (document_id uuid, netted_from date)
language sql stable as $$
  with recursive chain (id, status, effective_date, depth) as (
    select d.id, d.status, d.effective_date, 0
      from app.document d
      left join app.document o on o.id = d.reverses_document_id
     where d.company_id = p_company
       and d.status = 'reversed'
       and (o.id is null or o.status <> 'reversed'
            or exists (select 1 from app.document_link l
                        where l.source_document_id = o.id and l.target_document_id = d.id
                          and l.link_kind = 'returns'))
    union all
    select c.id, c.status, c.effective_date, ch.depth + 1
      from chain ch
      join app.document c on c.reverses_document_id = ch.id and c.company_id = p_company
     where ch.status = 'reversed'
       and not exists (select 1 from app.document_link l
                        where l.source_document_id = ch.id and l.target_document_id = c.id
                          and l.link_kind = 'returns')
  ),
  full_reversal as (
    -- a reversed document's earliest full reversal: document_netted_from's second arm
    select r.reverses_document_id as id, min(r.effective_date) as effective_date
      from app.document r
     where r.company_id = p_company
       and r.reverses_document_id is not null
       and r.status in ('posted', 'reversed')
       and not exists (select 1 from app.document_link l
                        where l.source_document_id = r.reverses_document_id and l.target_document_id = r.id
                          and l.link_kind = 'returns')
     group by r.reverses_document_id
  ),
  netted as (
    select ch.id,
           case when ch.depth % 2 = 1 then ch.effective_date
                when ch.status = 'reversed' then fr.effective_date end as netted_from
      from chain ch
      left join full_reversal fr on fr.id = ch.id
  )
  select n.id, n.netted_from from netted n where n.netted_from is not null
$$;
comment on function app.document_netted_from_rows(uuid) is
  'Code review B3: app.document_netted_from for every document of a company, in one set-based walk of the '
  'reversal chains; a document it does not list is never netted. app.party_ageing_rows reads it.';
revoke all on function app.document_netted_from_rows(uuid) from public;
grant execute on function app.document_netted_from_rows(uuid) to app_rw;

-- ── 3. app.party_ageing_rows — the ONE definition of the ageing arithmetic (§4.8.2, amendment 3) ──────
--
-- STABLE and NOT security definer, so every row below is already filtered by tenant_isolation and by
-- FORCE ROW LEVEL SECURITY as the caller (the reasoning §4.5.6 gives for actor_in_warehouse).
--
-- 1. WHAT IS CHARGED. One row per posted party document up to p_as_of: its ledger rows on the party's
--    control account, chosen by kind — vendor → coalesce(payable, receivable), anything else →
--    coalesce(receivable, payable) — so a party carrying both defaults is not netted, and the vendor side
--    sign-flipped so an open invoice is positive in both directions. `amount` sums only the rows in the
--    document's own currency (LEGACY-014: two currencies are never added); `base_amount` sums them all.
-- 2. WHEN IT IS DUE. document.effective_date + the term PINNED on the document (document.payment_term_id,
--    4A amendment 8 / 4B amendment 3 — never party.payment_term_id, which would re-age history: LEGACY-013);
--    no term is due on its effective date.
-- 3. WHAT RELIEVED IT. An allocation relieves BOTH its documents while it is live as of p_as_of: from its
--    own accounting date, allocation.effective_date, until its un-allocation's, allocation.unallocated_on
--    (0046; code review B1). The first is the later of the two documents' dates moved forward to the first
--    open period, so the guard is symmetric — a January receipt applied to a February invoice leaves the
--    receipt fully open in a January report, and is never subtracted on one side without being added on the
--    other — and an allocation or un-allocation made after a period closed never rewrites that period's
--    ageing. 4B's realised FX documents are dated on the same two days (fx.ts), which is what keeps the
--    tie-out exact at every as-of date.
--    The settled side is relieved by amount / base_amount; the settlement side by the SETTLEMENT base,
--    base_amount + fx_difference (§4.8.1: fx_difference = settlement base − settled base) — which is why the
--    base tie-out holds once 4B's realised FX difference has posted to the control account and not before
--    (ADR 0047, amendment 4). In its own currency the settlement is relieved by settlement_amount, which a
--    cross-currency allocation states beside amount (4B, ADR 0047 decision 9). The relief is a MAGNITUDE
--    (allocation_amount_check, allocation_settlement_amount_check) and reduces the document's |open|
--    whichever side of the control account the document sits on: a receipt applied to an invoice and a
--    refund applied to a credit note would be the same arithmetic (no seeded policy posts a refund yet —
--    ADR 0047 open question 5).
-- 4. A FULL REVERSAL NETS ITS ORIGINAL. A document reverseDocument left 'reversed' and the reversal it
--    produced cancel in the ledger, carry no capacity (4A's allocateSettlement refuses both, and
--    reverseDocument refuses while a live allocation exists), and are not open items — once the reversal
--    is effective as of p_as_of. Before that date the original was an ordinary open item and is aged as
--    one, because the ledger as of that date still holds it. A PARTIAL credit note (4A creditNoteFrom)
--    points reverses_document_id at a still-'posted' invoice, is not a full reversal, and is an open item —
--    negative — until it is allocated. A reversal that is itself reversed pairs with ITS reversal: pairs are
--    taken along the chain (depth 1 with 0, 3 with 2, …), so every excluded pair nets to zero in the ledger
--    and the tie-out stays exact. The chain is app.document_reversal_depth / app.document_netted_from
--    (§2a), the definition allocation and bank matching read too, evaluated here for the whole company at
--    once through app.document_netted_from_rows (code review B3).
-- 5. AN FX_REVALUATION IS NEVER AN OPEN ITEM. A realised one names its party (4B, ADR 0047) and moves the
--    control account by exactly the fx_difference rule 3 already counts; the unrealised one names none.
create function app.party_ageing_rows(p_company uuid, p_as_of date)
returns table (party_id uuid, currency char(3), bucket text, amount numeric(19,4), base_amount numeric(19,4))
language sql stable as $$
  with control as (
    -- rule 1: what each open document charged the party, in its own currency and in base
    select d.id,
           d.party_id,
           d.currency,
           d.effective_date,
           coalesce(pt.due_days, 0) as due_days,
           sgn.v * coalesce(sum(case when le.currency = d.currency then le.debit - le.credit else 0 end), 0)
             as charged_ccy,
           sgn.v * coalesce(sum(le.base_debit - le.base_credit), 0) as charged_base
      from app.document d
      join app.party p on p.id = d.party_id
      cross join lateral (select case when p.kind = 'vendor' then -1 else 1 end as v) sgn
      left join app.payment_term pt on pt.id = d.payment_term_id          -- rule 2: the PINNED term
      left join app.document_netted_from_rows(p_company) n on n.document_id = d.id   -- rule 4, set-based (B3)
      join app.ledger_entry le
        on le.document_id = d.id
       and le.account_id = app.party_control_account(p)
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')      -- a reversed document keeps its rows until its reversal is effective
       and d.effective_date <= p_as_of
       and not coalesce(n.netted_from <= p_as_of, false)   -- rule 4, once effective
       -- rule 5: a REALISED FX_REVALUATION names its party (ADR 0047) and moves the control account, but it
       -- is the ledger's correction of an allocation already counted below at the settlement base — never
       -- an open item. Counted here it would age as a receivable of exactly the FX amount.
       and not exists (select 1 from app.document_type t
                        where t.id = d.document_type_id and t.code = 'FX_REVALUATION')
     group by d.id, d.party_id, d.currency, d.effective_date, pt.due_days, sgn.v
  ),
  live_allocation as (
    -- rule 3: an allocation of this company live as of p_as_of — from its own accounting date until the
    -- accounting date of its un-allocation (code review B1). effective_date is never before either document's.
    select a.settlement_document_id,
           a.settled_document_id,
           a.amount,
           a.settlement_amount,
           a.base_amount,
           a.fx_difference
      from app.allocation a
     where a.company_id = p_company
       and a.effective_date <= p_as_of
       and (a.unallocated_at is null or a.unallocated_on > p_as_of)
  ),
  relief as (
    -- the SETTLED side: allocation.amount is in its currency and base_amount at its rate (§4.8.1)
    select la.settled_document_id as id, la.amount as ccy, la.base_amount as base
      from live_allocation la
    union all
    -- the SETTLEMENT side: allocation.settlement_amount in its own currency (equal to amount when the two
    -- documents share one; 4B, ADR 0047 decision 9) and the settlement base, base_amount + fx_difference.
    select la.settlement_document_id,
           la.settlement_amount,
           la.base_amount + la.fx_difference
      from live_allocation la
  ),
  relieved as (
    select r.id, sum(r.ccy) as ccy, sum(r.base) as base from relief r group by r.id
  ),
  per_doc as (
    select c.party_id,
           c.currency,
           case when (p_as_of - (c.effective_date + c.due_days)) <= 0  then 'current'
                when (p_as_of - (c.effective_date + c.due_days)) <= 30 then '1_30'
                when (p_as_of - (c.effective_date + c.due_days)) <= 60 then '31_60'
                when (p_as_of - (c.effective_date + c.due_days)) <= 90 then '61_90'
                else 'over_90' end as bucket,
           -- the relief reduces |open| on the document's own side of the control account (rule 3)
           (c.charged_ccy  - side.v * coalesce(rl.ccy, 0))::numeric(19,4)  as open_ccy,
           (c.charged_base - side.v * coalesce(rl.base, 0))::numeric(19,4) as open_base
      from control c
      cross join lateral (select sign(case when c.charged_ccy <> 0 then c.charged_ccy
                                           else c.charged_base end) as v) side
      left join relieved rl on rl.id = c.id
  )
  select pd.party_id,
         pd.currency,
         pd.bucket,
         sum(pd.open_ccy)::numeric(19,4),
         sum(pd.open_base)::numeric(19,4)
    from per_doc pd
   where pd.open_ccy <> 0 or pd.open_base <> 0
   group by pd.party_id, pd.currency, pd.bucket
  having sum(pd.open_ccy) <> 0 or sum(pd.open_base) <> 0     -- one row per non-zero open figure (§4.8.2)
$$;
comment on function app.party_ageing_rows(uuid, date) is
  'contracts §4.8.2 (4B amendment 3): the ONE definition of the ageing arithmetic. The party_ageing rebuild, '
  'the accounting.ageing report and the nightly compare all read it. Buckets on effective_date + the term '
  'pinned on the document; a full reversal nets its original once effective; base-only tie-out (amendment 4).';
revoke all on function app.party_ageing_rows(uuid, date) from public;       -- spec:2053: the app role only
grant execute on function app.party_ageing_rows(uuid, date) to app_rw;

-- ── 3a. app.item_revenue_rows — the ONE definition of item revenue (code review B4) ─────────────────────
--
-- STABLE and NOT security definer, as above.
--
-- Per (document, item): Σ round(document_line.amount × document.exchange_rate, 4) over the ITEM lines of the
-- company's posted and reversed documents whose effective_date lies in [p_from, p_to] (a NULL bound is open)
-- — the arithmetic 4A's sales_by_item introduced (Phase 4 review B7), on each document's OWN rate (LEGACY-014).
-- WHICH documents carry revenue, and in which direction, is read from the policy PINNED on the document
-- (§4.3.2 step 13) — its rules on `item.revenue_account` — never from the item's CURRENT revenue_account_id,
-- which a later edit of the item would change under every past sale, and never from a list of type codes.
-- A policy that CREDITS item.revenue_account contributes the lines as they stand (a SALES_INVOICE; a credit
-- note, whose magnitudes are negated, subtracts); one that DEBITS it contributes them negated (a zero-code
-- return type whose magnitudes are not negated; 6A's POS_TICKET return); a policy naming it on both sides, or
-- not at all (a DELIVERY_ORDER), contributes none. A line keeps its own sign, as the evaluator's A9
-- normalisation does.
--
-- Both statuses: a reversed document's rows stay in the ledger and its reversal's rows cancel them on the
-- reversal's own date, which is what a dated or per-period report must show.
--
-- inventory.sales_by_item (packages/db/src/reports/sales-by-item.ts) and app.item_profitability_rows below
-- both read it, so the two reports that must reconcile (LEGACY-019) cannot disagree about revenue: before this,
-- the report counted a hard-coded SALES_INVOICE / SALES_CREDIT_NOTE list and the projection the pinned
-- policy, and 6A's POS_TICKET would have been revenue in one and not the other.
create function app.item_revenue_rows(p_company uuid, p_from date, p_to date)
returns table (document_id uuid, item_id uuid, revenue_base numeric(19,4))
language sql stable as $$
  with revenue_doc as (
    select d.id, d.exchange_rate, d.posting_policy_id
      from app.document d
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')
       and (p_from is null or d.effective_date >= p_from)
       and (p_to   is null or d.effective_date <= p_to)
  ),
  revenue_sign as (
    -- the direction of each PINNED policy's rules on item.revenue_account; a policy naming none is absent
    select pp.id,
           case when bool_and(r.rule->>'side' = 'credit') then 1
                when bool_and(r.rule->>'side' = 'debit')  then -1 end as sign
      from app.posting_policy pp
      cross join lateral jsonb_array_elements(pp.definition->'lines') as r(rule)
     where pp.id in (select rd.posting_policy_id from revenue_doc rd)
       and r.rule->'account'->>'from' = 'item.revenue_account'
     group by pp.id
  )
  select rd.id,
         dl.item_id,
         (sum(round(dl.amount * rd.exchange_rate, 4)) * max(rs.sign))::numeric(19,4)
    from revenue_doc rd
    join revenue_sign rs on rs.id = rd.posting_policy_id and rs.sign is not null
    join app.document_line dl on dl.document_id = rd.id and dl.kind = 'item' and dl.item_id is not null
   group by rd.id, dl.item_id
$$;
comment on function app.item_revenue_rows(uuid, date, date) is
  'Code review B4: the ONE definition of item revenue — per (document, item), the item lines at the document''s '
  'own rate, directed by the pinned policy''s item.revenue_account rules. inventory.sales_by_item and '
  'app.item_profitability_rows both read it.';
revoke all on function app.item_revenue_rows(uuid, date, date) from public;   -- spec:2053: the app role only
grant execute on function app.item_revenue_rows(uuid, date, date) to app_rw;

-- ── 4. app.item_profitability_rows — the ONE definition of the item split (amendments 6 and 7) ────────
--
-- STABLE and NOT security definer, as above.
--
-- p_sale_types is a PARAMETER, not a literal list, because the membership lives in one TypeScript constant
-- (SALE_MOVEMENT_TYPES, packages/db/src/projections/item-profitability.ts) that 6A appends POS_TICKET to.
-- Membership carries no sign, and since code review B4 it selects the MOVEMENTS only: revenue is
-- app.item_revenue_rows (§3a), which reads the pinned policy and no list, so a type that credits
-- item.revenue_account is revenue here and in sales_by_item whether or not it is a member.
--
-- QUANTITY and COGS come from the sale documents' movements (amendment 7): quantity_sold = Σ −quantity, so
-- an issue adds and a return subtracts; cogs_base = Σ |inventory_movement.value| for an issue and
-- −|value| for a receipt (a return). The movement's value is IMMUTABLE — the figure the document's own
-- ledger rows carry (line.cost into 1250 / 5000) — so the projection agrees with the ledger to the cent,
-- including an issue that ran into negative stock, whose uncovered quantity has no cost_consumption row
-- but is valued in the movement and in the ledger (Phase 4 review B6; amendment 7 read cost_consumption,
-- which left that shortfall's cost out). A later recost is the COST_ADJUSTMENT document's, not a sale's.
-- Under ADR 0044 only the DELIVERY_ORDER carries a movement.
--
-- REVENUE is app.item_revenue_rows over the whole company (§3a; Phase 4 review B7), keyed here by the
-- document's fiscal period.
--
-- Both statuses: a reversed document's rows stay in the ledger and its reversal's rows cancel them in the
-- reversal's own period, which is the period accounting a per-period projection must show.
create function app.item_profitability_rows(p_company uuid, p_sale_types text[])
returns table (item_id uuid, fiscal_period_id uuid, quantity_sold numeric(19,6),
               revenue_base numeric(19,4), cogs_base numeric(19,4), margin_base numeric(19,4))
language sql stable as $$
  with sale_doc as (
    select d.id
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')
       and d.fiscal_period_id is not null
       and t.code = any (p_sale_types)
  ),
  revenue as (
    select r.document_id, r.item_id, r.revenue_base
      from app.item_revenue_rows(p_company, null, null) r
  ),
  movement as (
    -- quantity from the movement's own sign, cost from its immutable value (B6)
    select sd.id as document_id,
           m.item_id,
           sum(-m.quantity)::numeric(19,6) as quantity_sold,
           sum(case when m.quantity < 0 then abs(m.value) else -abs(m.value) end)::numeric(19,4) as cogs_base
      from sale_doc sd
      join app.inventory_movement m on m.document_id = sd.id
     group by sd.id, m.item_id
  ),
  joined as (
    select coalesce(r.document_id, mv.document_id) as document_id,
           coalesce(r.item_id, mv.item_id)         as item_id,
           coalesce(mv.quantity_sold, 0)           as quantity_sold,
           coalesce(r.revenue_base, 0)             as revenue_base,
           coalesce(mv.cogs_base, 0)               as cogs_base
      from revenue r
      full outer join movement mv
        on mv.document_id = r.document_id and mv.item_id = r.item_id
  )
  select j.item_id,
         d.fiscal_period_id,
         sum(j.quantity_sold)::numeric(19,6),
         sum(j.revenue_base)::numeric(19,4),
         sum(j.cogs_base)::numeric(19,4),
         (sum(j.revenue_base) - sum(j.cogs_base))::numeric(19,4)
    from joined j
    join app.document d on d.id = j.document_id
   where d.fiscal_period_id is not null
   group by j.item_id, d.fiscal_period_id
  having sum(j.quantity_sold) <> 0 or sum(j.revenue_base) <> 0 or sum(j.cogs_base) <> 0
$$;
comment on function app.item_profitability_rows(uuid, text[]) is
  'contracts §4.6.1 (4B amendments 6 and 7, Phase 4 review B6/B7, code review B4): the ONE definition of the '
  'item split. Quantity and COGS from the sale documents'' movements (quantity, immutable value), revenue '
  'from app.item_revenue_rows. p_sale_types is SALE_MOVEMENT_TYPES; membership carries no sign and selects '
  'the movements only.';
revoke all on function app.item_profitability_rows(uuid, text[]) from public;   -- spec:2053: the app role only
grant execute on function app.item_profitability_rows(uuid, text[]) to app_rw;

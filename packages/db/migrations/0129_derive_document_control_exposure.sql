-- ── 0129 · one derivation of a document's control-account exposure (full review 2026-11-15, MON-01/MON-11) ────
-- Allocated by the review's orchestrator from the §3.4.1 tail for branch claude/fix-fx-cost-leg-returns.
--
-- THE DEFECT. A foreign-currency PURCHASE_RETURN debits the vendor's payable at `line.cost` (its seeded policy,
-- §4.7.3 amendment A4), and a cost leg is written in BASE currency at rate 1. 0048's app.party_ageing_rows summed
-- the document-currency amount only over control rows in the document's currency, so such a return aged as
-- EUR 0.0000 with base −cost; revalueAtPeriodEnd (fx.ts) then restated that base to zero — an "unrealised FX loss"
-- of the whole return at a rate that never moved, again every period (MON-01) — and the vendor's EUR ageing showed
-- the invoice unreduced once the return was allocated to it. allocation.ts already treated the case (its
-- `controlInBase`), but differently again: it took the return's capacity from the keyed total and its base from the
-- cost, so the price-versus-cost difference was booked as realised FX (MON-11).
--
-- THE RULE (the 2026-11-15 amendments to ADRs 0046 and 0047 — proposals). app.document_control_exposure is the ONE
-- derivation the ageing, the revaluation (through the ageing), allocation (docFacts) and partyBalance all read:
--   * a document whose control rows are all in its own currency: one row, Σ (debit − credit) and
--     Σ (base_debit − base_credit) of those rows — exactly 0048's figure, so nothing else changes;
--   * a document with a control row in another currency (a base-currency cost leg): its exposure IN ITS OWN
--     CURRENCY is its keyed total, Σ document_line.total_incl_tax, on the side the ledger moved, carried at its own
--     rate — round(amount × exchange_rate, 4), HALF_AWAY_FROM_ZERO, toBase's arithmetic (spec:1816, SAH-012). That
--     is what the party owes in that currency and the only part a rate can move. What the cost leg put on the
--     control account beyond it (the price-versus-cost difference) is a second, BASE-currency row: a base-only
--     residue that the ledger really holds — so the base tie-out to 1200/2100 stays exact to the cent — but that is
--     never revalued (fx.ts skips base-currency rows) and never relieved by an allocation (party_ageing_rows below
--     relieves only the own-currency row; allocation.ts measures capacity on it). Clearing that residue needs the
--     return's policy to relieve the payable at the keyed price — an owner question recorded in ADR 0046.
--
-- Both functions are STABLE and NOT security definer, so every row is filtered by RLS as the caller (0048's
-- reasoning). Ledger orientation, debit-positive: the caller applies the party-kind sign.

create function app.document_control_exposure(p_document uuid)
returns table (currency char(3), amount numeric(19,4), base_amount numeric(19,4))
language sql stable as $$
  with legs as (
    select d.currency as doc_currency,
           d.exchange_rate,
           c.base_currency,
           le.currency as leg_currency,
           le.debit - le.credit as amt,
           le.base_debit - le.base_credit as base
      from app.document d
      join app.party p on p.id = d.party_id
      join app.company c on c.id = d.company_id
      join app.ledger_entry le
        on le.document_id = d.id
       and le.account_id = app.party_control_account(p)
     where d.id = p_document
  ),
  whole as (
    -- `having`: a document with no control row has no exposure row at all (0048's inner join).
    select min(l.doc_currency) as doc_currency,
           min(l.exchange_rate) as rate,
           min(l.base_currency) as base_currency,
           bool_or(l.leg_currency <> l.doc_currency) as in_base,
           coalesce(sum(l.amt) filter (where l.leg_currency = l.doc_currency), 0) as ccy_rows,
           coalesce(sum(l.base), 0) as base      -- SAH-011: every accumulation coalesced
      from legs l
    having count(*) > 0
  ),
  own as (
    select w.doc_currency,
           w.base_currency,
           w.base,
           w.in_base,
           case when w.in_base
                then sign(w.base) * abs(coalesce((select sum(dl.total_incl_tax)
                                                    from app.document_line dl
                                                   where dl.document_id = p_document), 0))
                else w.ccy_rows end::numeric(19,4) as ccy,
           w.rate
      from whole w
  ),
  priced as (
    select o.*,
           case when o.in_base then round(o.ccy * o.rate, 4) else o.base end::numeric(19,4) as own_base
      from own o
  )
  select x.doc_currency, x.ccy, x.own_base
    from priced x
  union all
  select x.base_currency, (x.base - x.own_base)::numeric(19,4), (x.base - x.own_base)::numeric(19,4)
    from priced x
   where x.in_base and x.base <> x.own_base
$$;
comment on function app.document_control_exposure(uuid) is
  'full review 2026-11-15 (MON-01, MON-11; ADRs 0046 and 0047, 2026-11-15 amendments): a document''s exposure '
  'on its party''s control account, debit-positive — its own-currency row (a base-currency cost leg replaced by the '
  'keyed total at the document''s rate) and, for such a document, a base-only residue row. The one derivation the '
  'ageing, revaluation, allocation and partyBalance read.';
revoke all on function app.document_control_exposure(uuid) from public;
grant execute on function app.document_control_exposure(uuid) to app_rw;

-- app.party_ageing_rows — 0048's definition with rule 1 read through app.document_control_exposure. Rules 2–5 and
-- the bucket, relief and output arithmetic are unchanged; the one other change is that the relief (rule 3) applies
-- only to a document's OWN-currency row, never to its base-only residue. The rebuild, the accounting.ageing report
-- and the nightly compare all still read this one function, so they stay bit-identical to one another.
create or replace function app.party_ageing_rows(p_company uuid, p_as_of date)
returns table (party_id uuid, currency char(3), bucket text, amount numeric(19,4), base_amount numeric(19,4))
language sql stable as $$
  with control as (
    -- rule 1: what each open document charged the party, in its own currency and in base — one row, or two for a
    -- document whose control legs are base-currency cost legs (its own-currency exposure and its base residue)
    select d.id,
           d.party_id,
           x.currency,
           (x.currency = d.currency) as own,
           d.effective_date,
           coalesce(pt.due_days, 0) as due_days,
           sgn.v * x.amount as charged_ccy,
           sgn.v * x.base_amount as charged_base
      from app.document d
      join app.party p on p.id = d.party_id
      cross join lateral (select case when p.kind = 'vendor' then -1 else 1 end as v) sgn
      left join app.payment_term pt on pt.id = d.payment_term_id          -- rule 2: the PINNED term
      left join app.document_netted_from_rows(p_company) n on n.document_id = d.id   -- rule 4, set-based (B3)
      cross join lateral app.document_control_exposure(d.id) x
     where d.company_id = p_company
       and d.status in ('posted', 'reversed')      -- a reversed document keeps its rows until its reversal is effective
       and d.effective_date <= p_as_of
       and not coalesce(n.netted_from <= p_as_of, false)   -- rule 4, once effective
       -- rule 5: a REALISED FX_REVALUATION names its party (ADR 0047) and moves the control account, but it
       -- is the ledger's correction of an allocation already counted below at the settlement base — never
       -- an open item. Counted here it would age as a receivable of exactly the FX amount.
       and not exists (select 1 from app.document_type t
                        where t.id = d.document_type_id and t.code = 'FX_REVALUATION')
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
      left join relieved rl on rl.id = c.id and c.own      -- a base-only residue is never relieved
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
  'pinned on the document; a full reversal nets its original once effective; base-only tie-out (amendment 4). '
  'Rule 1 reads app.document_control_exposure (0129, MON-01): a base-currency cost leg ages at the keyed total in '
  'the document''s currency, with any price-versus-cost difference as an unrelieved base-only row.';
revoke all on function app.party_ageing_rows(uuid, date) from public;       -- spec:2053: the app role only
grant execute on function app.party_ageing_rows(uuid, date) to app_rw;

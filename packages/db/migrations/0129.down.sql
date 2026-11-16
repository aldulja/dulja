-- Reverse of 0129. Restores 0048's app.party_ageing_rows verbatim (its comment, revoke and grant included) and then
-- drops app.document_control_exposure, which nothing else references once the ageing no longer calls it. 0048's
-- definition ages a foreign-currency document whose control legs are base-currency cost legs as 0.0000 in its own
-- currency (MON-01), so a database rolled back past 0129 regains that defect.
create or replace function app.party_ageing_rows(p_company uuid, p_as_of date)
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
drop function if exists app.document_control_exposure(uuid);

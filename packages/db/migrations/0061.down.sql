-- 0061.down.sql
-- The kind CHECK returns to 2A's four labels only when no row uses a dropped one; `down` runs only in CI on
-- empty tenants (§3.4.5), so the guard is a hard failure and not a silent skip.
do $$ begin
  if exists (select 1 from app.document_line where kind in ('tender','payroll')) then
    raise exception 'cannot narrow document_line_kind_check: rows still use tender/payroll';
  end if;
end $$;
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text'));
alter table app.pos_terminal drop constraint if exists pos_terminal_company_id_code_key;
alter table app.pos_terminal drop column if exists code;
alter table app.document drop column if exists shift_id;
drop index if exists app.document_terminal_idx;
alter table app.document drop constraint if exists document_terminal_fk;
alter table app.document drop column if exists terminal_id;

-- Restore the exact pre-6A credit functions (contracts §4.10.4); no new function is left behind.
create or replace function app.document_base_total(p_document_id uuid, p_exchange_rate numeric) returns numeric
language sql stable as $$
  select coalesce(sum(round(dl.total_incl_tax * p_exchange_rate, 4)), 0)::numeric(19,4)
    from app.document_line dl
   where dl.document_id = p_document_id
$$;

create or replace function app.assert_credit_available() returns trigger language plpgsql as $$
declare
  v_party       app.party%rowtype;
  v_doc_base    numeric(19,4);
  v_open        numeric(19,4);
begin
  -- Guard 1: no party, no credit question; and a party with neither a limit nor a hold has none either —
  -- WHATEVER its kind (A7: a limit or a hold configured on a dealer or a vendor is a control, not a no-op).
  -- Both are named guards rather than a fall-through of three-valued logic (SAH-042).
  if new.party_id is null then return new; end if;
  select * into v_party from app.party where id = new.party_id;
  if v_party.id is null then return new; end if;
  if v_party.credit_limit is null and not v_party.credit_hold then return new; end if;

  -- Guard 2: only a sale is a sale on credit — app.policy_extends_credit, an outbound policy that does not
  -- move the party's payable account (code review 2026-09-29: a PAYMENT, a PURCHASE_RETURN and a
  -- PURCHASE_CREDIT_NOTE are outbound too, and a vendor on hold could not be paid). An internal or inbound
  -- document is ignored, and a policy that cannot be resolved is ignored here — 2B's trigger is what refuses
  -- an unresolvable policy. `is distinct from true`, never `not`: an unknown answer is ignored, not negated
  -- (SAH-042).
  if app.policy_extends_credit(app.effective_policy(new.document_type_id, new.effective_date))
       is distinct from true then
    return new;
  end if;

  -- Guard 3 (code review 2, F2): a reversal that takes a sale back is not a sale on credit. reverseDocument
  -- mirrors the original into its reversal type — for DELIVERY_ORDER that type is DELIVERY_ORDER, which
  -- extends credit — with every magnitude negated, and postDocument issues the mirror inside the same call, so
  -- no override can ever be recorded on it. Its contribution is the negated original: it LOWERS the exposure,
  -- so neither the hold (spec:1026's "block on over-limit sales"; §4.8.1's "regardless" is regardless of an
  -- override) nor the limit applies, and a delivery made before a hold can still be taken back. BOTH
  -- conditions, never reverses_document_id alone: a custom reversal type whose mirror raises the exposure is
  -- a sale and is controlled below. The contribution is step 3's figure, from the lines at the document's
  -- own rate; nothing is locked for a document that adds no exposure.
  v_doc_base := app.document_base_total(new.id, new.exchange_rate);
  if new.reverses_document_id is not null and v_doc_base <= 0 then
    return new;
  end if;

  -- The party row is LOCKED and re-read (A6): two issues of this party's sales, each reading the other's
  -- exposure before either committed, both fitted under the limit and together exceeded it. `no key update`
  -- serialises this control against itself and against any edit of the party, and — unlike `for update` —
  -- does not block the foreign-key checks of documents that merely reference the party.
  select * into v_party from app.party where id = new.party_id for no key update;

  -- 1. A hold blocks first, and no override lifts it (contracts §4.8.1).
  if v_party.credit_hold then
    raise exception 'ERR_CREDIT_HOLD: party % is on credit hold', v_party.code using errcode = 'check_violation';
  end if;

  -- 2. No limit configured is not a zero limit (spec:1026).
  if v_party.credit_limit is null then return new; end if;

  -- 3. The document's own contribution, computed at guard 3 above. It is not posted yet, so it comes from its
  --    LINES at its own rate — app.document_base_total, the identity ledger_entry's CHECK enforces (spec:1816,
  --    SAH-012). Do not "simplify" it into one query over the ledger — this document has no ledger rows at
  --    `→ issued`.

  -- 4. A second principal's override event, already authorised by 2B's document_event_override_guard
  --    (§4.5.3, spec:2179), that APPROVED at least this figure (code review 2026-09-29): the event carries
  --    the document's base total when it was recorded (§2c above), so a draft re-keyed upwards after the
  --    approval is compared like any other. This trigger asks nothing further about authority: two authority
  --    questions, asked differently, is how two answers appear (SAH-032).
  if exists (select 1 from app.document_event e
              where e.document_id = new.id
                and e.event_kind = 'override'
                and e.override_code = 'accounting.credit_limit.override'
                and e.approved_base_total >= v_doc_base) then
    return new;
  end if;

  -- 5. The comparison: the party's existing exposure is app.party_credit_exposure — everything posted, with
  --    no date cut, plus the party's other issued-but-unposted credit-extending documents (A6).
  v_open := app.party_credit_exposure(new.party_id, new.id);

  if v_open + v_doc_base > v_party.credit_limit then
    raise exception
      'ERR_CREDIT_LIMIT_EXCEEDED: party % is over its credit limit — limit %, open %, this document %',
      v_party.code, v_party.credit_limit, v_open, v_doc_base
      using errcode = 'check_violation';
  end if;
  return new;
end $$;


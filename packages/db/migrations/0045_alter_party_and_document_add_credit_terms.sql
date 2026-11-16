-- 0045_alter_party_and_document_add_credit_terms.sql
-- Slice 4A. Customer credit control (spec:1026 §3.0.3; spec:1042; contracts §4.5.7, §4.8.1) and the payment
-- term PINNED on a document (contracts §4.3.4; LEGACY-013 — a term is never re-read from the party).
-- EXPAND ONLY (§3.4.7, spec:2057): five nullable-or-defaulted columns, nothing renamed, nothing dropped —
-- and, since the code review of 2026-09-29, a sixth: document_event.approved_base_total (§2c).

-- ── 1. app.party — the commercial-terms columns (§4.5.7) ──────────────────────────────────────────────
alter table app.party add column credit_limit    numeric(19,4);            -- spec:1026; null = no limit configured
alter table app.party add column payment_term_id uuid;                     -- spec:1042; the term a new document pins
alter table app.party add column credit_hold     boolean not null default false;  -- contracts §4.8.1 "blocks regardless"
-- The fourth column is NOT credit control and no line of the trigger below reads it: it is the customer's
-- trade-level price list, the key contracts §3.7.6's "customer-specific pricing" resolves on. It rides in
-- this file because 6B's Task 0 amendment A10(b) named 4A's 0045 by name — 4A owns the customer's
-- commercial terms and a price list is one, and 4A executes two phases before 6B could add it itself.
-- `app.price_list` is 3A's migration 0030, two ranges below this one, and carries `unique (tenant_id, id)`,
-- so the composite FK §3.5.1 requires is available here.
alter table app.party add column price_list_id   uuid;                     -- contracts §4.5.7, 6B amendment A10(b)
-- Composite FKs (§3.5.1, LEGACY-035): an FK check bypasses RLS, so a plain `references` would admit another
-- tenant's term or list if the uuid were known.
alter table app.party
  add constraint party_credit_limit_check check (credit_limit is null or credit_limit >= 0),
  add constraint party_payment_term_fk
      foreign key (tenant_id, payment_term_id) references app.payment_term(tenant_id, id),
  add constraint party_price_list_fk
      foreign key (tenant_id, price_list_id) references app.price_list(tenant_id, id);
comment on column app.party.credit_limit is
  'spec:1026 "limits, ageing, and a block on over-limit sales". In the company BASE currency. NULL is no limit; 0 is a zero limit.';
comment on column app.party.credit_hold is
  'contracts §4.8.1: blocks regardless of any override (ERR_CREDIT_HOLD).';
comment on column app.party.price_list_id is
  'contracts §4.5.7 / §3.7.6 customer-specific pricing; requested by 6B amendment A10(b). NULL = this '
  'customer has no list of its own and resolution falls back to branch, then company-wide (6B resolvePrice). '
  'Read by 6B and 3D; NOTHING in 4A reads it — app.assert_credit_available() never touches it.';

-- ── 2. app.document — the pinned term (§4.3.4) ────────────────────────────────────────────────────────
alter table app.document add column payment_term_id uuid;                  -- LEGACY-013: pinned at draft, never re-read
alter table app.document
  add constraint document_payment_term_fk                                 -- §3.5.1 composite FK (LEGACY-035)
      foreign key (tenant_id, payment_term_id) references app.payment_term(tenant_id, id);
comment on column app.document.payment_term_id is
  'PINNED at draft from party.payment_term_id and never re-read (LEGACY-013). The due date is the derived '
  'effective_date + payment_term.due_days (app.payment_due_date) and has no column of its own; contracts §4.8.2.';

-- ── 2a. a document's base total, as credit control measures it (code review 2026-09-29) ────────────────
-- An unposted document has no ledger rows, so its contribution comes from its LINES at a rate — base =
-- round(value × rate, 4) PER LINE, the identity ledger_entry's CHECK enforces (spec:1816, LEGACY-012), so the
-- figure is the ledger figure the document will become. The rate is a parameter because the credit trigger
-- measures the row being updated (NEW.exchange_rate) while the other readers measure the stored document.
-- ONE definition for the trigger, the exposure and the override's approved figure below: three spellings of
-- one sum is how an override came to approve a number the trigger did not compare.
create function app.document_base_total(p_document_id uuid, p_exchange_rate numeric) returns numeric
language sql stable as $$
  select coalesce(sum(round(dl.total_incl_tax * p_exchange_rate, 4)), 0)::numeric(19,4)
    from app.document_line dl
   where dl.document_id = p_document_id
$$;
comment on function app.document_base_total(uuid, numeric) is
  'Code review 2026-09-29: Σ round(line.total_incl_tax × rate, 4) of a document — the base figure credit '
  'control, the credit exposure and a credit-limit override''s approved amount all read.';

-- ── 2b. which policies extend credit (code review 2026-09-29) ───────────────────────────────────────────
-- A sale on credit is an OUTBOUND document that does not move the party's PAYABLE account. `direction =
-- 'outbound'` alone also caught money and goods going back to a vendor — PAYMENT, PURCHASE_CREDIT_NOTE,
-- PURCHASE_RETURN, each debiting party.payable_account — so a vendor on credit hold could not be paid, a
-- vendor with a limit and no receivable account raised ERR_POLICY_REQUIRES_MISSING on every payment, and a
-- payment was counted as credit exposure. Decided by policy SHAPE, never by document-type code (3C's rule).
-- The seeded pack's outbound types: SALES_INVOICE and DELIVERY_ORDER extend credit; PAYMENT,
-- PURCHASE_CREDIT_NOTE and PURCHASE_RETURN do not. Never NULL: a NULL policy extends no credit.
create function app.policy_extends_credit(p_policy jsonb) returns boolean
language sql immutable as $$
  select (p_policy ->> 'direction') is not distinct from 'outbound'
     and not exists (select 1 from jsonb_array_elements(coalesce(p_policy -> 'lines', '[]'::jsonb)) r
                      where r -> 'account' ->> 'from' = 'party.payable_account')
$$;
comment on function app.policy_extends_credit(jsonb) is
  'Code review 2026-09-29: true for an outbound policy that names no party.payable_account rule — a sale on '
  'credit. The one predicate app.assert_credit_available() and app.party_credit_exposure() both ask.';

-- ── 2c. a credit-limit override approves an AMOUNT (code review 2026-09-29) ───────────────────────────────
-- An override is a second principal's approval of THIS document at THIS figure. The trigger below used to
-- accept any credit override event on the document, so a clerk could draft 1,050 against a limit of 1,000,
-- have it approved, re-key the lines to 100,000 and issue. The event now carries the document's base total at
-- the moment it was recorded, and the control admits a document whose base total is no greater than that.
-- The figure is STAMPED here, never taken from the caller — the same rule as actor_id (LEGACY-044) — and an
-- override is refused once the document has left draft, submitted or approved: the control fires at
-- → issued, so an override recorded after it approves nothing and is a record of an approval never used.
-- 0021's table and its guard are not edited; this column, its check and this trigger are 0045's own.
alter table app.document_event add column approved_base_total numeric(19,4);
alter table app.document_event
  add constraint document_event_approved_base_total_check
      check (approved_base_total is null
          or (event_kind = 'override' and override_code = 'accounting.credit_limit.override'));
comment on column app.document_event.approved_base_total is
  'Code review 2026-09-29: on an accounting.credit_limit.override event only — the document''s base total '
  '(app.document_base_total) when the override was recorded, stamped by app.stamp_credit_override(). '
  'app.assert_credit_available() admits a document whose base total does not exceed it.';

create function app.stamp_credit_override() returns trigger language plpgsql as $$
declare
  v_status app.document_status;
  v_rate   numeric;
begin
  select d.status, d.exchange_rate into v_status, v_rate from app.document d where d.id = new.document_id;
  -- An invisible document is document_event_override_guard's refusal (ERR_OVERRIDE_NOT_AUTHORISED), not this
  -- trigger's; the composite FK refuses a document that does not exist at all.
  if v_status is null then return new; end if;
  if v_status not in ('draft', 'submitted', 'approved') then
    raise exception
      'ERR_DOC_STATUS_ILLEGAL: document % is %; a credit-limit override is recorded before the document issues, '
      'which is when credit control compares it', new.document_id, v_status
      using errcode = 'check_violation';
  end if;
  new.approved_base_total := app.document_base_total(new.document_id, v_rate);
  return new;
end $$;
comment on function app.stamp_credit_override() is
  'Code review 2026-09-29: stamps approved_base_total on an accounting.credit_limit.override event, and '
  'refuses one on a document that is no longer draft, submitted or approved (ERR_DOC_STATUS_ILLEGAL).';
create trigger document_event_credit_override_amount
  before insert on app.document_event
  for each row
  when (new.event_kind = 'override' and new.override_code = 'accounting.credit_limit.override')
  execute function app.stamp_credit_override();

-- ── 3. the party open balance, in BASE currency ───────────────────────────────────────────────────────
-- One figure per party, one limit per party, so the comparison is in base (LEGACY-014: never compare a
-- foreign-currency amount against a base-currency figure). Posted rows only: a draft is not a debt.
-- A NULL `p_as_of` is "everything posted, whatever its date" — the figure credit control compares (A6: a
-- back-dated sale is not measured against what happened to be posted by its own date).
-- It FAILS CLOSED (LEGACY-042): `app.party.receivable_account_id` is NULLABLE (contracts §4.5.7), and a
-- predicate `l.account_id = <null>` matches no row, so a party carrying a limit but no control account
-- would report a 0.0000 exposure and every over-limit sale would issue — "an absent row makes a check
-- pass", which is LEGACY-042 exactly. This function therefore RAISES for that combination instead of
-- returning a zero. A party with no limit and no control account has no credit question to answer and
-- gets 0 without a raise, which is why the guard tests both columns and not one.
-- `stable` and unqualified reads, so it runs under the caller's RLS (spec:2053).
create function app.party_open_balance(p_party_id uuid, p_as_of date) returns numeric
language plpgsql stable as $$
declare
  v_account_id uuid;
  v_limit      numeric(19,4);
  v_found      boolean;
begin
  select true, p.receivable_account_id, p.credit_limit
    into v_found, v_account_id, v_limit
    from app.party p where p.id = p_party_id;
  if v_found is not true then
    raise exception 'ERR_NOT_FOUND: party % is not visible', p_party_id using errcode = 'check_violation';
  end if;
  if v_account_id is null then
    if v_limit is null then return 0::numeric(19,4); end if;
    raise exception
      'ERR_POLICY_REQUIRES_MISSING: party % carries a credit limit but no receivable control account — set '
      'party.receivable_account_id (§4.15 1200 trade receivables is the default) or clear the limit',
      p_party_id using errcode = 'check_violation';
  end if;
  -- coalesce at the accumulation boundary (LEGACY-011): a party with no posted row owes 0, never NULL.
  return (
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)
      from app.ledger_entry l
      join app.document     d on d.id = l.document_id
     where d.party_id = p_party_id
       and (p_as_of is null or d.effective_date <= p_as_of)
       and l.account_id = v_account_id);
end $$;
comment on function app.party_open_balance(uuid, date) is
  'contracts §4.8.1: the party balance the credit-control trigger and creditStatus() both read. Base currency, '
  'posted rows only, on the party''s own receivable control account (§4.15 1200 by default); a NULL date is no '
  'date cut. Raises ERR_POLICY_REQUIRES_MISSING when a party carries a limit and no control account — LEGACY-042, '
  'never a silent 0.';

-- ── 3a. the party's credit EXPOSURE, in BASE currency (A6) ───────────────────────────────────────────────
-- What a new sale is compared with: everything POSTED on the receivable control account, with no date cut,
-- plus every OTHER credit-extending document of the party (app.policy_extends_credit — a sale, never a
-- payment or a return to a vendor) that has passed this control and not yet posted — status `issued`, which
-- is the one state between the credit check (→ issued) and the ledger (→ posted). A void document has
-- released its claim and a posted one is already in the first term, so neither is counted twice. Each
-- document is measured by app.document_base_total at its own rate, so the pending figure is the ledger
-- figure it will become. `p_excluding_document_id` is the document being issued, which the trigger adds
-- itself. `stable` and unqualified reads: it runs under the caller's RLS, like party_open_balance.
create function app.party_credit_exposure(p_party_id uuid, p_excluding_document_id uuid) returns numeric
language sql stable as $$
  select app.party_open_balance(p_party_id, null)
       + coalesce((
           select sum(app.document_base_total(d.id, d.exchange_rate))
             from app.document d
            where d.party_id = p_party_id
              and d.status = 'issued'
              and d.id is distinct from p_excluding_document_id
              and app.policy_extends_credit(app.effective_policy(d.document_type_id, d.effective_date))),
           0)::numeric(19,4)
$$;
comment on function app.party_credit_exposure(uuid, uuid) is
  'contracts §4.8.1 (Phase 4 review A6): the figure credit control compares — posted receivable balance with no '
  'date cut, plus the party''s other issued-but-unposted credit-extending documents (app.policy_extends_credit), '
  'in base.';

-- ── 4. the control: BEFORE UPDATE OF status ON app.document ───────────────────────────────────────────
-- spec:2173 — the data layer is the control and the handler is a pre-flight. This is a SECOND before-trigger
-- beside 2B's app.document_status_before(); Postgres fires before-triggers alphabetically, so
-- document_credit_control runs first. 2B's function is not edited (its file is frozen).
create function app.assert_credit_available() returns trigger language plpgsql as $$
declare
  v_party       app.party%rowtype;
  v_doc_base    numeric(19,4);
  v_open        numeric(19,4);
begin
  -- Guard 1: no party, no credit question; and a party with neither a limit nor a hold has none either —
  -- WHATEVER its kind (A7: a limit or a hold configured on a dealer or a vendor is a control, not a no-op).
  -- Both are named guards rather than a fall-through of three-valued logic (LEGACY-042).
  if new.party_id is null then return new; end if;
  select * into v_party from app.party where id = new.party_id;
  if v_party.id is null then return new; end if;
  if v_party.credit_limit is null and not v_party.credit_hold then return new; end if;

  -- Guard 2: only a sale is a sale on credit — app.policy_extends_credit, an outbound policy that does not
  -- move the party's payable account (code review 2026-09-29: a PAYMENT, a PURCHASE_RETURN and a
  -- PURCHASE_CREDIT_NOTE are outbound too, and a vendor on hold could not be paid). An internal or inbound
  -- document is ignored, and a policy that cannot be resolved is ignored here — 2B's trigger is what refuses
  -- an unresolvable policy. `is distinct from true`, never `not`: an unknown answer is ignored, not negated
  -- (LEGACY-042).
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
  --    LEGACY-012). Do not "simplify" it into one query over the ledger — this document has no ledger rows at
  --    `→ issued`.

  -- 4. A second principal's override event, already authorised by 2B's document_event_override_guard
  --    (§4.5.3, spec:2179), that APPROVED at least this figure (code review 2026-09-29): the event carries
  --    the document's base total when it was recorded (§2c above), so a draft re-keyed upwards after the
  --    approval is compared like any other. This trigger asks nothing further about authority: two authority
  --    questions, asked differently, is how two answers appear (LEGACY-032).
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
comment on function app.assert_credit_available() is
  'contracts §4.8.1, spec:1026, spec:2179: refuses → issued of a credit-extending document '
  '(app.policy_extends_credit) of a party whose credit exposure (app.party_credit_exposure) would pass '
  'party.credit_limit (ERR_CREDIT_LIMIT_EXCEEDED) unless an accounting.credit_limit.override event approved at '
  'least the document''s base total; party.credit_hold refuses regardless (ERR_CREDIT_HOLD). A reversal '
  '(reverses_document_id set) whose base total is not positive lowers the exposure and is not controlled '
  '(code review 2, F2). Any party kind; the party row is locked, so concurrent issues serialise.';

-- The transition §4.8.1 names, and only it: `when` keeps every other status change from paying for the reads.
create trigger document_credit_control
  before update of status on app.document
  for each row
  when (new.status = 'issued' and old.status is distinct from 'issued')
  execute function app.assert_credit_available();

-- ── 4a. a payment term's days are fixed once a document is aged on them (A8, LEGACY-013) ────────────────────
-- The document PINS its term (§4.3.4) so the ageing cuts on what was agreed; editing the term's days in place
-- re-aged every issued and posted document pinned to it, which is LEGACY-013 by the back door. Once any document
-- other than a draft names the term, due_days / discount_days / discount_pct are refused — the remedy is a
-- new term. Names and archiving stay free, and a re-save of the same days is not a change. It lives in this
-- file, not 0044, because the column it reads (document.payment_term_id) is this file's.
create function app.assert_payment_term_days_unpinned() returns trigger language plpgsql as $$
begin
  if (new.due_days, new.discount_days, new.discount_pct)
       is not distinct from (old.due_days, old.discount_days, old.discount_pct) then
    return new;
  end if;
  if exists (select 1 from app.document d where d.payment_term_id = old.id and d.status <> 'draft') then
    raise exception
      'ERR_CONFLICT_REFERENCE: payment term % is pinned on a document that is no longer a draft; its days and '
      'discount are what that document is aged on (LEGACY-013) — create a new term instead', old.code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.assert_payment_term_days_unpinned() is
  'Phase 4 review A8, LEGACY-013: refuses changing due_days, discount_days or discount_pct of a payment term that '
  'a non-draft document pins (ERR_CONFLICT_REFERENCE).';
create trigger payment_term_days_pinned
  before update of due_days, discount_days, discount_pct on app.payment_term
  for each row execute function app.assert_payment_term_days_unpinned();

-- ── 4b. a party's control account is fixed once it has history (Phase 4 review B1) ───────────────────────
-- Every reader of a party's open items — 0048's ageing and its tie-out, 4A's allocation and credit control,
-- 4B's revaluation — finds the party's ledger rows through party.receivable_account_id / payable_account_id
-- AS THEY ARE NOW. Re-pointing either after a document posted left those rows on the old account: the open
-- items vanished from the ageing and the tie-out, and the invoice could no longer be allocated or revalued.
-- So the two columns are refused once any document of the party has POSTED (it alone has ledger rows; a
-- draft, submitted, approved or issued document posts to whatever the account is when it posts). A re-save
-- of the same value is not a change. The remedy for a genuinely new control account is a new party.
create function app.assert_party_control_unchanged() returns trigger language plpgsql as $$
begin
  if new.receivable_account_id is not distinct from old.receivable_account_id
     and new.payable_account_id is not distinct from old.payable_account_id then
    return new;
  end if;
  if exists (select 1 from app.document d
              where d.party_id = old.id and d.status in ('posted', 'reversed')) then
    raise exception
      'ERR_CONFLICT_REFERENCE: party % has posted documents; their ledger rows, ageing and allocations are read '
      'on its control account, which therefore cannot change — open a new party instead', old.code
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.assert_party_control_unchanged() is
  'Phase 4 review B1: refuses changing party.receivable_account_id / payable_account_id once a document of '
  'the party has posted (ERR_CONFLICT_REFERENCE).';
create trigger party_control_account_pinned
  before update of receivable_account_id, payable_account_id on app.party
  for each row execute function app.assert_party_control_unchanged();

-- ── 4c. a party's control account — the ONE definition (code review 2026-09-29) ─────────────────────────
-- The account a party's open items live on: a vendor's payable account, anyone else's receivable account,
-- each falling back to the other when only one is set (an employee or dealer carrying only a payable
-- account). Allocation, the party balance, the ageing and its tie-out, and the FX revaluation all read it
-- here: six spellings with two meanings let the ageing show an open item that allocation refused to settle.
-- Credit exposure (party_open_balance) is a different question — what the party owes US — and stays on
-- receivable_account_id. A row-typed SQL function with no FROM: the planner inlines it into each caller.
create function app.party_control_account(p app.party) returns uuid
language sql immutable as $$
  select case when (p).kind = 'vendor'
              then coalesce((p).payable_account_id, (p).receivable_account_id)
              else coalesce((p).receivable_account_id, (p).payable_account_id) end
$$;
comment on function app.party_control_account(app.party) is
  'Code review 2026-09-29: the account a party''s open items are read on — payable for a vendor, receivable '
  'otherwise, each falling back to the other. Every allocation, ageing, tie-out and revaluation reader uses it.';

-- ── 5. the posted → reversed signature excludes a partial credit note (A9) ──────────────────────────
-- 0022's app.document_status_before() admits posted → reversed when ANY posted document points
-- reverses_document_id at the original. This file introduced the second kind of such document — the partial
-- credit note — so this file narrows the signature. `create or replace` of 0022's function with one branch
-- changed and nothing else; 0045.down.sql restores 0022's exact body. 2B's function is otherwise unedited.
create or replace function app.document_status_before() returns trigger language plpgsql as $$
declare
  v_policy   jsonb;
  v_required boolean;
  v_approve  text;
  v_post     text;
  v_gate     text;
begin
  -- An UPDATE that lists status but does not change it is not a transition (a no-op re-save).
  if new.status is not distinct from old.status then
    return new;
  end if;

  v_policy := app.effective_policy(new.document_type_id, new.effective_date);
  if v_policy is null then
    raise exception 'ERR_POLICY_NOT_FOUND: no posting policy of document type % is effective on %',
      new.document_type_id, to_char(new.effective_date, 'YYYY-MM-DD') using errcode = 'check_violation';
  end if;
  v_required := coalesce((v_policy -> 'approval' ->> 'required')::boolean, false);
  v_approve  := v_policy -> 'approval' ->> 'approve';
  v_post     := v_policy -> 'approval' ->> 'post';

  -- ── 2a. the matrix (contracts §4.5.1). Every pair not named here is illegal. ──────────────────────
  if old.status = 'draft' and new.status = 'submitted' then
    null;                                                        -- always

  elsif old.status in ('draft', 'submitted') and new.status = 'issued' then
    if v_required then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: % → issued needs approval.required = false; document % must be approved first',
        old.status, new.id using errcode = 'check_violation';
    end if;

  elsif old.status = 'submitted' and new.status = 'approved' then
    null;                                                        -- R1 and R2 below

  elsif old.status in ('submitted', 'approved') and new.status = 'draft' then
    -- The one backward edge (spec:1188, 2081). R3 uses reason 'compensation_changed'; every caller must give one.
    if nullif(current_setting('app.event_reason', true), '') is null then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: returning document % from % to draft is a recalculation and needs a reason (spec:2081)',
        new.id, old.status using errcode = 'check_violation';
    end if;

  elsif old.status = 'approved' and new.status = 'issued' then
    null;                                                        -- authority was checked at approved

  elsif old.status = 'issued' and new.status in ('posted', 'void') then
    null;                                                        -- R1 and R2 below

  elsif old.status = 'posted' and new.status = 'reversed' then
    -- "Only by reverseDocument" expressed in data: 1A posts the reversing document BEFORE flipping the
    -- original, so a posted document carrying reverses_document_id = this one is that call's signature (D13).
    -- 0045 (4A, finding A9): 4A's partial credit note ALSO points reverses_document_id at the invoice and is
    -- posted, so on its own that signature let a bare UPDATE mark a half-credited invoice reversed while the
    -- ledger still held the other half. A partial note is the `returns` target of the invoice it credits
    -- (creditNoteFrom links it through linkFulfilment); the full mirror reverseDocument posts never is.
    if not exists (select 1 from app.document r
                    where r.reverses_document_id = new.id and r.status = 'posted'
                      and not exists (select 1 from app.document_link l
                                       where l.source_document_id = new.id
                                         and l.target_document_id = r.id
                                         and l.link_kind = 'returns')) then
      raise exception 'ERR_DOC_STATUS_ILLEGAL: document % can only be marked reversed by reverseDocument, which posts the reversing document first (D13, spec:2224)',
        new.id using errcode = 'check_violation';
    end if;

  else
    raise exception 'ERR_DOC_STATUS_ILLEGAL: % → % is not a legal transition for document % (contracts §4.5.1)',
      old.status, new.status, new.id using errcode = 'check_violation';
  end if;

  -- ── 2b. R1 maker <> checker (spec:2172). Read from document_event, which only triggers write. ─────
  if v_required and new.status in ('approved', 'posted') then
    if not exists (select 1 from app.document_event e
                    where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted') then
      raise exception 'ERR_SOD_NO_SUBMISSION: document % has no submitted event; its type requires a maker before a checker',
        new.id using errcode = 'check_violation';
    end if;
    if exists (select 1 from app.document_event e
                where e.document_id = new.id and e.event_kind = 'transition' and e.to_status = 'submitted'
                  and e.actor_id = app.current_actor()) then
      raise exception 'ERR_SOD_MAKER_IS_CHECKER: principal % submitted document % and cannot % it',
        app.current_actor(), new.id, case when new.status = 'approved' then 'approve' else 'post' end
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── 2c. R2 authority at transition time (spec:2173). NULL branch never fails open (LEGACY-042, LEGACY-050). ─
  if new.status = 'approved' then
    v_gate := coalesce(v_approve, v_post);          -- for approval.required = false types approve is null
  elsif new.status in ('posted', 'void') then
    v_gate := v_post;
  else
    v_gate := null;                                 -- submitted, draft and issued evaluate no code (ADR 0029)
  end if;

  if v_gate is null and new.status in ('approved', 'posted', 'void') then
    raise exception 'ERR_POLICY_INVALID: the policy effective for document % declares no approval.%',
      new.id, case when new.status = 'approved' then 'approve and no approval.post' else 'post' end
      using errcode = 'check_violation';
  end if;
  if v_gate is not null and not app.actor_has(v_gate, new.company_id, new.branch_id) then
    raise exception 'ERR_RBAC_FORBIDDEN: principal % does not hold % at branch % of company %',
      app.current_actor(), v_gate, new.branch_id, new.company_id using errcode = 'check_violation';
  end if;

  return new;
end $$;

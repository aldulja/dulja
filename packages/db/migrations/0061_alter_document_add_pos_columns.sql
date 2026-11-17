-- 0061_alter_document_add_pos_columns.sql
-- §3.8 document.client_ref/branch_id/attributed_to (spec:1764-1768) · §3.7.5 terminal identity (spec:1322)
-- · contracts §4.3.4 (the 6A row) · §4.14 (the POS-<terminal code> series, spec:1721).

-- ── 1. the acting terminal on a document ──────────────────────────────────────────────────────────────
-- The terminal is ALREADY the acting principal through created_by/posted_by (LEGACY-044); this column records
-- WHICH terminal, which is what the numbering suffix, the Z-report and the branch scoping all read.
alter table app.document add column terminal_id uuid;
alter table app.document add constraint document_terminal_fk
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id);
create index document_terminal_idx on app.document (terminal_id) where terminal_id is not null;

-- ── 1b. the till's shift, WITHOUT a foreign key (Task 0 amendment 6; 6D's own amendment A2) ────────────
-- applyTicket writes this on every POS_TICKET from the first ticket 6A applies, so the column has to exist
-- here: `app.shift` is 6D's table and arrives at 0070, long after tills are selling. No FK is added here and
-- NONE is added at 0070 either — PostgreSQL's referential-integrity scan BYPASSES row security, so validating
-- a key at 0070 would see every ticket written between 6B's release and 6D's, each naming a shift with no row;
-- and a migration cannot backfill the parents, because FORCE ROW LEVEL SECURITY binds app_migrator and a
-- migration file sets no tenant (hazard 10). 6D enforces the reference in the apply path (`assertShiftKnown`,
-- which refuses a shiftId that names no shift OF THAT TERMINAL) and adds only the index `document_shift_idx`.
alter table app.document add column shift_id uuid;

-- ── 2. the terminal's numbering code (spec:1721 'POS-KL01') ───────────────────────────────────────────
-- Nullable, because §3.4.7 makes any change to a table that holds production rows an expand step; every row
-- is written by 6A's own enrolment route, so no backfill exists and a contract step is never needed.
alter table app.pos_terminal add column code text;
alter table app.pos_terminal add constraint pos_terminal_company_id_code_key unique (company_id, code);

-- ── 3. document_line.kind — the FULL union, both phases' labels (§4.3.4) ──────────────────────────────
-- 8B's 0087 writes the identical list. Phase 8 may execute before or after Phase 6 (spec:2301), so a file
-- listing only "the labels admitted so far" would drop the other phase's label when it ran second. Both files
-- are therefore idempotent in either order.
alter table app.document_line drop constraint document_line_kind_check;
alter table app.document_line add constraint document_line_kind_check
  check (kind in ('account','item','tax','text','tender','payroll'));

comment on column app.document.terminal_id is
  'The POS terminal that synced this document (spec:1322). The ACTING principal is the terminal''s principal through created_by/posted_by; this is which terminal it was.';
comment on column app.document.shift_id is
  'The till shift this document belongs to, minted at the terminal. Deliberately NO foreign key: app.shift is 6D''s (0070) and RI checks bypass RLS, so the reference is enforced in the sync apply path instead.';
comment on column app.pos_terminal.code is
  'The numbering suffix: POS_TICKET numbers on "<policy series>-<code>" so two tills never contend for one counter (spec:1721).';

-- ── 4. POS receivable exposure (spec:1351, contracts §4.10.4, ADR 0056 amendment) ────────────
-- Tender-policy shapes settle cash separately; the account line carries debit/credit but zero gross.
-- Keep the pre-6A arithmetic and controls for every policy that has no tender rule.
create or replace function app.document_base_total(p_document_id uuid, p_exchange_rate numeric) returns numeric
language sql stable as $$
  select coalesce(sum(case
           when dl.kind = 'tender' and exists (
             select 1 from app.document d,
               jsonb_array_elements(coalesce(app.effective_policy(d.document_type_id, d.effective_date) -> 'lines', '[]'::jsonb)) r
              where d.id = p_document_id and r -> 'when' ->> 'line.kind' = 'tender')
           then -round(dl.amount * p_exchange_rate, 4)
           else round(dl.total_incl_tax * p_exchange_rate, 4)
         end), 0)::numeric(19,4)
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
  -- Phase 6, §4.10.4: paid tickets and refunds under a tender policy add no receivable exposure.
  -- A positive account sale still takes the locked-party hold/limit/override path below.
  if v_doc_base <= 0 and (new.reverses_document_id is not null or exists (
    select 1 from jsonb_array_elements(coalesce(
      app.effective_policy(new.document_type_id, new.effective_date) -> 'lines', '[]'::jsonb)) r
     where r -> 'when' ->> 'line.kind' = 'tender')) then
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

comment on function app.document_base_total(uuid, numeric) is
  'contracts §4.10.4: line-rounded gross less line-rounded tender amounts for tender policies; '
  'the original sum of line-rounded gross otherwise. Shared by credit control, pending exposure and overrides.';

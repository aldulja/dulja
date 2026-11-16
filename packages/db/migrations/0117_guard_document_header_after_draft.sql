-- ── 0117 · app.document's header is frozen once the document leaves draft ─────────────────────────────
-- Phase 4 code-review pass 3 (not a slice); number registered in Plan Contracts §3.4.1's tail.
--
-- spec:574 (SAH-041) "issued financial documents are immutable"; spec:501 and 2223 (SAH-031) "immutability is
-- enforced on the whole document aggregate (header + lines + projections)"; spec:2049 "Financial rows: never —
-- reversal only"; spec:2173 makes the data layer, not the handler, the control. 0113 froze the LINES of a
-- non-draft document; the header stayed writable to any app_rw session. A posted invoice's effective_date,
-- exchange_rate, party_id, branch_id or currency could be rewritten under a ledger that no longer agreed with
-- it (the ageing and credit exposure read the header's party and date), its number or series re-keyed, its
-- posting_policy_id re-pinned — and reverseDocument then mirrored the tampered header, not what posted — or an
-- APPROVED payment re-dated or re-addressed after the checker approved it.
--
-- The column audit. Every UPDATE of app.document in the tree (packages/db/src; apps/* issue none; no
-- migration updates a document row), with the status it runs at and the columns it writes:
--   lifecycle.ts  transitionDocument  draft → submitted; submitted → approved; submitted/approved → draft
--                                      (the one backward edge): `status` only. `to: issued` delegates below.
--   issue.ts      issueDocument       draft/submitted/approved → issued: `status`, `series`,
--                                      `fiscal_period_id`, `number` (contracts §4.3.6).
--   post.ts       step 8              at issued: `posting_seq`, NULL → nextval (coalesce keeps a set one).
--   post.ts       step 13             issued → posted: `status`, `posting_policy_id` (the pin, spec:1753),
--                                      `posted_at`, `posted_by` (stamp_posted_by then stamps the actor).
--   reverse.ts    reverseDocument     posted → reversed: `status` only (the mirror is a new, drafted row).
--   reverse.ts    voidDocument        issued → void: `status` only.
-- Everything else — payment_term_id and rate_source (4A's drafting services and the fixtures), party_id,
-- warehouse_id, notes, reverses_document_id (creditNoteFrom, the conversions, the replay's COST_ADJUSTMENT) —
-- is written by an INSERT of a draft or an UPDATE of a draft, and a draft stays free. Attachments, allocations,
-- links and bank matches are rows of their own tables and never touch the header.
--
-- So, once OLD.status is not 'draft', a change is admitted only to:
--   status                                         always — 0022's document_status_before owns the matrix,
--                                                  R1 and R2 (and 0045's credit control the issue edge);
--   series, fiscal_period_id, number               on the issue edge (→ issued from submitted or approved);
--   posting_seq                                    at issued while it is still NULL, and only as the
--                                                  session's currval of app.posting_seq (step 8's draw);
--   posting_policy_id, posted_at, posted_by        on the post edge (issued → posted, step 13).
-- The comparison is whole-row — to_jsonb(new) minus the admitted keys against to_jsonb(old) minus the same
-- keys — so a column a later slice adds is frozen with no edit here. A LATER expand/contract migration that
-- backfills a new column on non-draft documents must amend this function in its own migration; the trigger
-- may never be disabled, not even for a backfill (AGENTS.md).
--
-- Before that, the posting fields: posting_seq, posted_at and posted_by are NULL until postDocument writes
-- them (step 8 draws posting_seq at issued, step 13 stamps posted_at and posted_by on the post edge), so a
-- draft may not carry them — not by an UPDATE of the draft, not on its issue edge, and not from its INSERT. A
-- draft was otherwise free, and step 8 is `coalesce(posting_seq, nextval('app.posting_seq'))`: a posting_seq
-- written on the draft survived the post and placed the document wherever its writer chose in the cost
-- replay's (effective_date, posting_seq) order. posting_policy_id is left to the draft (1A's JOURNAL fixture
-- pins one there, and step 13 overwrites it with the policy it evaluated). An INSERT is otherwise not guarded
-- here: a document can still be INSERTed with a non-draft status, and 0113 refuses its lines.
--
-- Composition. BEFORE UPDATE row triggers fire in name order: document_credit_control (0045, on the issue
-- edge), then this one, then document_status_before (0022), stamp_created_by and stamp_posted_by (0001). So a
-- header tamper is refused here before the matrix runs, a status-only change reaches the matrix unchanged,
-- and posted_by is compared as the writer supplied it (stamp_posted_by replaces it with the actor after). On
-- INSERT the only other BEFORE triggers are the two stamps, which also sort after this one.
-- This function reads only OLD, NEW and the session's currval of app.posting_seq: no lock, no other table.

create function app.document_header_frozen_after_draft() returns trigger language plpgsql as $$
declare
  v_admitted text[] := array['status'];
  v_changed  text;
  v_drawn    bigint;
begin
  if tg_op = 'INSERT' then
    v_changed := concat_ws(', ', case when new.posting_seq is not null then 'posting_seq' end,
                                 case when new.posted_at is not null then 'posted_at' end,
                                 case when new.posted_by is not null then 'posted_by' end);
  elsif old.status = 'draft' then
    v_changed := concat_ws(', ', case when new.posting_seq is distinct from old.posting_seq then 'posting_seq' end,
                                 case when new.posted_at is distinct from old.posted_at then 'posted_at' end,
                                 case when new.posted_by is distinct from old.posted_by then 'posted_by' end);
  end if;
  if v_changed <> '' then
    raise exception 'ERR_DOC_STATUS_ILLEGAL: document % is %; % is written by the posting service when it posts, never on a draft (contracts §4.3.5, §4.3.2 steps 8 and 13)',
      new.id, coalesce(old.status, new.status), v_changed using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' or old.status = 'draft' then
    return new;
  end if;

  if new.status = 'issued' and old.status in ('submitted', 'approved') then
    v_admitted := v_admitted || array['series', 'fiscal_period_id', 'number'];       -- issueDocument
  end if;
  if old.status = 'issued' and old.posting_seq is null then
    v_admitted := v_admitted || array['posting_seq'];                                -- postDocument step 8
  end if;
  if old.status = 'issued' and new.status = 'posted' then
    v_admitted := v_admitted || array['posting_policy_id', 'posted_at', 'posted_by']; -- postDocument step 13
  end if;

  -- posting_seq is admitted only as currval('app.posting_seq'): the last value THIS SESSION drew from the
  -- sequence. For step 8 (`coalesce(posting_seq, nextval('app.posting_seq'))`) that is the value its own
  -- statement just drew, and a value supplied by hand — which would re-order the document in the cost
  -- replay's (effective_date, posting_seq) order (contracts §4.3.5) — is refused. It does NOT prove the value
  -- was drawn by this statement, nor in this transaction: currval is session-scoped, so on a pooled app_rw
  -- connection or a psql session a value drawn by an earlier, committed transaction is still admitted, after
  -- other sessions have drawn higher numbers (code review 4; recorded with residual (d)). A value is still
  -- used once only per company (0013's unique key), and the replay orders by it only within one
  -- effective_date. A strict check needs step 8's draw made visible to this trigger, such as a
  -- transaction-local setting written in the same statement.
  if new.posting_seq is distinct from old.posting_seq and 'posting_seq' = any(v_admitted) then
    begin
      v_drawn := currval('app.posting_seq');
    exception when object_not_in_prerequisite_state then
      v_drawn := null;                                   -- nothing drawn in this session
    end;
    if new.posting_seq is distinct from v_drawn then
      raise exception 'ERR_DOC_NOT_DRAFT: document % is %; posting_seq is drawn from app.posting_seq by the posting service, never supplied (contracts §4.3.5)',
        old.id, old.status using errcode = 'check_violation';
    end if;
  end if;

  if (to_jsonb(new) - v_admitted) is distinct from (to_jsonb(old) - v_admitted) then
    select string_agg(n.key, ', ' order by n.key) into v_changed
      from jsonb_each(to_jsonb(new) - v_admitted) n
     where n.value is distinct from (to_jsonb(old) -> n.key);
    raise exception 'ERR_DOC_NOT_DRAFT: document % is %; its header cannot be changed (%) — an issued document is voided and a posted one is reversed (spec:574, 2049, 2224)',
      old.id, old.status, v_changed using errcode = 'check_violation';
  end if;
  return new;
end $$;
comment on function app.document_header_frozen_after_draft() is
  'Code review 3 (R10): refuses an UPDATE of a non-draft app.document except status (0022 owns the matrix), '
  'series/fiscal_period_id/number on the issue edge, posting_seq at issued while NULL (as the session''s '
  'currval of app.posting_seq), and '
  'posting_policy_id/posted_at/posted_by on the post edge (ERR_DOC_NOT_DRAFT); and a posting_seq, posted_at '
  'or posted_by on a draft, by INSERT or UPDATE (ERR_DOC_STATUS_ILLEGAL). A backfill of a new column on '
  'non-draft documents amends this function in its own migration; the trigger is never disabled.';

create trigger document_header_frozen_after_draft before insert or update on app.document
  for each row execute function app.document_header_frozen_after_draft();

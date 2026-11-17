-- 0050_create_bank_match.sql
-- Slice 4B. Contracts §4.8.3; ADR 0048; acceptance test 39 (spec:2457).
-- A match is a row HERE and nowhere else: no ledger_entry, no account_balance and no document row is
-- written, updated or deleted by matching or unmatching, so test 39's ledger fingerprint is byte-identical
-- before the first match and after the last unmatch. LEGACY-031's failure was a direct UPDATE on a locked voucher
-- rewriting the balances; LEGACY-041's was hard deletion with the anti-tampering triggers shipped inactive.
-- Financial rows: reversed by `unmatched_at`, never deleted (spec:2049); §3.5.4's DELETE list is unchanged.

-- ── 1. the company-binding key the match row needs on its statement line ─────────────────────────────────
-- 0049 gave bank_statement_line `unique (tenant_id, id)` only. RLS bounds the tenant and nothing else, so a
-- plain (tenant_id, statement_line_id) key would let a match row name company A while pointing at a line of
-- sibling company B inside the same tenant; this key is the target of the composite FK below, exactly as
-- 0049's own line → statement key rides company_id.
alter table app.bank_statement_line
  add constraint bank_statement_line_tenant_id_company_id_id_key unique (tenant_id, company_id, id);

-- ── 2. the table (§4.8.3's DDL, plus the reason the unmatch compels) ──────────────────────────────────────
create table app.bank_match (
  id                       uuid primary key default uuidv7(),                 -- §3.2 identifiers (LEGACY-021)
  tenant_id                uuid not null references app.tenant(id),
  company_id               uuid not null,
  statement_line_id        uuid not null,
  reconcilable_kind        text not null,
  reconcilable_document_id uuid not null,
  -- A MAGNITUDE. The direction comes from bank_statement_line.amount's sign, so no reader ever infers a
  -- direction from this figure (§4.4.2 A9's rule applied one layer out, ADR 0048). In the statement's own
  -- currency, which is its bank account's.
  amount                   numeric(19,4) not null,
  matched_by               uuid not null default app.current_actor() references app.principal(id),  -- stamped below (LEGACY-044)
  matched_at               timestamptz not null default now(),
  unmatched_by             uuid references app.principal(id),                 -- stamped on the NULL → value transition
  unmatched_at             timestamptz,                                       -- the reversal: set once, never cleared
  unmatch_reason           text,                                              -- the reason `unmatch` compels (ADR 0023's loss)
  created_at               timestamptz not null default now(),
  constraint bank_match_amount_check check (amount > 0),
  -- 6D's and 8C's labels are admitted now, so neither slice edits this table to plug its source in (F-5).
  constraint bank_match_kind_check
    check (reconcilable_kind in ('receipt', 'payment', 'till_banking', 'payroll_batch')),
  -- Both unmatch columns move together, so "unmatched with no actor" is unrepresentable.
  constraint bank_match_unmatch_pair_check
    check ((unmatched_at is null and unmatched_by is null)
        or (unmatched_at is not null and unmatched_by is not null)),
  unique (tenant_id, id),
  -- composite: an FK check bypasses RLS, so a plain `references` would admit another tenant's row (LEGACY-035)
  foreign key (tenant_id, company_id)                    references app.company(tenant_id, id),
  -- company_id rides the key, so a match's company is its statement line's, never a second, unbound column
  foreign key (tenant_id, company_id, statement_line_id) references app.bank_statement_line(tenant_id, company_id, id),
  foreign key (tenant_id, reconcilable_document_id)      references app.document(tenant_id, id)
);

comment on column app.bank_match.unmatch_reason is
  'The reason `unmatch` compels its caller to supply. It is a COLUMN and not a log line: app.audit_row writes '
  'to_jsonb(new) of the row, so a value never written to a column cannot appear in the audit image — the '
  'loss ADR 0023 fixed for fiscal_period.reopen_reason and 4A amendment 11 fixed for allocation.';

-- ── 3. tenancy, audit, stamps, privileges (§3.5.1) ─────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.bank_match');              -- spec:106; policy `tenant_isolation`, RLS enabled AND forced
call app_meta.attach_audit('app.bank_match');                    -- spec:106; every match and unmatch is audited, both images
-- BOTH stamps. §4.8.3 states it and the linter requires it: the stamp_actor rule fires on EVERY column whose
-- name ends `_by` and lacks a stamp_<col> trigger (plan0A:2755-2758) and §3.5.2 requires zero violations. It
-- is also the right behaviour — stamp_actor stamps on the NULL → value transition (plan0A:2379-2380), which
-- is exactly when unmatch() sets unmatched_by, and raises ERR_ACTOR_IMMUTABLE on any later change.
call app_meta.attach_stamp('app.bank_match', 'matched_by');
call app_meta.attach_stamp('app.bank_match', 'unmatched_by');
-- app_rw receives select, insert, update through default privileges (plan0A:2564). NO DELETE: a match is
-- reversed by setting unmatched_at, never removed (§3.5.4's pinned list is unchanged by this slice).

-- ── 4. the lookups every read of this table performs ─────────────────────────────────────────────────────
-- One LIVE match per (line, document) pair: a second is a double-count, and re-matching after an unmatch is
-- legal because the partial index covers only `unmatched_at is null`. Its leading column is also the
-- per-line Σ that listStatementLines, unmatchedStatementLines and match() read. The second index is the
-- per-document Σ that the sources' unmatchedOnly filter and match()'s capacity read. Plain `create index`,
-- never `concurrently`: a migration file runs whole in one transaction (§3.4.5).
create unique index bank_match_live_idx
  on app.bank_match (statement_line_id, reconcilable_document_id) where unmatched_at is null;
create index bank_match_document_idx
  on app.bank_match (reconcilable_document_id) where unmatched_at is null;

-- ── 5. what may change: the unmatch, once, with its reason (spec:2457, LEGACY-041) ──────────────────────────
-- 0046's allocation_guard, applied to the twin table. A match is born live, and the ONE legal update is the
-- unmatch transition with its reason and its stamped actor. Every figure and every reference is fixed at
-- insert: a direct app_rw UPDATE of `amount` would change what reconciledBalance says without any
-- audit-visible unmatch, and clearing `unmatched_at` would resurrect a reversed match. The stamp triggers
-- still guard the two *_by columns on their own.
create function app.bank_match_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.unmatched_at is not null or new.unmatched_by is not null or new.unmatch_reason is not null then
      raise exception 'ERR_TABLE_IMMUTABLE: a bank match is inserted live; it is unmatched by updating its own row'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.id, new.tenant_id, new.company_id, new.statement_line_id, new.reconcilable_kind,
      new.reconcilable_document_id, new.amount, new.matched_by, new.matched_at, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.company_id, old.statement_line_id, old.reconcilable_kind,
      old.reconcilable_document_id, old.amount, old.matched_by, old.matched_at, old.created_at) then
    raise exception 'ERR_TABLE_IMMUTABLE: bank match % is fixed at insert; unmatch it and match again', old.id
      using errcode = 'check_violation';
  end if;
  if old.unmatched_at is not null then
    raise exception 'ERR_TABLE_IMMUTABLE: bank match % is already unmatched; an unmatch is never undone', old.id
      using errcode = 'check_violation';
  end if;
  if new.unmatched_at is null then
    raise exception 'ERR_TABLE_IMMUTABLE: bank match % changes only by being unmatched', old.id
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(new.unmatch_reason), '') is null then
    raise exception 'ERR_VALIDATION_FAILED: unmatching bank match % needs a reason (spec:2457)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
-- Named so it sorts before stamp_matched_by/stamp_unmatched_by: BEFORE triggers fire in name order, so the
-- guard reads the values the statement wrote, before a stamp overwrites the actor.
create trigger bank_match_guard before insert or update on app.bank_match
  for each row execute function app.bank_match_guard();  -- LEGACY-041: live at insert; unmatch only, and only once

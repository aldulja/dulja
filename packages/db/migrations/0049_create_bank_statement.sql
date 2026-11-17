-- 0049_create_bank_statement.sql
-- Slice 4B. §3.0.4 row 1043 "Bank reconciliation — statement import (CSV)…"; contracts §4.8.3; ADR 0048.
-- A statement line is a fact about the BANK. Nothing in this slice writes a ledger_entry from one:
-- LEGACY-031's failure was a direct UPDATE on a locked voucher silently rewriting the balances, and
-- LEGACY-041's was hard deletion with the anti-tampering triggers shipped inactive (ADR 0048).
-- Financial facts: never deleted (spec:2049); §3.5.4's app_rw DELETE list is unchanged by this file.

-- ── 1. app.bank_statement ──────────────────────────────────────────────────────────────────────────────
create table app.bank_statement (
  id                        uuid primary key default uuidv7(),               -- §3.2 identifiers (LEGACY-021)
  tenant_id                 uuid not null references app.tenant(id),
  company_id                uuid not null,
  bank_account_id           uuid not null,                                   -- the app.account of the bank (1100 by default)
  statement_date            date not null,
  opening_balance           numeric(19,4) not null,                          -- LEGACY-011: not null, and the import proves it adds up
  closing_balance           numeric(19,4) not null,
  currency                  char(3) not null,                                -- coalesce(account.currency, company.base_currency); no FK, as app.party.currency (§4.5.7)
  source_file_attachment_id uuid,                                            -- 2C's attachment holding the original CSV
  imported_by               uuid not null default app.current_actor() references app.principal(id),  -- stamped below (LEGACY-044)
  created_at                timestamptz not null default now(),
  -- contracts §4.8.3: one statement per account per date. Named so the import can lift it into
  -- ERR_CONFLICT_UNIQUE with a fixed detail instead of the driver's text (LEGACY-083).
  constraint bank_statement_company_id_bank_account_id_statement_date_key
    unique (company_id, bank_account_id, statement_date),
  unique (tenant_id, id),
  -- the target of bank_statement_line's company-binding key below: RLS bounds the tenant and nothing else,
  -- so a line must not be able to name a statement of a sibling company inside the same tenant
  unique (tenant_id, company_id, id),
  -- composite: an FK check bypasses RLS, so a plain `references` would admit another tenant's row (LEGACY-035)
  foreign key (tenant_id, company_id)                references app.company(tenant_id, id),
  foreign key (tenant_id, bank_account_id)           references app.account(tenant_id, id),
  foreign key (tenant_id, source_file_attachment_id) references app.attachment(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.bank_statement');                -- policy `tenant_isolation`, RLS enabled AND forced (spec:106)
call app_meta.attach_audit('app.bank_statement');                      -- spec:106; test 13 covers this table from now on
call app_meta.attach_stamp('app.bank_statement', 'imported_by');       -- server-supplied actor, never a payload (LEGACY-044)
-- app_rw receives select, insert, update through default privileges (plan0A:2564). No DELETE (§3.5.4).

-- ── 2. app.bank_statement_line ─────────────────────────────────────────────────────────────────────────
create table app.bank_statement_line (
  id           uuid primary key default uuidv7(),                            -- §3.2 identifiers (LEGACY-021)
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  statement_id uuid not null,
  line_no      int not null,
  value_date   date not null,
  description  text not null,
  reference    text,
  -- SIGNED, and the sign is the bank's own convention: positive is money IN. app.bank_match.amount (0050) is
  -- a MAGNITUDE and takes its direction from this sign (§4.4.2 A9's rule applied one layer out, ADR 0048).
  amount       numeric(19,4) not null,
  created_at   timestamptz not null default now(),
  constraint bank_statement_line_line_no_check check (line_no > 0),
  -- a zero movement is not a fact about the bank, and a zero line could never be matched (ADR 0048)
  constraint bank_statement_line_amount_check  check (amount <> 0),
  unique (statement_id, line_no),                                            -- contracts §4.8.3; also the statement's line lookup
  unique (tenant_id, id),                                                    -- the target of 0050's bank_match key
  foreign key (tenant_id, company_id)               references app.company(tenant_id, id),
  -- No `on delete cascade`: app_rw holds no DELETE on either table (§3.5.4 is pinned) and spec:2049
  -- admits deletion only for drafts and the erasure workflow. A wrong statement is superseded, not deleted.
  -- company_id rides the key so a line's company is its statement's, never a second, unbound column.
  foreign key (tenant_id, company_id, statement_id) references app.bank_statement(tenant_id, company_id, id)
);
call app_meta.enable_tenant_rls('app.bank_statement_line');           -- policy `tenant_isolation`, RLS enabled AND forced (spec:106)
call app_meta.attach_audit('app.bank_statement_line');                 -- spec:106; test 13 covers this table from now on
-- No *_by column, so no attach_stamp (contracts §3.3's naming rule).

-- ── 3. what an UPDATE may change: nothing (code review B6) ───────────────────────────────────────────
-- A statement and its lines are the BANK's evidence, imported once and read by every match against them.
-- app_rw keeps UPDATE on both through default privileges (plan0A:2564), so without a guard a matched line's
-- amount or a statement's closing balance could be rewritten after the fact with no reversal anywhere —
-- while app.allocation (0046) and app.bank_match (0050), the rows beside them, are fixed at insert. Nothing
-- in the tree updates either table (importStatement inserts both, once), so EVERY update is refused, for
-- every role, by 0001's append-only guard — as document_event (0021) and inventory_movement (0031) are. A
-- wrong statement is superseded, never edited. Both triggers go with their tables in 0049.down.sql.
create trigger bank_statement_immutable before update on app.bank_statement
  for each row execute function app.forbid_change();
create trigger bank_statement_line_immutable before update on app.bank_statement_line
  for each row execute function app.forbid_change();

-- ── 4. lookups ─────────────────────────────────────────────────────────────────────────────────────────
-- 0050's matching reads a company's lines by value date. The (statement_id, line_no) lookup needs no index
-- of its own: the unique constraint above already is one.
create index bank_statement_line_value_date_idx on app.bank_statement_line (company_id, value_date);

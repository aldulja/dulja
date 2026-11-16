-- 0101_add_legacy_ref.sql — contracts §4.13.3; spec §5.1 #8 (spec:2333): "Document numbers may contain
-- duplicates and gaps (SAH-051). Preserve them as historical strings; start the new gapless series after
-- cut-over." The historical string lives here; app.document.number stays a gapless bigint owned by
-- app.document_series (§4.3.6) and no legacy value is ever written into it.
--
-- Expand only (§3.4.7): six nullable columns and six partial indexes on live tables, no backfill, no
-- constraint, no rewrite. There is no contract half: legacy_ref is permanent.

-- ── 1. the six columns (§4.13.3 names exactly these tables) ───────────────────────────────────────────
alter table app.document add column legacy_ref text;
alter table app.party    add column legacy_ref text;
alter table app.item     add column legacy_ref text;
alter table app.account  add column legacy_ref text;
alter table app.employee add column legacy_ref text;
alter table app.lot      add column legacy_ref text;

comment on column app.document.legacy_ref is
  'SAH-051 — the source system''s own document number, kept as a string. Not unique: the legacy numbering had duplicates and gaps.';
comment on column app.party.legacy_ref is 'The source system''s account/customer/vendor code (§5.1 #8).';
comment on column app.item.legacy_ref is 'The source system''s material code (§5.1 #8).';
comment on column app.account.legacy_ref is 'The source system''s chart-of-accounts code (§5.1 #8).';
comment on column app.employee.legacy_ref is 'The source system''s employee number (§5.1 #11, #12).';
comment on column app.lot.legacy_ref is 'The source system''s batch code (§5.1 #8).';

-- ── 2. one partial index each, on (company_id, legacy_ref) ────────────────────────────────────────────
-- Partial because only imported rows carry the column; non-unique because SAH-051 says the source
-- numbering is not unique and an import that refused a duplicate would refuse the customer's own data.
-- No `create index concurrently` — a migration file is one transaction (§3.4.3).
create index document_legacy_ref_idx on app.document (company_id, legacy_ref) where legacy_ref is not null;
create index party_legacy_ref_idx    on app.party    (company_id, legacy_ref) where legacy_ref is not null;
create index item_legacy_ref_idx     on app.item     (company_id, legacy_ref) where legacy_ref is not null;
create index account_legacy_ref_idx  on app.account  (company_id, legacy_ref) where legacy_ref is not null;
create index employee_legacy_ref_idx on app.employee (company_id, legacy_ref) where legacy_ref is not null;
-- app.lot carries company_id (§4.6.1) as well as item_id, so the same shape applies.
create index lot_legacy_ref_idx      on app.lot      (company_id, legacy_ref) where legacy_ref is not null;

-- 0019_alter_document_line_generalise.sql — one line table for every document (spec:1185; contracts §4.3.4,
-- the 2A row). Every column is nullable or defaulted: this is the EXPAND half of expand/contract on a live
-- table (spec:2057, contracts §3.4.7). Nothing is renamed and nothing is dropped.

-- ── 1. the ten columns ────────────────────────────────────────────────────────────────────────────────
alter table app.document_line
  add column kind            text not null default 'account',
  add column item_id         uuid,                                  -- FK (tenant_id, item_id) → app.item in 3A's 0032
  add column quantity        numeric(19,6),                         -- item base unit; entered unit lands in 3A's 0032
  add column unit_price      numeric(19,4),
  add column discount        numeric(19,4) not null default 0,
  add column amount          numeric(19,4) not null default 0,      -- excluding tax, in the document currency
  add column tax_code_id     uuid,                                  -- FK (tenant_id, tax_code_id) → app.tax_code in 5A's 0055
  add column tax_amount      numeric(19,4) not null default 0,
  add column total_incl_tax  numeric(19,4) not null default 0,
  add column cost            numeric(19,4);                         -- written by the costing engine at post (3B)

-- ── 2. The kind vocabulary, NAMED so 6A's 0061 and 8B's 0087 can drop it by name ─────────────────────
-- Those two files each re-add the CHECK with the identical complete union
-- ('account','item','tax','text','tender','payroll'); either phase may execute first (spec:2301), so
-- neither may rely on a generated constraint name (contracts §4.3.4).
alter table app.document_line
  add constraint document_line_kind_check check (kind in ('account', 'item', 'tax', 'text'));

-- ── 3. The lookups the snapshot and the reports make (LEGACY-070) ────────────────────────────────────────
create index document_line_item_idx on app.document_line (item_id) where item_id is not null;

-- No branch key: a line is isolated through its parent document's own branch_isolation policy
-- (contracts §4.5.6 — "document_line is deliberately absent"). BRANCH lives on document.branch_id.

-- 0013_alter_document_add_posting_seq.sql — two alters on 0001 tables.
-- Both are expand-only: a nullable column and a new sequence, no rewrite of an existing column (spec:2057).

-- ── 1. document.posting_seq — the costing engine's chronological key (contracts §4.3.5) ───────────────
-- Assigned once, at post, at step 8 of the posting algorithm, BEFORE any row that carries it is written:
-- inventory_movement.posting_seq, cost_layer.sequence and tax_transaction.posting_seq are all NOT NULL in
-- the slices that add them. Gaps are irrelevant — a rolled-back post burns a number and blocks nobody. What
-- matters is a total order per company, which the unique below guarantees. Contrast document_series, which
-- is a locked per-period counter because a document NUMBER must be gapless-provable (spec:2222, SAH-051).
create sequence app.posting_seq;
grant usage on sequence app.posting_seq to app_rw;      -- 0001 grants default privileges on TABLES only (plan0A:2564)

alter table app.document add column posting_seq bigint;
alter table app.document add constraint document_company_id_posting_seq_key unique (company_id, posting_seq);

-- ── 2. fiscal_period.reopen_reason — the reason spec:2179 requires in the audit row (ADR 0023) ────────
-- app.audit_log has no reason column and app.audit_row() writes to_jsonb(new) with no parameter for one
-- (plan0A:2308-2332), so "a reason written to the audit row" means a column on the row: the update that
-- reopens the period carries the reason, and the audited after-image holds it beside the actor the chain
-- trigger stamped. 1B's nightly integrity job reports every reopen by reading after ->> 'reopen_reason'.
alter table app.fiscal_period add column reopen_reason text;

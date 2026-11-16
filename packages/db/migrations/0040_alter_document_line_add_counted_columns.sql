-- ── 0040 · document_line gains the two count columns (contracts §4.3.4, the 3D row) ───
-- spec:1052 "Stock count / cycle count with variance posted through a STOCK_COUNT document".
-- spec:1053 "dispatched into an in-transit warehouse, received at the branch, variance on receipt".
-- Expand only (spec:2057, contracts §3.4.7): two nullable columns, no rename, no drop, no backfill.
-- SAH-018: the VARIANCE itself gets no column — app.document_line.quantity carries
-- counted_quantity - expected_quantity and every consumer derives from that one number.
-- Nothing here writes a row: hazard 10, and FORCE ROW LEVEL SECURITY binds app_migrator too (spec:1366).

-- ── 1. the two columns ──────────────────────────────────────────────────────────────────────────
alter table app.document_line
  add column counted_quantity  numeric(19,6),   -- what the counter / receiver actually found
  add column expected_quantity numeric(19,6);   -- snapshot of stock_on_hand (STOCK_COUNT) or the dispatched quantity (TRANSFER_RECEIPT)

-- ── 2. what each column means, recorded where a DBA reads it (spec:2043 — the base unit) ─────────
comment on column app.document_line.counted_quantity is
  'STOCK_COUNT: the counted quantity. TRANSFER_RECEIPT: the received quantity. Base unit (spec:2043).';
comment on column app.document_line.expected_quantity is
  'STOCK_COUNT: stock_on_hand at count time. TRANSFER_RECEIPT: the dispatched quantity. Base unit.';
comment on column app.document_line.quantity is
  'Base unit. On a line carrying both count columns this is the signed VARIANCE '
  '(counted_quantity - expected_quantity); when: { "line.quantity_sign": ... } resolves from it (ADR 0042).';

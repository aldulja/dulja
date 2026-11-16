-- ── 0040 down ──────────────────────────────────────────────────────────
-- Drops only the two columns this file added; app.document_line belongs to 0011 (contracts §3.4.5).
-- The quantity comment is cleared rather than restored: no earlier migration set one.
comment on column app.document_line.quantity is null;
alter table app.document_line
  drop column if exists expected_quantity,
  drop column if exists counted_quantity;

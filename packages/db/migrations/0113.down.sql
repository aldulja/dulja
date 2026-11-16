-- ── 0113 down ──────────────────────────────────────────────────────────────────────────────────────────
-- Drops only what 0113 created. Down-migrating this reopens the gap it closed: a non-draft document's lines
-- become writable again, guarded by nothing but the handler.
drop trigger if exists document_line_frozen_after_draft on app.document_line;
drop function if exists app.document_line_frozen_after_draft();

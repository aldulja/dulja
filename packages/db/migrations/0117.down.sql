-- ── 0117 down ──────────────────────────────────────────────────────────────────────────────────────────
-- Drops only what 0117 created. Down-migrating this reopens the gap it closed: a non-draft document's header
-- becomes writable again to any app_rw session, guarded by nothing but the handler.
drop trigger if exists document_header_frozen_after_draft on app.document;
drop function if exists app.document_header_frozen_after_draft();

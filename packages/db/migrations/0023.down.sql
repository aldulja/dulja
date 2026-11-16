-- 0023.down.sql ───────────────────────────────────────────────────────────────────────────────────────
drop function if exists app.series_gaps(uuid, text, uuid);
revoke delete on app.document, app.document_line from app_rw;
drop function if exists app.forbid_line_delete_unless_draft() cascade;
drop function if exists app.forbid_delete_unless_draft() cascade;

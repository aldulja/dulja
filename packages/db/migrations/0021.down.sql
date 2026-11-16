-- 0021.down.sql ───────────────────────────────────────────────────────────────────────────────────────
-- Reverse dependency order. `drop function … cascade` removes the function's triggers.
drop function if exists app.assert_override_authorised() cascade;
drop function if exists app.principal_has(uuid, text, uuid, uuid);
drop table if exists app.document_event;

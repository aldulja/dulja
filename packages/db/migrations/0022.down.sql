-- 0022.down.sql ───────────────────────────────────────────────────────────────────────────────────────
-- `drop function … cascade` removes the function's triggers; reverse dependency order.
drop function if exists app.document_status_after() cascade;
drop function if exists app.document_status_before() cascade;
drop function if exists app.effective_policy(uuid, date);

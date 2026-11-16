-- Reverse of 0011. The audit trigger and the RLS policy go with the table; app_meta and its default
-- privileges are never dropped (contracts §3.4.5).
drop table if exists app.document_line;

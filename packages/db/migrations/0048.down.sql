-- Reverse of 0048. Drops exactly what 0048 created, in reverse dependency order (§3.4.5): the functions
-- first, by their full signatures (a later slice may add an overload), then the two tables. The indexes,
-- RLS policies and grants are attached to the tables and go with them; app_meta and its default privileges
-- are never dropped. After down to 0 there must be zero tables in schema app (plan0A:2505).
drop function if exists app.item_profitability_rows(uuid, text[]);
drop function if exists app.item_revenue_rows(uuid, date, date);
drop function if exists app.party_ageing_rows(uuid, date);
drop function if exists app.document_netted_from_rows(uuid);
drop function if exists app.document_netted_from(uuid);
drop function if exists app.document_reversal_depth(uuid);
drop table if exists app.item_profitability;
drop table if exists app.party_ageing;

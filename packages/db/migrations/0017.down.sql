-- Reverse of 0017. The audit trigger and the RLS policy go with the table; app_meta and its default
-- privileges are never dropped (contracts §3.4.5).
drop index if exists app.party_company_kind_idx;
drop table if exists app.party;

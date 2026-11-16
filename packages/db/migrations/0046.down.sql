-- Reverse of 0046. Drops exactly what 0046 created, in reverse dependency order (§3.4.5). The RLS policy,
-- the audit trigger, both stamp triggers, the column comment and the grants are attached to the table and go
-- with it; app_meta and its default privileges are never dropped.
drop index if exists app.allocation_settled_idx;      -- §4.8.1's settled-document lookup
drop index if exists app.allocation_settlement_idx;   -- §4.8.1's settlement lookup
drop table if exists app.allocation;          -- takes allocation_guard's trigger with it
drop function if exists app.allocation_guard();
drop function if exists app.first_open_date(uuid, date);   -- code review B1: allocation_guard's date helper

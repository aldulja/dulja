-- Reverse of 0044. Drops exactly what 0044 created, in reverse dependency order (§3.4.5). The audit
-- trigger, the RLS policy and the grants are attached to the table and go with it; app_meta and its default
-- privileges are never dropped.
drop function if exists app.payment_due_date(uuid, date);
drop table if exists app.payment_term;

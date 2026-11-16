-- Reverse of 0115. The table's RLS policy, its partial index and its default-privilege grants are attached to
-- it and go with it; app_meta and its default privileges are never dropped.
drop table if exists app.cost_booking;

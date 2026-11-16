-- ── 0042 down ────────────────────────────────────────────────────────────
-- Restores migration 0034's `cost_consumption_movement_idx` exactly as 3B wrote it and drops the covering
-- form 0042 put in its place (contracts §3.4.5: the down undoes what the up did and nothing else).
-- Dropping and creating an index never touches a row.
drop index if exists app.cost_consumption_movement_idx;
create index cost_consumption_movement_idx on app.cost_consumption (movement_id) where invalidated_at is null;

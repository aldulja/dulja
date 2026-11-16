-- Rollback removes the new representation only; immutable movements and ledger facts survive.
-- Replay marks are retained so an interrupted correction is never silently forgotten.
alter table app.cost_layer drop column value;

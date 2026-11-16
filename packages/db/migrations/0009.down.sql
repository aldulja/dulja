-- 0009.down.sql — the index is the whole migration, so dropping it by the name 0009 gave it returns the table to
-- its primary key alone. Named rather than generated for the reason 0008.down gives: a generated name is a line
-- the up → down → up fingerprint watches change.
drop index if exists app.idempotency_key_expiry_idx;

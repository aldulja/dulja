-- 0027.down.sql — hand-written, per §3.9 (spec:2057): "reversible" means this file exists and passes.
-- CI applies it and re-applies up on a Testcontainers database; production is forward-only.
-- Drops the COLUMN and never the table: 0027 created no table, and a down file that dropped
-- app.document would destroy every document 1A and 2A wrote (§3.4.5).
set local lock_timeout = '3s';

alter table app.document drop column notes;

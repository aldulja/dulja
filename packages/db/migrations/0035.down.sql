-- Drops ONLY the column this file added. app.company is a migration-0001 table and the reversibility test
-- (contracts §3.4.5) requires that a later migration's down never drop a 0001 table.
alter table app.company drop column if exists costing_method;

-- 0098.down.sql — §3.4.5: a later migration that adds a column to an earlier table drops ONLY that column, never
-- the table.
alter table app.employee drop column if exists contract_ends_on;

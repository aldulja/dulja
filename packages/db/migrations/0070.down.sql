-- 0070.down.sql — reverse dependency order (§3.4.5). `drop table` takes the table's own policies,
-- triggers and indexes with it; the two indexes on OTHER tables must be named explicitly.
drop table if exists app.till_event;
drop index if exists app.document_shift_idx;
drop table if exists app.shift;


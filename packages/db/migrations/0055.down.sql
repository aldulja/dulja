-- 0055.down.sql — drops only what the up added. The COLUMN is 2A's (0019) and is not touched (§3.4.5).
drop index if exists app.document_line_tax_code_idx;
alter table app.document_line drop constraint if exists document_line_tax_code_fk;

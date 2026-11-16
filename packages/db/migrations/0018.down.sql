-- Reverse of 0018. A down that dropped app.document or app.document_type would break contracts §3.4.5: a
-- migration adding a column to a 0001 table drops ONLY that column.
alter table app.document_type drop column if exists archived_at;
alter table app.document_type drop constraint if exists document_type_module_check;
alter table app.document_type drop column if exists module;
alter table app.document drop constraint if exists document_party_fk;

-- Reverse of 0013. Only the columns and the sequence this file added come out — never the 0001 tables
-- themselves (contracts §3.4.5).
alter table app.fiscal_period drop column if exists reopen_reason;
alter table app.document drop constraint if exists document_company_id_posting_seq_key;
alter table app.document drop column if exists posting_seq;
revoke usage on sequence app.posting_seq from app_rw;
drop sequence if exists app.posting_seq;

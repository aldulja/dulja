-- Reverse of 0050. Drops exactly what 0050 created, in reverse dependency order (§3.4.5). The RLS policy, the
-- audit trigger, both stamp triggers, the guard trigger, the column comment and the grants are attached to the
-- table and go with it; app_meta and its default privileges are never dropped.
drop index if exists app.bank_match_document_idx;   -- the per-document live Σ
drop index if exists app.bank_match_live_idx;       -- one live match per (line, document)
drop table if exists app.bank_match;                -- takes bank_match_guard's trigger with it
drop function if exists app.bank_match_guard();
-- Last: bank_match's composite key was its only user.
alter table app.bank_statement_line drop constraint if exists bank_statement_line_tenant_id_company_id_id_key;

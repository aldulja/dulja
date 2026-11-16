-- 0057 down. §3.4.5: reverse dependency order; app.company is a 0001 table, so its COLUMNS are
-- dropped and the table is not. After down(sql, dir) to 0 there must be zero tables in schema app,
-- and dropping app.company here would make 0001's own down fail.
alter table app.company
  drop constraint if exists company_einvoice_credential_ref_check,
  drop constraint if exists company_einvoice_complete_check,
  drop constraint if exists company_einvoice_transmitter_check;

alter table app.company
  drop column if exists einvoice_credential_ref,
  drop column if exists einvoice_client_id,
  drop column if exists einvoice_transmitter;

-- Dropping the table takes its indexes, its tenant_isolation policy and its audit_row trigger with it.
drop table if exists app.einvoice_transmission;

-- 0055_alter_document_line_add_tax_fk.sql
-- Contracts §4.3.4: 2A's migration 0019 added `tax_code_id uuid` as an unconstrained FK SLOT, deliberately,
-- because app.tax_code does not exist until 0053. This file closes it. The column stays NULLABLE — every
-- document posted in Phases 1-4 carries tax_code_id = null and §4.9.2 says so explicitly.
--
-- The key is COMPOSITE (§3.5.1): a plain reference would let one tenant attach another tenant's tax code to
-- its own line, which is the shape RLS alone does not stop because the FK is checked by the system, not by
-- the caller's policy.
alter table app.document_line
  add constraint document_line_tax_code_fk
  foreign key (tenant_id, tax_code_id) references app.tax_code(tenant_id, id);

-- The return never reads document_line, but the draft-time tax computation (packages/db/src/tax/compute.ts)
-- reads every line of one document, and the archive check reads every line naming one code.
create index document_line_tax_code_idx on app.document_line (tax_code_id) where tax_code_id is not null;

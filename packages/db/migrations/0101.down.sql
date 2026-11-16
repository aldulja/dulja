-- 0101.down.sql — reverse dependency order: indexes before the columns they read (§3.4.5).
-- Only the columns this file added are dropped; the six tables belong to 0001, 2A, 3A and 6C (§3.4.5).
drop index if exists app.lot_legacy_ref_idx;
drop index if exists app.employee_legacy_ref_idx;
drop index if exists app.account_legacy_ref_idx;
drop index if exists app.item_legacy_ref_idx;
drop index if exists app.party_legacy_ref_idx;
drop index if exists app.document_legacy_ref_idx;

alter table app.lot      drop column if exists legacy_ref;
alter table app.employee drop column if exists legacy_ref;
alter table app.account  drop column if exists legacy_ref;
alter table app.item     drop column if exists legacy_ref;
alter table app.party    drop column if exists legacy_ref;
alter table app.document drop column if exists legacy_ref;

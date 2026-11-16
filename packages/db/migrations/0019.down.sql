-- Reverse of 0019: only the columns, the CHECK and the index this file added (contracts §3.4.5).
drop index if exists app.document_line_item_idx;
alter table app.document_line drop constraint if exists document_line_kind_check;
alter table app.document_line
  drop column if exists cost,
  drop column if exists total_incl_tax,
  drop column if exists tax_amount,
  drop column if exists tax_code_id,
  drop column if exists amount,
  drop column if exists discount,
  drop column if exists unit_price,
  drop column if exists quantity,
  drop column if exists item_id,
  drop column if exists kind;

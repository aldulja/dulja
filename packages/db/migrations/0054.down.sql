-- 0054.down.sql — reverse dependency order (§3.4.5). The ALTER drops only its own COLUMN, never app.document.
alter table app.document drop column if exists tax_inclusive;
drop table if exists app.tax_return;
drop index if exists app.tax_transaction_period_idx;
drop table if exists app.tax_transaction;        -- drops its own immutable trigger with it

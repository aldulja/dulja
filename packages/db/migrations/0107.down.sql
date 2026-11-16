-- 0107.down.sql
alter table app.currency drop constraint if exists currency_pos_rounding_increment_positive;
drop trigger if exists ledger_entry_period_fits on app.ledger_entry;
drop function if exists app.assert_period_fits();
drop trigger if exists fiscal_period_guard on app.fiscal_period;
drop function if exists app.guard_fiscal_period();

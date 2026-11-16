-- 0008.down.sql — reverse order, dropping each constraint by the name 0008 gave it. Naming them in the up is what
-- makes this exact: an unnamed constraint gets a generated name that the up → down → up comparison (§3.4.6) would
-- see change. Dropping the constraint takes its internal RI triggers with it, so nothing is left in pg_trigger.
alter table app.account drop constraint if exists account_currency_fk;
alter table app.ledger_entry drop constraint if exists ledger_entry_currency_fk;
alter table app.document drop constraint if exists document_currency_fk;
alter table app.exchange_rate drop constraint if exists exchange_rate_to_currency_fk;
alter table app.exchange_rate drop constraint if exists exchange_rate_from_currency_fk;
alter table app.company drop constraint if exists company_base_currency_fk;

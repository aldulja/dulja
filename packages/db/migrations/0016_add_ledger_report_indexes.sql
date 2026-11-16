-- ── 1. Report filter indexes (SAH-070: "index coverage is thin on exactly the columns reports
--       filter by"; spec:766–784) ───────────────────────────────────────────────────────────────
-- Plan 0A already indexed the ledger itself (ledger_entry_account_date_idx, ledger_entry_company_date_idx —
-- migration 0001 §7). These three cover the readers this slice adds. `create index concurrently` is not
-- available: contracts §3.4.3 runs each migration file whole in one transaction.

-- accounting.trial_balance filters (company_id, fiscal_period_id[, currency]); the primary key is
-- (company_id, account_id, fiscal_period_id, currency), so account_id sits between the two filtered columns.
create index account_balance_company_period_idx
  on app.account_balance (company_id, fiscal_period_id, currency);

-- accounting.period.month_end scans (company_id, status, ends_on). fiscal_period carries only its primary
-- key, unique (tenant_id, id) and the GiST exclusion on (company_id, daterange(starts_on, ends_on)); none
-- of them serves a scalar `ends_on < $1`, so this scan is a sequential scan today.
create index fiscal_period_company_status_ends_idx
  on app.fiscal_period (company_id, status, ends_on);

-- The accounting.ledger report's document join and the fiscal-period screen's per-period document counts
-- filter (company_id, fiscal_period_id[, status]); unique (company_id, series, fiscal_period_id, number)
-- puts `series` between the two filtered columns.
create index document_company_period_status_idx
  on app.document (company_id, fiscal_period_id, status);

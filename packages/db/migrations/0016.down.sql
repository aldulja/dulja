-- Reverse of 0016, in reverse creation order (contracts §3.4.5). Dropping an index never touches a row.
drop index if exists app.document_company_period_status_idx;
drop index if exists app.fiscal_period_company_status_ends_idx;
drop index if exists app.account_balance_company_period_idx;

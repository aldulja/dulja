-- §3.4.5: every object the up created is dropped, in reverse dependency order. The policy and both
-- triggers go with the table; app_meta and its ledger are never dropped.
drop table if exists app.employee;

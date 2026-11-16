-- 0128.down.sql — removes the three payroll-correction guards. Development and CI only (spec:2057).
drop trigger document_supplementary_payroll_current on app.document;
drop function app.forbid_stale_supplementary_payroll_post();

drop trigger employee_statutory_profile_returns_run on app.employee_statutory_profile;
drop function app.statutory_profile_change_returns_run();
drop trigger employee_employment_change_returns_run on app.employee;
drop function app.employment_change_returns_run();
drop function app.return_payroll_runs(uuid, date, date, text);

drop trigger payroll_run_one_regular_per_period on app.payroll_run;
drop function app.forbid_second_regular_payroll_run();

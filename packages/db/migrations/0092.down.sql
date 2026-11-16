drop aggregate if exists app.jsonb_add_scheme_agg(jsonb);
drop aggregate if exists app.jsonb_add_money_agg(jsonb);
drop function if exists app.jsonb_add_scheme(jsonb, jsonb);
drop function if exists app.jsonb_add_money(jsonb, jsonb);
drop function if exists app.employee_ytd_delta(uuid);
drop table if exists app.employee_ytd_opening;
drop table if exists app.employee_ytd;

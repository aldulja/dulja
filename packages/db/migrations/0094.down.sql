-- Reverses 0094. Nothing it checked is undone: a revoked credential stays revoked.
drop trigger if exists employee_cashier_still_employed on app.employee;
drop trigger if exists pos_cashier_is_employee on app.pos_cashier;
drop function if exists app.assert_cashier_is_employee();

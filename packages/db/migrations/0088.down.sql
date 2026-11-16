-- 0088.down.sql
drop trigger if exists employee_dimension_value on app.employee;
drop function if exists app.employee_dimension() cascade;
drop function if exists app.ensure_employee_dimension_value(uuid, uuid) cascade;
drop function if exists app.ensure_employee_dimension_type(uuid) cascade;
-- The dimension_type and dimension_value ROWS are per-tenant data, not objects: `down` runs as app_migrator,
-- which FORCE RLS reduces to zero rows (spec:1366), so there is nothing here to delete and nothing is tried.
-- §3.4.5's "zero tables in schema app after down to 0" is unaffected — 0088 creates no table.

-- Reverse of 0015: remove exactly the code this migration inserted. role_permission rows referencing
-- the code are per-tenant seed data removed by re-running the role seed; the FK from
-- role_permission.permission_code blocks this delete while any tenant still holds the code, which is
-- the correct signal (contracts §3.4.5).
delete from app.permission where code = 'accounting.report.read';

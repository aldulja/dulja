-- Removes 0124's guard. Down-migrating re-opens API-03 in the data layer: an app_rw session can again rewrite a
-- system role (the API's own 409 stays).
drop trigger role_permission_guard_system on app.role_permission;
drop trigger role_guard_system on app.role;
drop function app.guard_system_role();

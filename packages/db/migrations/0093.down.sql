-- Reverses 0093. Terminations already applied keep their effects: a revoked credential, an expired assignment and a
-- catalogue tombstone are history, not state this file owns.
drop trigger if exists employee_terminated on app.employee;
drop function if exists app.terminate_employee();

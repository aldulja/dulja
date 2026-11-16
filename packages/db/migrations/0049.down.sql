-- Reverse of 0049. Drops exactly what 0049 created, in reverse dependency order (§3.4.5): the line table
-- first, because its key references the statement. The index, the audit, stamp and `*_immutable` triggers,
-- the RLS policies and the grants are attached to the tables and go with them; the triggers' function,
-- app.forbid_change(), is 0001's and stays. app_meta and its default privileges are never dropped.
drop table if exists app.bank_statement_line;
drop table if exists app.bank_statement;

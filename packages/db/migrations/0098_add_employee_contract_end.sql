-- 0098_add_employee_contract_end.sql — contracts round 19, 8D A2. spec:2091 requires a "contract and permit expiry
-- list"; §4.6.2's minimal employee and 8A's 0080 extension carry hired_on and terminated_on but no contract end date,
-- so hr.contract_expiry (8D Task 3) would have had nothing to report.
--
-- This is the EXPAND half of §3.4.7 and is complete in itself: one nullable column on a live table, no backfill, no
-- default, no rewrite. There is no contract half — nothing is dropped.
--
-- It is NOT an employee_sensitive field. An employment end date is an operational fact of the same class as hired_on
-- and terminated_on, both plain columns; encrypting it would make the report impossible without making anything more
-- private. The PERMIT expiry stays in employee_sensitive (§4.12.5) and reaches its reader through
-- GET …/employees/permit-expiry under hr.employee.read_sensitive (8D Task 3, 8D A3).

alter table app.employee add column contract_ends_on date;

comment on column app.employee.contract_ends_on is
  'End of a fixed-term engagement (spec:2091). NULL for open-ended employment. Not sensitive: contracts round 19, 8D A2.';

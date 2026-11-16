# 0075 — The EMPLOYEE dimension value is created by a trigger on `app.employee`

- Status: **Proposed** — the plan records it as accepted, but a trigger that writes reference rows on another
  slice's table is a data-model decision (spec:95), so it is asked rather than decided. Implemented in 8B Task 2
  ahead of approval, as ADRs 0054–0073 were, under the owner's direction to implement Phase 8 entirely.
- Date: 2026-11-07 (the plan's text is dated 2026-09-05)
- Slice: 8B · Task 2
- Migration: `0088_create_employee_dimension.sql` (contracts round 17, A2)

## Context

spec:2101 requires every PAYROLL ledger line to carry an `EMPLOYEE` dimension so that per-employee payables are a
ledger projection rather than a report that re-reads HR tables. A dimension value must therefore exist for every
employee, not for the ones a particular code path remembered to create one for.

`app.employee` has three writers by the end of v1: 6C's cashier onboarding, 8A's HR screens and 9B's importer.
None of them is downstream of the other two.

## Decision

An `AFTER INSERT … FOR EACH ROW` trigger on `app.employee` (`employee_dimension_value` →
`app.employee_dimension()`) calls `app.ensure_employee_dimension_value`, which creates the company's `EMPLOYEE`
dimension type on first use (`name_en` "Employee", `name_ar` "الموظف") and one `dimension_value` per employee keyed
`code = employee_number`, `name_en` = the employee's party name. Both functions run as their caller (not
`SECURITY DEFINER`), and the value function binds the employee to the company it is given.

Migration 0088 does **not** backfill. `FORCE ROW LEVEL SECURITY` binds `app_migrator` (spec:1366), so a migration
file sees zero tenants and cannot write a per-tenant row. Employees that predate 0088 are repaired at first use by
`ensureEmployeeDimensionValue(tx, companyId, employeeId)` (`packages/db/src/hr/employee-dimension.ts`), which the
run service calls once per employee.

## Consequences

- A missing value is never silent: the `PAYROLL` policy declares `dimensions.required: ["BRANCH","EMPLOYEE"]`, so a
  planned line without one refuses at post with `ERR_POLICY_REQUIRES_MISSING` naming the dimension.
- `employee_number` is the value's `code`, so renumbering an employee would orphan its historical ledger tags.
  `app.employee` has `unique (company_id, employee_number)` and no rename path; if one is ever added, it must add a
  `dimension_value` row rather than update the existing one, exactly as §3.4.7 forbids renames.
- Archiving or terminating an employee does **not** archive the dimension value: posted ledger rows reference it
  for the statutory retention period (spec:2049). 8C's termination flow leaves this row alone.
- The trigger's writes are the inserting actor's and are audited under that actor, like any other row it writes.
  Every `dimension_type` count a test makes per company must name the code it means (`BRANCH`), because a company
  with an employee now has two types.

## Owner question

1. Is a trigger on `app.employee` the accepted place for this, or should each of the three writers call
   `ensureEmployeeDimensionValue` itself (and a nightly check name any employee without a value)?

import type { Sql } from "postgres";

/** The dimension type code, as one literal. §4.1 fixes `BRANCH`; this is its payroll twin (spec:2101). */
export const EMPLOYEE_DIMENSION_CODE = "EMPLOYEE";

/**
 * The company's EMPLOYEE dimension type id, creating the row on first use. Idempotent.
 *
 * It calls the SQL function migration 0088 creates rather than re-implementing it, so the trigger path and the
 * repair path can never disagree about what an EMPLOYEE dimension type is.
 */
export async function ensureEmployeeDimensionType(tx: Sql, companyId: string): Promise<string> {
  const rows = await tx<
    { id: string }[]
  >`select app.ensure_employee_dimension_type(${companyId}::uuid)::text as id`;
  return rows[0]!.id;
}

/**
 * The employee's EMPLOYEE dimension_value id, creating the type and the value if either is missing.
 *
 * The ONE repair path for an employee inserted before migration 0088 (hazard 10 — a migration cannot write a
 * per-tenant row). The run service calls it once per employee, so a run over a pre-0088 master is correct on its
 * first attempt rather than refusing with ERR_POLICY_REQUIRES_MISSING. The employee is bound to `companyId`.
 *
 * Raises the DB token `ERR_NOT_FOUND` naming the employee and the company when there is no such employee in that
 * company — `fromDatabaseError` maps a 23514 with an `ERR_*:` prefix to that AppError (§4.2.4).
 */
export async function ensureEmployeeDimensionValue(
  tx: Sql,
  companyId: string,
  employeeId: string,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    select app.ensure_employee_dimension_value(${companyId}::uuid, ${employeeId}::uuid)::text as id`;
  return rows[0]!.id;
}

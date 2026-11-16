import type { Sql } from "postgres";
import { AppError } from "@dulja/contracts";

/**
 * The employee sub-resources (8A — sensitive, statutory profiles, compensation lines) clear their permission gate
 * at the PATH company, and RLS bounds the tenant and nothing else: an employee id alone would let a caller
 * authorised in one company reach another company's employee inside the same tenant (AGENTS.md, endpoints). So
 * every handler first proves the employee belongs to the path company. A row that is absent, in another tenant,
 * in another company or hidden by branch isolation is one 404 — never a 403 that confirms it exists.
 */
export async function requireEmployeeInCompany(
  tx: Sql,
  companyId: string,
  employeeId: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.employee where id = ${employeeId}::uuid and company_id = ${companyId}::uuid`;
  if (row === undefined)
    throw new AppError("ERR_NOT_FOUND", `employee ${employeeId} was not found in this company`);
}

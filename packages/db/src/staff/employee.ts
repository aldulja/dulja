import type { Sql } from "postgres";
import { SyncError } from "../sync/enrolment";
export interface EmployeeRow {
  id: string;
  partyId: string;
  employeeNumber: string;
  homeBranchId: string;
  principalId: string | null;
  hiredOn: string;
  terminatedOn: string | null;
  createdAt: string;
  // 8A — migration 0080's columns, on the wire as EmployeeSchema's three 8A fields.
  position: string | null;
  employmentType: "full_time" | "part_time" | "contract" | "hourly" | null;
  archivedAt: string | null;
}
export interface CreateEmployeeInput {
  employeeNumber: string;
  nameEn: string;
  nameAr?: string | null;
  homeBranchId: string;
  hiredOn: string;
  position?: string | null;
  employmentType?: "full_time" | "part_time" | "contract" | "hourly" | null;
  /** 9B (round 20, 0101) — the source system's employee number, written by the importer only; API callers omit it. */
  legacyRef?: string | null;
  /** 9B — the employee party's code when it must differ from the employee number (another party already holds that
   *  code). Defaults to the employee number, as every API-created employee has it. */
  partyCode?: string;
}
const SELECT = (tx: Sql) =>
  tx`select id,party_id as "partyId",employee_number as "employeeNumber",home_branch_id as "homeBranchId",principal_id as "principalId",hired_on::text as "hiredOn",terminated_on::text as "terminatedOn",to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",position,employment_type as "employmentType",to_char(archived_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "archivedAt" from app.employee`;
export async function createEmployee(
  tx: Sql,
  companyId: string,
  input: CreateEmployeeInput,
): Promise<EmployeeRow> {
  const [branch] =
    await tx`select 1 from app.dimension_value v join app.dimension_type t on t.id=v.dimension_type_id and t.tenant_id=v.tenant_id where v.id=${input.homeBranchId} and t.company_id=${companyId} and t.code='BRANCH' and v.archived_at is null`;
  if (!branch) throw new SyncError("ERR_NOT_FOUND", "branch is not visible");
  const [party] = await tx<
    { id: string }[]
  >`insert into app.party(tenant_id,company_id,kind,code,name_en,name_ar) values(app.current_tenant(),${companyId},'employee',${input.partyCode ?? input.employeeNumber},${input.nameEn},${input.nameAr ?? null}) returning id`;
  const [row] = await tx<
    { id: string }[]
  >`insert into app.employee(tenant_id,company_id,party_id,employee_number,home_branch_id,hired_on,position,employment_type,legacy_ref) values(app.current_tenant(),${companyId},${party!.id},${input.employeeNumber},${input.homeBranchId},${input.hiredOn}::date,${input.position ?? null},${input.employmentType ?? null},${input.legacyRef ?? null}) returning id`;
  return (await getEmployee(tx, companyId, row!.id))!;
}
export async function getEmployee(
  tx: Sql,
  companyId: string,
  employeeId: string,
): Promise<EmployeeRow | null> {
  const [row] = await tx<
    EmployeeRow[]
  >`${SELECT(tx)} where company_id=${companyId} and id=${employeeId}`;
  return row ?? null;
}
export async function listEmployees(
  tx: Sql,
  companyId: string,
  opts: { limit: number; cursor?: { id: string }; branchId?: string; active?: boolean },
): Promise<{ rows: EmployeeRow[]; nextCursor: string | null }> {
  const rows = await tx<
    EmployeeRow[]
  >`${SELECT(tx)} where company_id=${companyId} and app.actor_has('hr.employee.read',company_id,home_branch_id) and (${opts.branchId ?? null}::uuid is null or home_branch_id=${opts.branchId ?? null}::uuid) and (${opts.active ?? null}::boolean is null or (terminated_on is null)=${opts.active ?? null}::boolean) and (${opts.cursor?.id ?? null}::uuid is null or id>${opts.cursor?.id ?? null}::uuid) order by id limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  return { rows: page, nextCursor: rows.length > opts.limit ? page.at(-1)!.id : null };
}
export async function linkEmployeePrincipal(
  tx: Sql,
  companyId: string,
  employeeId: string,
  principalId: string,
): Promise<void> {
  const rows =
    await tx`update app.employee set principal_id=${principalId} where company_id=${companyId} and id=${employeeId} and principal_id is null and terminated_on is null`;
  if (rows.count !== 1) throw new SyncError("ERR_VALIDATION_FAILED", "employee cannot be linked");
}

/** ADR 0097 (full review PRD-07) — the fields `PATCH …/employees/{id}` edits. Never the number (the party's code and
 *  every import key), the home branch (branch isolation and the EMPLOYEE dimension hang off it), the principal link
 *  (6C's own route) or `terminatedOn` (`terminateEmployee`); sensitive and compensation fields keep their gated
 *  sub-resources. `undefined` leaves a field as it is; `null` clears a nullable one. */
export interface UpdateEmployeeInput {
  nameEn?: string;
  nameAr?: string | null;
  hiredOn?: string;
  position?: string | null;
  employmentType?: "full_time" | "part_time" | "contract" | "hourly" | null;
}
/** Returns null when the employee is not visible in this company (the route's 404). A hire date after the
 *  termination date is refused. */
export async function updateEmployee(
  tx: Sql,
  companyId: string,
  employeeId: string,
  input: UpdateEmployeeInput,
): Promise<EmployeeRow | null> {
  const current = await getEmployee(tx, companyId, employeeId);
  if (!current) return null;
  const hiredOn = input.hiredOn ?? current.hiredOn;
  if (current.terminatedOn !== null && hiredOn > current.terminatedOn)
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      "hiredOn is after the employee's termination date",
    );
  const has = (k: keyof UpdateEmployeeInput) => input[k] !== undefined;
  await tx`update app.employee
              set hired_on=${hiredOn}::date,
                  position=${has("position") ? (input.position ?? null) : current.position},
                  employment_type=${has("employmentType") ? (input.employmentType ?? null) : current.employmentType}
            where company_id=${companyId} and id=${employeeId}`;
  if (has("nameEn") || has("nameAr"))
    await tx`update app.party
                set name_en=coalesce(${input.nameEn ?? null}, name_en),
                    name_ar=${has("nameAr") ? (input.nameAr ?? null) : tx`name_ar`}
              where company_id=${companyId} and id=${current.partyId} and kind='employee'`;
  return getEmployee(tx, companyId, employeeId);
}
/**
 * ADR 0097 (full review PRD-07) — sets `terminated_on`, which is all a termination is: 0093's AFTER UPDATE trigger
 * (ADR 0078) expires the person's role assignments as this actor and revokes their till credentials, and 8A's
 * `employee_no_self_pay` refuses a self-termination. A later date on an already-terminated employee corrects the
 * date only (the trigger fires on null → value); clearing it — a reinstatement — is not this verb. Returns null
 * when the employee is not visible in this company.
 */
export async function terminateEmployee(
  tx: Sql,
  companyId: string,
  employeeId: string,
  terminatedOn: string,
): Promise<EmployeeRow | null> {
  const current = await getEmployee(tx, companyId, employeeId);
  if (!current) return null;
  if (terminatedOn < current.hiredOn)
    throw new SyncError("ERR_VALIDATION_FAILED", "terminatedOn is before the employee's hire date");
  await tx`update app.employee set terminated_on=${terminatedOn}::date
            where company_id=${companyId} and id=${employeeId}
              and terminated_on is distinct from ${terminatedOn}::date`;
  return getEmployee(tx, companyId, employeeId);
}

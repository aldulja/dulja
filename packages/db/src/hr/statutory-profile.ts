import type { Sql } from "postgres";

/** One scalar of the ⚠️ OD-28 `extra` seam. Never a rate, a threshold or a formula (spec:2080). */
export type StatutoryExtraValue = string | number | boolean | null;

export interface StatutoryProfile {
  id: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  maritalStatus: string | null;
  spouseWorking: boolean | null;
  childReliefCount: number | null;
  residencyCategory: string | null;
  extra: Record<string, StatutoryExtraValue>;
  enteredBy: string;
  createdAt: string;
}
export type StatutoryProfileInput = Omit<
  StatutoryProfile,
  "id" | "employeeId" | "effectiveTo" | "enteredBy" | "createdAt"
>;

interface Raw {
  id: string;
  employee_id: string;
  effective_from: string;
  effective_to: string | null;
  marital_status: string | null;
  spouse_working: boolean | null;
  child_relief_count: number | null;
  residency_category: string | null;
  extra: Record<string, StatutoryExtraValue>;
  entered_by: string;
  created_at: string;
}

const toProfile = (r: Raw): StatutoryProfile => ({
  id: r.id,
  employeeId: r.employee_id,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  maritalStatus: r.marital_status,
  spouseWorking: r.spouse_working,
  childReliefCount: r.child_relief_count,
  residencyCategory: r.residency_category,
  extra: r.extra,
  enteredBy: r.entered_by,
  createdAt: r.created_at,
});

// The column list is written out in each query rather than hoisted into a shared string and interpolated:
// `sql.unsafe` has three homes in this repository and none of them is here (hazard 21), and `no-sql-concat`
// fails the build on a non-literal `.unsafe(` argument.

/** Every row for one employee, newest first. Empty when the caller lacks the compensation read code — RLS
 *  (`compensation_gate`), not a branch in this function. */
export async function listStatutoryProfiles(
  tx: Sql,
  employeeId: string,
): Promise<StatutoryProfile[]> {
  const rows = await tx<Raw[]>`
    select id, employee_id, effective_from::text as effective_from, effective_to::text as effective_to,
           marital_status, spouse_working, child_relief_count, residency_category, extra, entered_by,
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from app.employee_statutory_profile
     where employee_id = ${employeeId}::uuid
     order by effective_from desc`;
  return rows.map(toProfile);
}

/** The row covering `on`, or null. 8B builds `EmployeePeriodInput.statutoryProfile` (§4.12.1) from this. */
export async function profileOn(
  tx: Sql,
  employeeId: string,
  on: string,
): Promise<StatutoryProfile | null> {
  const [row] = await tx<Raw[]>`
    select id, employee_id, effective_from::text as effective_from, effective_to::text as effective_to,
           marital_status, spouse_working, child_relief_count, residency_category, extra, entered_by,
           to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from app.employee_statutory_profile
     where employee_id = ${employeeId}::uuid and effective_from <= ${on}::date
       and (effective_to is null or effective_to >= ${on}::date)
     order by effective_from desc limit 1`;
  return row === undefined ? null : toProfile(row);
}

/**
 * Close-then-open, one transaction, never an edit (ADR 0072): the open row is closed at `effectiveFrom - 1 day`
 * and the new row inserted. Returns the new row's id. The close is guarded by `effective_from < <new>`, so an
 * attempt to open a row on or before the open row's start leaves it open and the insert collides with a unique
 * index — correcting history is a deliberate act, not an accident. `tenant_id` comes from the employee row, never
 * from the caller; an employee the transaction cannot see inserts nothing and throws.
 */
export async function openStatutoryProfile(
  tx: Sql,
  employeeId: string,
  input: StatutoryProfileInput,
): Promise<string> {
  await tx`
    update app.employee_statutory_profile
       set effective_to = (${input.effectiveFrom}::date - 1)
     where employee_id = ${employeeId}::uuid and effective_to is null
       and effective_from < ${input.effectiveFrom}::date`;
  const [row] = await tx<{ id: string }[]>`
    insert into app.employee_statutory_profile
      (tenant_id, employee_id, effective_from, marital_status, spouse_working, child_relief_count,
       residency_category, extra)
    select e.tenant_id, e.id, ${input.effectiveFrom}::date, ${input.maritalStatus}::text,
           ${input.spouseWorking}::boolean, ${input.childReliefCount}::int, ${input.residencyCategory}::text,
           ${tx.json(input.extra)}::jsonb
      from app.employee e where e.id = ${employeeId}::uuid
    returning id`;
  if (row === undefined)
    throw new Error(`employee ${employeeId} is not visible to this transaction`);
  return row.id;
}

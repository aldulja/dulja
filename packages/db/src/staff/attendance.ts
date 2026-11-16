import type { Sql } from "postgres";

export type AttendanceKind = "clock_in" | "clock_out" | "manual_correction";
export interface AttendanceEventRow {
  id: string;
  employeeId: string;
  branchId: string;
  kind: AttendanceKind;
  occurredAt: string;
  terminalId: string | null;
  recordedBy: string;
  note: string | null;
  correctsEventId: string | null;
  createdAt: string;
}
export interface RecordAttendanceInput {
  employeeId: string;
  kind: AttendanceKind;
  occurredAt: string;
  branchId?: string;
  terminalId?: string | null;
  note?: string | null;
  correctsEventId?: string | null;
  /** Trusted signed-sync context, never accepted by the back-office body. */
  cashierPrincipalId?: string;
}
const returning = (tx: Sql) => tx`id, employee_id as "employeeId", branch_id as "branchId", kind,
  to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt",
  terminal_id as "terminalId", recorded_by as "recordedBy", note, corrects_event_id as "correctsEventId",
  to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;

/** Both callers use this insert. Actor attribution is the database stamp; missing facts write nothing. */
export async function recordAttendance(
  tx: Sql,
  companyId: string,
  input: RecordAttendanceInput,
): Promise<AttendanceEventRow | null> {
  const [row] = await tx<AttendanceEventRow[]>`
    with eligible as (
      select id,home_branch_id from app.employee where id=${input.employeeId} and company_id=${companyId}
        and ${input.cashierPrincipalId ?? null}::uuid is null
      union all
      select identity.employee_id,${input.branchId ?? null}::uuid
        from app.resolve_cashier_employee(${companyId},${input.branchId ?? null}::uuid,${input.cashierPrincipalId ?? null}::uuid) identity
       where ${input.cashierPrincipalId ?? null}::uuid is not null and identity.employee_id=${input.employeeId}
    )
    insert into app.attendance_event (tenant_id,company_id,employee_id,branch_id,kind,occurred_at,terminal_id,note,corrects_event_id)
    select app.current_tenant(),${companyId},e.id,coalesce(${input.branchId ?? null}::uuid,e.home_branch_id),
      ${input.kind},${input.occurredAt}::text::timestamptz,${input.terminalId ?? null}::uuid,${input.note ?? null},${input.correctsEventId ?? null}::uuid
    from eligible e
    join app.dimension_value b on b.id=coalesce(${input.branchId ?? null}::uuid,e.home_branch_id) and b.tenant_id=app.current_tenant()
    join app.dimension_type dt on dt.id=b.dimension_type_id and dt.tenant_id=b.tenant_id and dt.company_id=${companyId} and dt.code='BRANCH'
    where e.id=${input.employeeId}
      and (${input.correctsEventId ?? null}::uuid is null or exists (select 1 from app.attendance_event orig where orig.id=${input.correctsEventId ?? null}::uuid and orig.company_id=${companyId} and orig.employee_id=e.id))
      and (${input.cashierPrincipalId ?? null}::uuid is null or exists (
        select 1 from app.pos_cashier c join app.pos_terminal t on t.company_id=c.company_id and t.branch_id=c.branch_id and t.tenant_id=c.tenant_id
        where c.principal_id=${input.cashierPrincipalId ?? null}::uuid and c.employee_id=e.id and c.company_id=${companyId} and c.branch_id=b.id and c.revoked_at is null
          and t.id=${input.terminalId ?? null}::uuid and t.principal_id=app.current_actor() and t.revoked_at is null))
    returning ${returning(tx)}`;
  return row ?? null;
}
export async function listAttendance(
  tx: Sql,
  companyId: string,
  opts: { limit: number; cursor?: { id: string }; employeeId?: string; from?: string; to?: string },
): Promise<{ rows: AttendanceEventRow[]; nextCursor: string | null }> {
  const rows = await tx<AttendanceEventRow[]>`select ${returning(tx)} from app.attendance_event
    where company_id=${companyId}
      and app.actor_has('hr.employee.read',company_id,branch_id)
      and (${opts.employeeId ?? null}::uuid is null or employee_id=${opts.employeeId ?? null}::uuid)
      and (${opts.from ?? null}::text::timestamptz is null or occurred_at>=${opts.from ?? null}::text::timestamptz)
      and (${opts.to ?? null}::text::timestamptz is null or occurred_at<${opts.to ?? null}::text::timestamptz)
      and (${opts.cursor?.id ?? null}::uuid is null or id>${opts.cursor?.id ?? null}::uuid)
    order by id limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  return { rows: page, nextCursor: rows.length > opts.limit ? page.at(-1)!.id : null };
}

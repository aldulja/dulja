import type { Sql } from "postgres";

/**
 * ⚠️ OD-13 (answered BUILD on 2026-11-07; contracts round 19, 8D A14) — spec:2085's minimal leave register, as SQL.
 * Every rule this file appears to rely on is enforced one layer down, in migration 0096:
 *   · a principal may not approve their own leave      → the leave_record_no_self_approve trigger (R4, 8A's
 *                                                         app.forbid_self_pay; spec:2175, test 31)
 *   · a record is inserted requested and decided once   → app.guard_leave_record (ERR_TABLE_IMMUTABLE)
 *   · requested ⇔ no decider; the decider is the session → the CHECK + app.stamp_actor (SAH-044)
 *   · another tenant sees nothing; another branch's     → RLS: tenant_isolation, and employee_parent_visibility /
 *     employee's leave is invisible                       public_holiday's Form B branch_isolation (8D A8)
 * What this file adds is the COMPANY bind: RLS bounds the tenant, so every write names the path company and joins the
 * employee and the leave type through it — another company's id is "not found", never written (AGENTS.md, endpoints).
 *
 * Leave is a record, never a pay input: unpaid leave reaches payroll as a quantity on 8B's unpaid-leave deduction
 * component (spec:2085), and nothing in packages/domain/payroll reads these tables.
 */

export type LeaveTypeCode = "annual" | "sick" | "unpaid" | "other";
export type LeaveStatus = "requested" | "approved" | "rejected";

/** The leave service's refusal. `packages/db` may not import `AppError` (§3.1), so — like `PayrollRunError` — it
 *  carries a code that is already a row of `ERRORS`, lifted by `apps/api/src/problem.ts`'s `fromDomainError`. */
export type LeaveErrorCode = "ERR_NOT_FOUND" | "ERR_VALIDATION_FAILED";
export class LeaveError extends Error {
  constructor(
    readonly code: LeaveErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "LeaveError";
  }
}

export interface RequestLeaveInput {
  companyId: string;
  employeeId: string;
  leaveTypeId: string;
  startsOn: string;
  endsOn: string;
  /** `numeric(6,2)` as a fixed-decimal string, e.g. `"2.50"`. */
  days: string;
  reason: string | null;
}
export interface LeaveDecisionInput {
  companyId: string;
  leaveRecordId: string;
}
export interface RejectLeaveInput extends LeaveDecisionInput {
  /** Replaces the record's reason when given; absent keeps the request's own reason. */
  reason?: string | null;
}
export interface SetEntitlementInput {
  companyId: string;
  employeeId: string;
  year: number;
  leaveTypeId: string;
  days: string;
}
export interface LeaveRecordFilter {
  companyId: string;
  /** One record by id — what both write routes read back with, so a handler returns the row it wrote. */
  id?: string;
  employeeId?: string;
  leaveTypeId?: string;
  status?: LeaveStatus;
  /** Bounds on `starts_on`, inclusive. */
  fromDate?: string;
  toDate?: string;
  limit: number;
}
export interface LeaveRecordRow {
  id: string;
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeCode: LeaveTypeCode;
  startsOn: string;
  endsOn: string;
  days: string;
  status: LeaveStatus;
  /** The principal who decided the record (approval or rejection); null while requested. */
  approvedBy: string | null;
  reason: string | null;
}
export interface CreateLeaveTypeInput {
  companyId: string;
  code: LeaveTypeCode;
  nameEn: string;
  nameAr: string | null;
  paid: boolean;
}
export interface LeaveTypeRow {
  id: string;
  code: LeaveTypeCode;
  nameEn: string;
  nameAr: string | null;
  paid: boolean;
  archivedAt: string | null;
}
export interface LeaveTypeFilter {
  companyId: string;
  includeArchived?: boolean;
  limit: number;
}
export interface LeaveEntitlementRow {
  employeeId: string;
  employeeNumber: string;
  year: number;
  leaveTypeId: string;
  leaveTypeCode: LeaveTypeCode;
  days: string;
}
export interface LeaveEntitlementFilter {
  companyId: string;
  employeeId?: string;
  year?: number;
  leaveTypeId?: string;
  limit: number;
}
export interface CreatePublicHolidayInput {
  companyId: string;
  /** NULL = every branch of the company. */
  branchId: string | null;
  holidayOn: string;
  nameEn: string;
  nameAr: string | null;
}
export interface PublicHolidayRow {
  id: string;
  branchId: string | null;
  holidayOn: string;
  nameEn: string;
  nameAr: string | null;
}
export interface PublicHolidayFilter {
  companyId: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
}

/** One `leave_record` at `requested`, `approved_by` NULL, for an employee and a live leave type of the company.
 *  Either id outside the company (or hidden by branch isolation) is `ERR_NOT_FOUND`. Returns the new id. */
export async function requestLeave(tx: Sql, input: RequestLeaveInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.leave_record
      (tenant_id, company_id, employee_id, leave_type_id, starts_on, ends_on, days, reason)
    select app.current_tenant(), e.company_id, e.id, lt.id,
           ${input.startsOn}::date, ${input.endsOn}::date, ${input.days}::numeric(6,2), ${input.reason}
      from app.employee e
      join app.leave_type lt on lt.company_id = e.company_id and lt.id = ${input.leaveTypeId}::uuid
                            and lt.archived_at is null
     where e.id = ${input.employeeId}::uuid and e.company_id = ${input.companyId}::uuid
    returning id`;
  if (row === undefined)
    throw new LeaveError(
      "ERR_NOT_FOUND",
      `employee ${input.employeeId} or leave type ${input.leaveTypeId} was not found in this company`,
    );
  return row.id;
}

/**
 * Decides one record of the company. BOTH decisions write `approved_by` — 0096's CHECK makes "requested ⇔ no
 * decider" — and `app.stamp_actor` overwrites the written value with the session actor on the NULL → value
 * transition, so the column is never the caller's to choose. There is deliberately no `status = 'requested'`
 * predicate: deciding an already-decided record reaches app.guard_leave_record and is refused (ERR_TABLE_IMMUTABLE,
 * 409) instead of quietly answering with the earlier decision. R4 is the trigger's (ERR_HR_SELF_PAY, 409).
 * Returns false when no record of that id is visible in the company.
 */
export async function approveLeave(tx: Sql, input: LeaveDecisionInput): Promise<boolean> {
  const rows = await tx`
    update app.leave_record
       set status = 'approved', approved_by = app.current_actor()
     where id = ${input.leaveRecordId}::uuid and company_id = ${input.companyId}::uuid
    returning id`;
  return rows.length > 0;
}

/** The R4 trigger fires only `when (new.status = 'approved')`, so rejecting one's OWN request is allowed —
 *  deliberately: spec:2175 forbids approving one's own leave, and refusing a self-withdrawal would leave a
 *  self-requested record with no way to close it. */
export async function rejectLeave(tx: Sql, input: RejectLeaveInput): Promise<boolean> {
  const rows = await tx`
    update app.leave_record
       set status = 'rejected', approved_by = app.current_actor(),
           reason = coalesce(${input.reason ?? null}::text, reason)
     where id = ${input.leaveRecordId}::uuid and company_id = ${input.companyId}::uuid
    returning id`;
  return rows.length > 0;
}

/** The yearly figure is ENTERED by HR — spec:2085 says there is no accrual engine, so this is an upsert on the
 *  natural key and never an accumulation. The employee and the type are bound to the company (`ERR_NOT_FOUND`). */
export async function setEntitlement(tx: Sql, input: SetEntitlementInput): Promise<void> {
  const rows = await tx`
    insert into app.leave_entitlement (tenant_id, company_id, employee_id, year, leave_type_id, days)
    select app.current_tenant(), e.company_id, e.id, ${input.year}::smallint, lt.id, ${input.days}::numeric(6,2)
      from app.employee e
      join app.leave_type lt on lt.company_id = e.company_id and lt.id = ${input.leaveTypeId}::uuid
     where e.id = ${input.employeeId}::uuid and e.company_id = ${input.companyId}::uuid
    on conflict (employee_id, year, leave_type_id) do update set days = excluded.days
    returning id`;
  if (rows.length === 0)
    throw new LeaveError(
      "ERR_NOT_FOUND",
      `employee ${input.employeeId} or leave type ${input.leaveTypeId} was not found in this company`,
    );
}

/** One `leave_type` for the company. A duplicate `code` raises SQLSTATE 23505, which `fromDatabaseError` maps to
 *  `ERR_CONFLICT_UNIQUE` (409) — no pre-read, because a check-then-insert is a race and the constraint is the rule. */
export async function createLeaveType(tx: Sql, input: CreateLeaveTypeInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into app.leave_type (tenant_id, company_id, code, name_en, name_ar, paid)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.code}, ${input.nameEn},
            ${input.nameAr}, ${input.paid})
    returning id`;
  return row!.id;
}

export async function listLeaveTypes(tx: Sql, f: LeaveTypeFilter): Promise<LeaveTypeRow[]> {
  return tx<LeaveTypeRow[]>`
    select lt.id       as "id",
           lt.code     as "code",
           lt.name_en  as "nameEn",
           lt.name_ar  as "nameAr",
           lt.paid     as "paid",
           to_char(lt.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "archivedAt"
      from app.leave_type lt
     where lt.company_id = ${f.companyId}::uuid
       and (${f.includeArchived ?? false}::boolean or lt.archived_at is null)
     order by lt.code asc
     limit ${f.limit}`;
}

/** Every optional filter is a bound parameter compared against NULL, never a concatenated clause (§3.3, test 27).
 *  The three optional filters together are the table's natural key, so a PUT reads back exactly its row. */
export async function listEntitlements(
  tx: Sql,
  f: LeaveEntitlementFilter,
): Promise<LeaveEntitlementRow[]> {
  return tx<LeaveEntitlementRow[]>`
    select le.employee_id     as "employeeId",
           e.employee_number  as "employeeNumber",
           le.year::int       as "year",
           le.leave_type_id   as "leaveTypeId",
           lt.code            as "leaveTypeCode",
           le.days::text      as "days"
      from app.leave_entitlement le
      join app.employee   e  on e.id  = le.employee_id
      join app.leave_type lt on lt.id = le.leave_type_id
     where le.company_id = ${f.companyId}::uuid
       and (${f.employeeId ?? null}::uuid  is null or le.employee_id   = ${f.employeeId ?? null}::uuid)
       and (${f.year ?? null}::int         is null or le.year          = ${f.year ?? null}::int)
       and (${f.leaveTypeId ?? null}::uuid is null or le.leave_type_id = ${f.leaveTypeId ?? null}::uuid)
     order by le.year desc, e.employee_number asc, lt.code asc
     limit ${f.limit}`;
}

/** A NULL `branchId` is a company-wide holiday, which is why 0096's unique constraint is `nulls not distinct`: a
 *  second company-wide row on the same date raises 23505 → 409. A named branch must be a BRANCH dimension value of
 *  this company (the FK binds the tenant only); RLS's Form B then refuses one outside the actor's branches. */
export async function createPublicHoliday(
  tx: Sql,
  input: CreatePublicHolidayInput,
): Promise<string> {
  if (input.branchId !== null) {
    const [branch] = await tx`
      select 1 from app.dimension_value v
        join app.dimension_type t on t.id = v.dimension_type_id and t.tenant_id = v.tenant_id
       where v.id = ${input.branchId}::uuid and t.company_id = ${input.companyId}::uuid
         and t.code = 'BRANCH' and v.archived_at is null`;
    if (branch === undefined)
      throw new LeaveError(
        "ERR_NOT_FOUND",
        `branch ${input.branchId} is not a branch of this company`,
      );
  }
  const [row] = await tx<{ id: string }[]>`
    insert into app.public_holiday (tenant_id, company_id, branch_id, holiday_on, name_en, name_ar)
    values (app.current_tenant(), ${input.companyId}::uuid, ${input.branchId}::uuid,
            ${input.holidayOn}::date, ${input.nameEn}, ${input.nameAr})
    returning id`;
  return row!.id;
}

/** No branch filter: `public_holiday` carries Form B (8D A8), so RLS has already removed every row of a branch the
 *  actor is not in, and a company-wide (NULL branch) row is visible to everyone. A filter here would be a second gate. */
export async function listPublicHolidays(
  tx: Sql,
  f: PublicHolidayFilter,
): Promise<PublicHolidayRow[]> {
  return tx<PublicHolidayRow[]>`
    select ph.id                                as "id",
           ph.branch_id                         as "branchId",
           to_char(ph.holiday_on, 'YYYY-MM-DD') as "holidayOn",
           ph.name_en                           as "nameEn",
           ph.name_ar                           as "nameAr"
      from app.public_holiday ph
     where ph.company_id = ${f.companyId}::uuid
       and (${f.fromDate ?? null}::date is null or ph.holiday_on >= ${f.fromDate ?? null}::date)
       and (${f.toDate ?? null}::date   is null or ph.holiday_on <= ${f.toDate ?? null}::date)
     order by ph.holiday_on asc, ph.branch_id asc nulls first, ph.id asc
     limit ${f.limit}`;
}

/** The register, newest first. Dates leave SQL as strings, as every dataset's do. */
export async function listLeaveRecords(tx: Sql, f: LeaveRecordFilter): Promise<LeaveRecordRow[]> {
  return tx<LeaveRecordRow[]>`
    select lr.id                               as "id",
           lr.employee_id                      as "employeeId",
           e.employee_number                   as "employeeNumber",
           lr.leave_type_id                    as "leaveTypeId",
           lt.code                             as "leaveTypeCode",
           to_char(lr.starts_on, 'YYYY-MM-DD') as "startsOn",
           to_char(lr.ends_on,   'YYYY-MM-DD') as "endsOn",
           lr.days::text                       as "days",
           lr.status                           as "status",
           lr.approved_by                      as "approvedBy",
           lr.reason                           as "reason"
      from app.leave_record lr
      join app.leave_type lt on lt.id = lr.leave_type_id
      join app.employee   e  on e.id  = lr.employee_id
     where lr.company_id = ${f.companyId}::uuid
       and (${f.id ?? null}::uuid          is null or lr.id            = ${f.id ?? null}::uuid)
       and (${f.employeeId ?? null}::uuid  is null or lr.employee_id   = ${f.employeeId ?? null}::uuid)
       and (${f.leaveTypeId ?? null}::uuid is null or lr.leave_type_id = ${f.leaveTypeId ?? null}::uuid)
       and (${f.status ?? null}::text      is null or lr.status        = ${f.status ?? null}::text)
       and (${f.fromDate ?? null}::date    is null or lr.starts_on    >= ${f.fromDate ?? null}::date)
       and (${f.toDate ?? null}::date      is null or lr.starts_on    <= ${f.toDate ?? null}::date)
     order by lr.starts_on desc, e.employee_number asc, lr.id asc
     limit ${f.limit}`;
}

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { currency, Money, type CurrencyCode } from "@dulja/domain";
import { createAttachment } from "../attachment";
import type { ObjectStore } from "../attachment/object-store";
import type { TenantContext } from "../with-tenant";
import { csvField, csvText } from "./csv-cell";
import { employerRegistrations } from "./settings";

/**
 * 8C T7 — statutory schedules (spec:2083: "a monthly contribution/deduction schedule per scheme … recorded as one
 * `statutory_schedule` row per scheme per period (generated from posted lines only; attachment hash; the remittance
 * PAYMENT that settled it) — a record, not a lodgement state machine").
 *
 * A schedule is generated from a POSTED `PAYROLL` run's `payroll_line` rows and nothing else: one row per scheme the
 * run touched, idempotent on migration 0091's natural key `(scheme_id, period_start, payroll_document_id)`. The
 * generic CSV (⚠️ OD-28's default layout — Task 13 is where a verified authority layout replaces it) is written as an
 * `app.attachment` owned by the RUN, so 2C's §4.5.8 download gate resolves module `hr` → `hr.payroll.read`, and its
 * sha256 is the hash spec:2083 asks for. This file writes no ledger row, and the amount a remittance must carry is
 * 0091's trigger's business, not this file's.
 */

/** `packages/db` may not import `AppError` (§3.1); every code is a row of `ERRORS`, and `apps/api/src/problem.ts`
 *  maps it through `fromDomainError` (the `MoneyOutError` precedent). */
export type ScheduleErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_VALIDATION_FAILED"
  | "ERR_DOC_STATUS_ILLEGAL"
  | "ERR_RBAC_FORBIDDEN";

export class ScheduleError extends Error {
  constructor(
    readonly code: ScheduleErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ScheduleError";
  }
}

export interface ScheduleRow {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  /** The scheme reference from the employee's statutory profile covering the period end, blank when it has none. */
  schemeReference: string;
  /** Fixed-scale 4-dp strings, produced once by `to_char` and never re-formatted (SAH-019). */
  employeeShare: string;
  employerShare: string;
}

export interface StatutoryScheduleResult {
  scheduleId: string;
  companyId: string;
  schemeId: string;
  schemeCode: string;
  periodStart: string;
  periodEnd: string;
  payrollDocumentId: string;
  totalEmployee: Money;
  totalEmployer: Money;
  currency: CurrencyCode;
  attachmentId: string | null;
  remittanceDocumentId: string | null;
  rows: ScheduleRow[];
  /**
   * ⚠️ OD-23 (8C T15). 8A's `statutory_scheme.employer_registration`; null until the owner supplies it, so a caller
   * names the scheme whose registration is missing instead of printing an empty box. Optional because a hand-built
   * literal (8C T13's synthetic layout fixture) need not carry it; every reader here sets it, and the wire field is
   * required and nullable.
   */
  employerRegistration?: string | null;
}

/** A route that clears a path company passes it, so another company's schedule is 404 (AGENTS.md: RLS bounds the
 *  tenant and nothing else). */
export interface ScheduleScope {
  companyId?: string;
}

/**
 * OD-28's DEFAULT layout. Five columns, every one of them a field the data already carries, and **no authority,
 * form, box or file version is named** (hazard 2).
 */
export const SCHEDULE_CSV_HEADER: readonly string[] = [
  "employee_number",
  "employee_name",
  "scheme_reference",
  "employee_share",
  "employer_share",
];

/**
 * The key a scheme reference is read from in `employee_statutory_profile.extra` (8A's ⚠️ OD-28 seam), suffixed
 * with the scheme's CODE — `scheme_reference:<code>` — because one profile serves every scheme the employee is in
 * and each authority numbers its members separately. A local convention of the generic layout, not an authority
 * field name; Task 13 replaces it wholesale if a verified layout names the reference differently.
 */
export const SCHEME_REFERENCE_KEY_PREFIX = "scheme_reference:";

/** RFC 4180, CRLF, text cells neutralised against formula injection; the two shares are service-produced decimals. */
export function scheduleCsv(result: StatutoryScheduleResult): string {
  const lines = [SCHEDULE_CSV_HEADER.join(",")];
  for (const r of result.rows) {
    lines.push(
      [
        csvText(r.employeeNumber),
        csvText(r.employeeName),
        csvText(r.schemeReference),
        csvField(r.employeeShare),
        csvField(r.employerShare),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The archived file's name: the scheme's code and the period — never an authority's form name. */
export const scheduleFileName = (r: StatutoryScheduleResult): string =>
  `${r.schemeCode}-${r.periodStart}.csv`;

export interface GenerateScheduleInput {
  companyId: string;
  /** The POSTED PAYROLL run. Generation from anything else is refused (spec:2083). */
  payrollDocumentId: string;
  /** Omit to generate one schedule per scheme the run touched; a named scheme the run did not touch is refused. */
  schemeIds?: readonly string[];
  /** Writes the generic CSV as an `app.attachment` and links it. Default true. */
  attachCsv?: boolean;
}

interface RowWithVisibility extends ScheduleRow {
  visible: boolean;
}

/**
 * The per-employee rows of one schedule — the ONE grouped query the generator, `readSchedule` and `listSchedules`
 * all answer with, so a list and a regeneration can never disagree about a share (hazard 9). The shares are
 * aggregated from `payroll_line` first (tenant RLS only, so every line of the run is counted whoever asks) and the
 * employee joined after; an employee the caller cannot see is REFUSED rather than dropped, because a schedule short
 * of a row would understate what the authority is owed with nobody told (the money-out service's rule).
 */
async function scheduleRowsFor(
  tx: Sql,
  payrollDocumentId: string,
  schemeId: string,
  periodEnd: string,
): Promise<ScheduleRow[]> {
  const rows = await tx<RowWithVisibility[]>`
    with shares as (
      select pl.employee_id,
             coalesce(sum(pl.amount) filter (where pl.share = 'employee'), 0) as employee_share,
             coalesce(sum(pl.amount) filter (where pl.share = 'employer'), 0) as employer_share
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${payrollDocumentId} and pl.scheme_id = ${schemeId}
       group by pl.employee_id
    )
    select sh.employee_id as "employeeId",
           (e.id is not null) as visible,
           coalesce(e.employee_number, '') as "employeeNumber",
           coalesce(p.name_en, '') as "employeeName",
           coalesce(sp.reference, '') as "schemeReference",
           to_char(sh.employee_share, 'FM999999999999990.0000') as "employeeShare",
           to_char(sh.employer_share, 'FM999999999999990.0000') as "employerShare"
      from shares sh
      join app.statutory_scheme sc on sc.id = ${schemeId}
      left join app.employee e on e.id = sh.employee_id
      left join app.party p on p.id = e.party_id
      left join lateral (
        select x.extra ->> (${SCHEME_REFERENCE_KEY_PREFIX}::text || sc.code) as reference
          from app.employee_statutory_profile x
         where x.employee_id = sh.employee_id
           and x.effective_from <= ${periodEnd}::date
           and (x.effective_to is null or x.effective_to >= ${periodEnd}::date)
         order by x.effective_from desc
         limit 1
      ) sp on true
     order by e.employee_number nulls last, sh.employee_id`;
  const hidden = rows.filter((r) => !r.visible);
  if (hidden.length > 0) {
    throw new ScheduleError(
      "ERR_RBAC_FORBIDDEN",
      `${hidden.length} employee(s) on payroll run ${payrollDocumentId} are not visible to the caller; a schedule is company-wide`,
    );
  }
  return rows.map(({ visible: _visible, ...row }) => row);
}

interface ExistingScheduleRow {
  id: string;
  total_employee: string;
  total_employer: string;
  attachment_id: string | null;
  remittance_document_id: string | null;
}

export async function generateStatutorySchedule(
  tx: Sql,
  ctx: TenantContext,
  store: ObjectStore,
  input: GenerateScheduleInput,
): Promise<StatutoryScheduleResult[]> {
  const [run] = await tx<
    { status: string; period_start: string; period_end: string; base_currency: string }[]
  >`
    select d.status::text as status,
           to_char(r.period_start, 'YYYY-MM-DD') as period_start,
           to_char(r.period_end,   'YYYY-MM-DD') as period_end,
           c.base_currency
      from app.payroll_run r
      join app.document d on d.id = r.document_id
      join app.company  c on c.id = r.company_id
     where r.document_id = ${input.payrollDocumentId} and r.company_id = ${input.companyId}`;
  if (!run) {
    throw new ScheduleError(
      "ERR_NOT_FOUND",
      `payroll run ${input.payrollDocumentId} is not visible in this company`,
    );
  }
  if (run.status !== "posted") {
    // spec:2083, verbatim: "generated from posted lines only".
    throw new ScheduleError(
      "ERR_DOC_STATUS_ILLEGAL",
      `payroll run ${input.payrollDocumentId} is not posted (status ${run.status})`,
    );
  }
  // The scheme reference lives on `employee_statutory_profile`, behind 8A's RESTRICTIVE `compensation_gate`. A
  // generator without the code would archive a file with every reference silently blank, so it is refused — the
  // same rule 8B's run preparer is held to.
  const [gate] = await tx<{ allowed: boolean }[]>`
    select app.actor_has('hr.compensation.read', ${input.companyId}::uuid, null) as allowed`;
  if (gate?.allowed !== true) {
    throw new ScheduleError(
      "ERR_RBAC_FORBIDDEN",
      "generating a statutory schedule reads each employee's statutory profile and needs hr.compensation.read",
    );
  }
  const ccy = currency(run.base_currency);

  const wanted = input.schemeIds === undefined ? null : [...new Set(input.schemeIds)];
  const schemes = await tx<
    { scheme_id: string; scheme_code: string; employer_registration: string | null }[]
  >`
    select distinct pl.scheme_id, ss.code as scheme_code, ss.employer_registration
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.statutory_scheme ss on ss.id = pl.scheme_id
     where dl.document_id = ${input.payrollDocumentId}
       and pl.scheme_id is not null
       and (${wanted === null} or pl.scheme_id = any(${wanted ?? []}::uuid[]))
     order by ss.code`;
  if (wanted !== null && schemes.length !== wanted.length) {
    const found = new Set(schemes.map((s) => s.scheme_id));
    const missing = wanted.filter((id) => !found.has(id));
    throw new ScheduleError(
      "ERR_VALIDATION_FAILED",
      `payroll run ${input.payrollDocumentId} carries no line of scheme ${missing.join(", ")}`,
    );
  }

  const out: StatutoryScheduleResult[] = [];
  for (const scheme of schemes) {
    const rows = await scheduleRowsFor(
      tx,
      input.payrollDocumentId,
      scheme.scheme_id,
      run.period_end,
    );
    const totalEmployee = rows.reduce(
      (a, r) => a.add(Money.of(r.employeeShare, ccy)),
      Money.zero(ccy),
    );
    const totalEmployer = rows.reduce(
      (a, r) => a.add(Money.of(r.employerShare, ccy)),
      Money.zero(ccy),
    );

    // Idempotent on the natural key §4.6.1 fixes. A second generation of the same run RETURNS the row (the officer
    // regenerating after an attachment was lost is the ordinary case); a posted run's `payroll_line` rows are
    // immutable (8B), so its totals are the same every time and the update below runs only if a writer outside this
    // function moved them. A supplementary run is a different document and therefore a different row. 0091's guard
    // refuses a move of a SETTLED row's totals, whichever code attempts it.
    const [inserted] = await tx<ExistingScheduleRow[]>`
      insert into app.statutory_schedule
        (tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
         total_employee, total_employer, currency)
      values (${ctx.tenantId}, ${input.companyId}, ${scheme.scheme_id},
              ${run.period_start}::date, ${run.period_end}::date, ${input.payrollDocumentId},
              ${totalEmployee.toString()}, ${totalEmployer.toString()}, ${ccy})
      on conflict (scheme_id, period_start, payroll_document_id) do nothing
      returning id, total_employee::text as total_employee, total_employer::text as total_employer,
                attachment_id, remittance_document_id`;
    let row = inserted;
    if (!row) {
      const [existing] = await tx<ExistingScheduleRow[]>`
        select id, to_char(total_employee, 'FM999999999999990.0000') as total_employee,
               to_char(total_employer, 'FM999999999999990.0000') as total_employer,
               attachment_id, remittance_document_id
          from app.statutory_schedule
         where scheme_id = ${scheme.scheme_id} and period_start = ${run.period_start}::date
           and payroll_document_id = ${input.payrollDocumentId}
         for update`;
      row = existing!;
      if (
        row.total_employee !== totalEmployee.toString() ||
        row.total_employer !== totalEmployer.toString()
      ) {
        await tx`
          update app.statutory_schedule
             set total_employee = ${totalEmployee.toString()}, total_employer = ${totalEmployer.toString()}
           where id = ${row.id}`;
      }
    }

    const result: StatutoryScheduleResult = {
      scheduleId: row.id,
      companyId: input.companyId,
      schemeId: scheme.scheme_id,
      schemeCode: scheme.scheme_code,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      payrollDocumentId: input.payrollDocumentId,
      totalEmployee,
      totalEmployer,
      currency: ccy,
      attachmentId: row.attachment_id,
      remittanceDocumentId: row.remittance_document_id,
      rows,
      employerRegistration: scheme.employer_registration,
    };
    if (input.attachCsv !== false) {
      result.attachmentId = await attachCsv(tx, ctx, store, result);
    }
    out.push(result);
  }
  return out;
}

/**
 * Writes the CSV as an `app.attachment` with its sha256 (spec:2083 "attachment hash") through 2C's own
 * `createAttachment`: the OBJECT first under a freshly minted, server-derived key (SAH-038), then the row, so a row
 * never points at nothing and a rollback leaves only an unreferenced object.
 *
 * An archived file is never rewritten in place. When the schedule already links a live attachment whose sha256 is
 * the new file's, it is kept; when the bytes differ (an employee renamed, a scheme reference entered since), a NEW
 * attachment is written, linked, and the old one ARCHIVED (spec:2049) — its hash still verifies the bytes it named.
 *
 * `document_id` is the PAYROLL RUN: §4.5.8 gates a download by the owning document's module, and an attachment with
 * no owner is undownloadable by anyone (2C's default deny). The run's module is `hr` → `hr.payroll.read`.
 */
async function attachCsv(
  tx: Sql,
  ctx: TenantContext,
  store: ObjectStore,
  result: StatutoryScheduleResult,
): Promise<string> {
  const bytes = new TextEncoder().encode(scheduleCsv(result));
  if (result.attachmentId !== null) {
    const [current] = await tx<{ id: string; sha256: Buffer; archived: boolean }[]>`
      select id, sha256, archived_at is not null as archived
        from app.attachment where id = ${result.attachmentId}`;
    const digest = createHash("sha256").update(bytes).digest();
    if (current && !current.archived && digest.equals(current.sha256)) {
      return current.id;
    }
  }
  const attachment = await createAttachment(tx, ctx, store, {
    companyId: result.companyId,
    documentId: result.payrollDocumentId,
    fileName: scheduleFileName(result),
    mimeType: "text/csv",
    bytes,
  });
  if (result.attachmentId !== null) {
    await tx`
      update app.attachment set archived_at = now()
       where id = ${result.attachmentId} and archived_at is null`;
  }
  await tx`
    update app.statutory_schedule set attachment_id = ${attachment.id} where id = ${result.scheduleId}`;
  return attachment.id;
}

interface ScheduleHeaderRow {
  id: string;
  company_id: string;
  scheme_id: string;
  scheme_code: string;
  period_start: string;
  period_end: string;
  payroll_document_id: string;
  total_employee: string;
  total_employer: string;
  currency: string;
  attachment_id: string | null;
  remittance_document_id: string | null;
  employer_registration: string | null;
}

/** The one header column list; `readSchedule` takes one row of it and `listSchedules` a page. A postgres.js
 *  fragment — interpolated into another tagged template, never SQL text (Global Constraint 3). `ss2` is the
 *  schedule and `sc` its scheme; `ss` means the scheme inside the generator, so the readers do not reuse it. */
const HEADER_COLUMNS = (tx: Sql) => tx`
  ss2.id, ss2.company_id, ss2.scheme_id, sc.code as scheme_code,
  to_char(ss2.period_start, 'YYYY-MM-DD') as period_start,
  to_char(ss2.period_end,   'YYYY-MM-DD') as period_end,
  ss2.payroll_document_id,
  to_char(ss2.total_employee, 'FM999999999999990.0000') as total_employee,
  to_char(ss2.total_employer, 'FM999999999999990.0000') as total_employer,
  ss2.currency, ss2.attachment_id, ss2.remittance_document_id,
  sc.employer_registration`;

async function hydrate(tx: Sql, row: ScheduleHeaderRow): Promise<StatutoryScheduleResult> {
  const ccy = currency(row.currency);
  return {
    scheduleId: row.id,
    companyId: row.company_id,
    schemeId: row.scheme_id,
    schemeCode: row.scheme_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    payrollDocumentId: row.payroll_document_id,
    totalEmployee: Money.of(row.total_employee, ccy),
    totalEmployer: Money.of(row.total_employer, ccy),
    currency: ccy,
    attachmentId: row.attachment_id,
    remittanceDocumentId: row.remittance_document_id,
    rows: await scheduleRowsFor(tx, row.payroll_document_id, row.scheme_id, row.period_end),
    employerRegistration: row.employer_registration,
  };
}

/**
 * ⚠️ OD-23 (8C T15). The codes of the company's schemes whose employer registration is still null, sorted, so a caller
 * can NAME the gap — 8A's rule: the statutory schedule and 8D's employer return "state a missing registration by name
 * rather than printing an empty box", and a null field alone does not say which scheme. Reads 8A's own
 * `employerRegistrations` (the one query over the column), so there is one reader of the registrations, not two.
 */
export async function missingEmployerRegistrations(tx: Sql, companyId: string): Promise<string[]> {
  return (await employerRegistrations(tx, companyId))
    .filter((r) => r.registration === null)
    .map((r) => r.schemeCode);
}

export async function readSchedule(
  tx: Sql,
  scheduleId: string,
  scope: ScheduleScope = {},
): Promise<StatutoryScheduleResult> {
  const [row] = await tx<ScheduleHeaderRow[]>`
    select ${HEADER_COLUMNS(tx)}
      from app.statutory_schedule ss2
      join app.statutory_scheme sc on sc.id = ss2.scheme_id
     where ss2.id = ${scheduleId}
       and (${scope.companyId ?? null}::uuid is null or ss2.company_id = ${scope.companyId ?? null}::uuid)`;
  if (!row) {
    throw new ScheduleError("ERR_NOT_FOUND", `statutory schedule ${scheduleId} is not visible`);
  }
  return hydrate(tx, row);
}

export interface ListScheduleFilter {
  companyId: string;
  schemeId?: string;
  payrollDocumentId?: string;
  /** Bounds on `period_start`, inclusive. */
  from?: string;
  to?: string;
  settled?: boolean;
  limit: number;
  cursor?: { periodStart: string; id: string } | null;
}

/**
 * Keyset on `(period_start, id)` — the pair the §4.2.8 cursor carries — because `period_start` repeats across
 * schemes and an OFFSET page shifts under a concurrent generation. `settled` is the presence of
 * `remittance_document_id` and nothing else: a schedule is a record, not a lodgement state machine (spec:2083).
 */
export async function listSchedules(
  tx: Sql,
  filter: ListScheduleFilter,
): Promise<StatutoryScheduleResult[]> {
  const cursorDate = filter.cursor?.periodStart ?? null;
  const cursorId = filter.cursor?.id ?? null;
  const rows = await tx<ScheduleHeaderRow[]>`
    select ${HEADER_COLUMNS(tx)}
      from app.statutory_schedule ss2
      join app.statutory_scheme sc on sc.id = ss2.scheme_id
     where ss2.company_id = ${filter.companyId}
       and (${filter.schemeId ?? null}::uuid is null or ss2.scheme_id = ${filter.schemeId ?? null}::uuid)
       and (${filter.payrollDocumentId ?? null}::uuid is null
            or ss2.payroll_document_id = ${filter.payrollDocumentId ?? null}::uuid)
       and (${filter.from ?? null}::date is null or ss2.period_start >= ${filter.from ?? null}::date)
       and (${filter.to ?? null}::date is null   or ss2.period_start <= ${filter.to ?? null}::date)
       and (${filter.settled ?? null}::boolean is null
            or (ss2.remittance_document_id is not null) = ${filter.settled ?? null}::boolean)
       and (${cursorDate}::date is null
            or (ss2.period_start, ss2.id) > (${cursorDate}::date, ${cursorId}::uuid))
     order by ss2.period_start, ss2.id
     limit ${filter.limit}`;
  const out: StatutoryScheduleResult[] = [];
  for (const row of rows) out.push(await hydrate(tx, row));
  return out;
}

import type { Sql } from "postgres";
import { datasetFor } from "../reports/datasets";
import { ReportError } from "../reports/errors";
import { MAX_DATASET_ROWS, type DatasetRow } from "../reports/query";

// 8D T5 — spec:2083 "a payslip PDF per employee per run (stored as an attachment with its hash)". The FIGURES come from
// the `payroll_line` dataset (§4.16.2, 8D Task 2) — the dataset `hr.payroll_register` reads — so a payslip and the
// register can never disagree about a number. The dataset admits only posted and reversed documents, which is what
// makes "posted figures only" hold here without a second status clause.

export interface PayslipParams {
  companyId: string;
  payrollDocumentId: string;
  /** Omit (or pass an empty list) for every employee of the run. */
  employeeIds?: readonly string[];
}

export interface PayslipHeader {
  employeeId: string;
  employeeNumber: string;
  employeeNameEn: string;
  employeeNameAr: string | null;
  branchCode: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  runKind: "regular" | "supplementary" | "final";
  documentNumber: string;
  /** Fixed 4 dp strings, straight from numeric(19,4) — never a JS number (spec:2041). */
  gross: string;
  totalDeductions: string;
  net: string;
}

export interface PayslipBundle {
  header: PayslipHeader;
  /** The employee's `payroll_line` dataset rows — every component and scheme line, the employer share included (it
   *  is printed for information and contributes zero to net). The net-pay leg's own all-null line is NOT here: it is
   *  the figure the payslip states (`header.net`), not a line of it. */
  rows: readonly DatasetRow[];
}

/** Where a payroll run stands, for the payslip route's 404 / 409 — null when the company has no such run. */
export interface PayslipRunState {
  status: string;
}

export async function payslipRunState(
  tx: Sql,
  params: { companyId: string; payrollDocumentId: string },
): Promise<PayslipRunState | null> {
  const [row] = await tx<{ status: string }[]>`
    select d.status::text as status
      from app.document d join app.payroll_run pr on pr.document_id = d.id
     where d.id = ${params.payrollDocumentId}::uuid and d.company_id = ${params.companyId}::uuid`;
  return row === undefined ? null : { status: row.status };
}

interface Totals {
  employee_id: string;
  employee_number: string;
  employee_name_en: string;
  employee_name_ar: string | null;
  branch_code: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  run_kind: PayslipHeader["runKind"];
  document_number: string;
  gross: string;
  total_deductions: string;
  net: string;
}

/**
 * One bundle per employee of one POSTED run, in employee-number order; `[]` for a draft run or one of another company.
 *
 * The three header totals are summed IN SQL (numeric(19,4), spec:2041) from the same lines as the rows: gross is the
 * employee's earnings; deductions are the deduction components plus the employee's scheme shares; net is the
 * difference. An employer share is the company's cost and is in neither. The Σ net of a run's bundles equals the
 * run's credit to `2400` salaries payable — `packages/db/test/hr/payslip.test.ts` proves it against the ledger.
 */
export async function payslipRows(tx: Sql, params: PayslipParams): Promise<PayslipBundle[]> {
  const ids =
    params.employeeIds !== undefined && params.employeeIds.length > 0
      ? [...params.employeeIds]
      : null;
  const totals = await tx<Totals[]>`
    select e.id                                                   as employee_id,
           e.employee_number                                      as employee_number,
           p.name_en                                              as employee_name_en,
           p.name_ar                                              as employee_name_ar,
           bv.code                                                as branch_code,
           to_char(pr.period_start, 'YYYY-MM-DD')                 as period_start,
           to_char(pr.period_end,   'YYYY-MM-DD')                 as period_end,
           to_char(pr.pay_date,     'YYYY-MM-DD')                 as pay_date,
           pr.kind                                                as run_kind,
           d.number::text                                         as document_number,
           coalesce(sum(pl.amount) filter (where pc.kind = 'earning'), 0)::numeric(19,4)::text as gross,
           coalesce(sum(pl.amount) filter (
             where pc.kind = 'deduction' or (pl.scheme_id is not null and pl.share = 'employee')
           ), 0)::numeric(19,4)::text                             as total_deductions,
           (coalesce(sum(pl.amount) filter (where pc.kind = 'earning'), 0)
            - coalesce(sum(pl.amount) filter (
                where pc.kind = 'deduction' or (pl.scheme_id is not null and pl.share = 'employee')
              ), 0))::numeric(19,4)::text                         as net
      from app.payroll_line pl
      join app.document_line   dl on dl.id = pl.document_line_id
      join app.document        d  on d.id  = dl.document_id and d.status in ('posted', 'reversed')
      join app.payroll_run     pr on pr.document_id = d.id
      join app.employee        e  on e.id  = pl.employee_id
      join app.party           p  on p.id  = e.party_id
      join app.dimension_value bv on bv.id = e.home_branch_id
      left join app.pay_component pc on pc.id = pl.component_id
     where pl.company_id = ${params.companyId}::uuid
       and d.id = ${params.payrollDocumentId}::uuid
       and (${ids}::uuid[] is null or e.id = any(${ids}::uuid[]))
     group by e.id, e.employee_number, p.name_en, p.name_ar, bv.code,
              pr.period_start, pr.period_end, pr.pay_date, pr.kind, d.number
     order by e.employee_number`;
  if (totals.length === 0) return [];

  // ONE dataset read for the whole run, partitioned in memory: N reads would make a fifty-employee run fifty round
  // trips and let one employee's page see a different snapshot from the next's.
  const all = await datasetFor("payroll_line").run(tx, {
    companyId: params.companyId,
    filters: [{ field: "payroll_document_id", op: "eq", value: params.payrollDocumentId }],
    sort: [{ field: "employee_number", dir: "asc" }],
    limit: MAX_DATASET_ROWS,
    offset: 0,
  });
  // Never truncated (7A's rule, Phase 7 review finding 3): a run that fills the dataset's ceiling is refused rather
  // than printed short — a payslip missing a line would still total, and look right.
  if (all.length >= MAX_DATASET_ROWS) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `payroll run ${params.payrollDocumentId} has ${MAX_DATASET_ROWS} or more payroll lines; payslips are never printed off a truncated read`,
    );
  }
  const byEmployee = new Map<string, DatasetRow[]>();
  for (const r of all) {
    if (r["component_id"] === null && r["scheme_id"] === null) continue; // the net-pay leg
    const key = String(r["employee_id"]);
    const list = byEmployee.get(key);
    if (list === undefined) byEmployee.set(key, [r]);
    else list.push(r);
  }

  return totals.map((t) => ({
    header: {
      employeeId: t.employee_id,
      employeeNumber: t.employee_number,
      employeeNameEn: t.employee_name_en,
      employeeNameAr: t.employee_name_ar,
      branchCode: t.branch_code,
      periodStart: t.period_start,
      periodEnd: t.period_end,
      payDate: t.pay_date,
      runKind: t.run_kind,
      documentNumber: t.document_number,
      gross: t.gross,
      totalDeductions: t.total_deductions,
      net: t.net,
    },
    rows: byEmployee.get(t.employee_id) ?? [],
  }));
}

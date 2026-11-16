import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportDefinition } from "@dulja/domain";
// The PRODUCTION `withTenant(sql, ctx, fn)` (§4.2.2) — the test tier passes a `TenantContext` (round 19 A13 item 9).
import {
  generateStatutorySchedule,
  MemoryObjectStore,
  withTenant,
  type StatutoryScheduleResult,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedBranch,
  seedEmployee,
  seedPayrollRun,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../../support/source";
import { payrollFixture, postPayrollRun, type PayrollFixture } from "./payroll";
// 7B's typed twin of 7A's loader envelope (`definition: ReportDefinition`), not the loader's own `unknown` one.
import type { ReportSeedEnvelope } from "./reports";

// 8D — contracts round 19, amendment 8D A7 (§4.17.1). The ONE place an 8D report definition is read off disk and the
// ONE payroll corpus its reports run over. Several test files import it (the HR datasets, the definitions and their
// tie-outs, the payslips), which is why it is shared rather than file-local — 7B's `reports.ts` reasoning.

/** §4.16.1's eight 8D codes, in register order. A ninth is an amendment, not an edit here. */
export const HR_CATALOGUE = [
  "hr.employee_list",
  "hr.contract_expiry",
  "hr.attendance",
  "hr.payroll_register",
  "hr.statutory_summary",
  "hr.payable_reconciliation",
  "hr.payslip",
  "hr.annual_statement",
] as const;
export type HrReportCode = (typeof HR_CATALOGUE)[number];

export const HR_CATALOGUE_DIR = join(REPO_ROOT, "packages/db/seed/my/reports/8d");

/** The envelope on disk: `{ definitionVersion, definition }` (§4.16.1, 7A Task 14), checked as 7B's reader does. */
export function readHrEnvelope(code: HrReportCode): ReportSeedEnvelope {
  const path = join(HR_CATALOGUE_DIR, `${code}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ReportSeedEnvelope;
  if (!Number.isInteger(parsed.definitionVersion) || parsed.definitionVersion < 1) {
    throw new Error(`${path}: definitionVersion must be an integer >= 1`);
  }
  if (parsed.definition?.code !== code) {
    throw new Error(
      `${path}: definition.code is ${String(parsed.definition?.code)}, the file name says ${code}`,
    );
  }
  return parsed;
}
export function readHrDefinition(code: HrReportCode): ReportDefinition {
  return readHrEnvelope(code).definition;
}

export interface HrReportFixture {
  db: Db;
  s: Seed;
  payroll: PayrollFixture;
  /** The posted regular January run every money report reads. */
  runDocumentId: string;
  /** A DRAFT February run over the same two employees, so "posted figures only" is asserted against something
   *  that exists rather than skipped when the corpus happens to hold no draft. */
  draftRunDocumentId: string;
  /** 8C's schedules for `runDocumentId`, one per scheme the run touched — the rows the `statutory_schedule` dataset
   *  and its tie-out read. Nothing else writes `app.statutory_schedule`. */
  schedules: StatutoryScheduleResult[];
  /** Every employee of the company, by number, with their home branch's code: the fixture's two payroll employees
   *  and the fixed-term contractor. */
  employees: { id: string; number: string; branchCode: string }[];
  /** The fixed-term contractor (`employment_type = 'contract'`, `contract_ends_on = CONTRACT_ENDS_ON`), on no run. */
  contractorId: string;
  /** The calendar year of the posted run's pay date — `employee_ytd.tax_year` (round 18 B7). */
  taxYear: number;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

const PERIOD_START = "2026-01-01";
const PERIOD_END = "2026-01-31";
const PAY_DATE = "2026-01-28";
const DRAFT_START = "2026-02-01";
const DRAFT_END = "2026-02-28";
export const CONTRACT_ENDS_ON = "2026-03-31";
/**
 * The four attendance events of employee A — instants, UTC — on the seeded company's `Asia/Kuala_Lumpur` clock. The
 * clock-out at 16:30Z is 00:30 local on 6 January: a late shift whose UTC date and local date differ, so a report that
 * bucketed by the UTC date would put it on the wrong day. Local days: 5 Jan holds one event, 6 Jan three.
 */
export const ATTENDANCE_EVENTS = [
  { kind: "clock_in", at: "2026-01-05T01:02:03Z" },
  { kind: "clock_out", at: "2026-01-05T16:30:00Z" },
  { kind: "clock_in", at: "2026-01-06T01:01:01Z" },
  { kind: "manual_correction", at: "2026-01-06T11:00:00Z" },
] as const;

const ctxOf = (s: Seed, actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/**
 * The corpus every 8D report runs over: 8B's payroll fixture (two employees in two branches, one scheme on the
 * SYNTH table, two components, the eleven §4.15 accounts and the PAYROLL type), one POSTED regular January run,
 * 8C's statutory schedules for that run, a February DRAFT run, four attendance events, and a third employee on a
 * fixed-term contract so `hr.contract_expiry` has a row to find.
 *
 * It seeds from 8B's fixture rather than restating it, so a report and the payroll it reports on can never disagree.
 * `s.human` is granted `hr.payroll.prepare` (for `postPayrollRun`) and `hr.payroll.read` on top of the fixture's
 * `hr.compensation.read` (which 8C's generator needs). NOT idempotent: `payrollFixture` is not — one call per `Seed`.
 */
export async function hrReportFixture(db: Db, s: Seed): Promise<HrReportFixture> {
  const payroll = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.read"] });
  const runDocumentId = await postPayrollRun(db, s, payroll, {
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payDate: PAY_DATE,
    effectiveDate: PERIOD_END,
    kind: "regular",
  });

  // 8C's schedules. NOTHING else writes app.statutory_schedule — not `postPayrollRun`, not `postDocument` — so
  // without this call the `statutory_schedule` dataset iterates zero rows and every assertion over it passes
  // vacuously. The store is in-memory: the CSV attachment is 8C's concern and no 8D assertion reads its bytes.
  const schedules = await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    generateStatutorySchedule(tx, ctxOf(s, s.human), new MemoryObjectStore(), {
      companyId: s.company,
      payrollDocumentId: runDocumentId,
    }),
  );

  // A DRAFT run over the same two employees. `seedPayrollRun` does not calculate or post, which is the point: lines
  // exist, the document stays `draft`, and every "posted figures only" assertion has a real negative. It resolves its
  // fiscal period from the effective date (8B), so February's own period end is the document date.
  const draftRunDocumentId = await seedPayrollRun(db, s, {
    periodStart: DRAFT_START,
    periodEnd: DRAFT_END,
    payDate: DRAFT_END,
    employeeIds: [payroll.employeeAId, payroll.employeeBId],
    kind: "regular",
  });

  const contractorBranch = await seedBranch(db, s, { code: "BR-C", nameEn: "Contract branch" });
  const contractorId = await seedEmployee(db, s, {
    employeeNumber: "E-1099",
    homeBranchId: contractorBranch,
  });

  await withTenant(db.rw, ctxOf(s, s.human), async (tx) => {
    // The contractor's fixed-term dates: `contract_ends_on` is 8D's own column (8D A2, migration 0098).
    await tx`update app.employee
                set employment_type = 'contract', position = 'Storekeeper',
                    contract_ends_on = ${CONTRACT_ENDS_ON}::date
              where id = ${contractorId}`;
    // Four attendance events for employee A — 6C's table, read here for the first time (§4.16.2's rule).
    for (const { kind, at } of ATTENDANCE_EVENTS) {
      await tx`insert into app.attendance_event
                 (tenant_id, company_id, employee_id, branch_id, kind, occurred_at, note)
               values (${s.tenant}, ${s.company}, ${payroll.employeeAId}, ${s.hq}, ${kind}, ${at}::timestamptz,
                       ${kind === "manual_correction" ? "corrected by the branch manager" : null})`;
    }
  });

  const employees = await withTenant(
    db.rw,
    ctxOf(s, s.human),
    (tx) =>
      tx<{ id: string; number: string; branchCode: string }[]>`
      select e.id, e.employee_number as "number", bv.code as "branchCode"
        from app.employee e join app.dimension_value bv on bv.id = e.home_branch_id
       where e.company_id = ${s.company} order by e.employee_number`,
  );

  return {
    db,
    s,
    payroll,
    runDocumentId,
    draftRunDocumentId,
    schedules,
    employees: [...employees],
    contractorId,
    taxYear: Number(PAY_DATE.slice(0, 4)),
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payDate: PAY_DATE,
  };
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import {
  payrollFixture,
  postPayrollRun,
  type PayrollFixture,
} from "../../../../tests/invariants/support/payroll";
import {
  EMPLOYEE_YTD_DRIFT_SENTINEL,
  registerEmployeeYtdRebuild,
} from "../../src/jobs/employee-ytd-rebuild";
import { startWorker, type StartedWorker } from "../support/worker";

// 8C T9 — hr.employee_ytd.rebuild (spec:2084 / D14 — report, never repair). Figures are the SYNTH table's (hazard 1):
// one posted January run, BASIC 2000.0000 per employee.

describe("hr.employee_ytd.rebuild", () => {
  let w: StartedWorker;
  let s: Seed;
  let f: PayrollFixture;

  const run = async (payload: { companyId?: string; year?: number } = {}) =>
    w.run("hr.employee_ytd.rebuild", {
      tenantId: s.tenant,
      requestId: await uuidv7(w.db.admin),
      payload,
    });
  // `order by seq`: app.audit_log has no created_at, and seq is its strictly monotonic identity.
  const sentinels = () =>
    w.db.admin<
      {
        actor_id: string;
        row_id: string;
        after: {
          companyId: string | null;
          year: number | null;
          mismatches: {
            projection: string;
            side: string;
            detail: string;
            key: Record<string, string>;
          }[];
        };
      }[]
    >`
      select actor_id, row_id, after from app.audit_log
       where tenant_id = ${s.tenant} and table_name = ${EMPLOYEE_YTD_DRIFT_SENTINEL} order by seq`;
  const grossOf = async () =>
    (
      await w.db.admin<{ gross: string }[]>`
        select gross::text as gross from app.employee_ytd
         where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`
    )[0]!.gross;

  beforeAll(async () => {
    w = await startWorker();
    registerEmployeeYtdRebuild(); // idempotent: startWorker registered it as production does
    s = await seedTenantV2(w.db, "YTD rebuild job");
    f = await payrollFixture(w.db, s);
    await grantCodes(w.db, s, { codes: ["hr.payroll.prepare"] });
    await postPayrollRun(w.db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
  }, 240_000);
  afterAll(async () => {
    await w.stop();
  });

  it("is the JOBS name 8C owns, scheduled nightly at 04:00 (§4.2.6)", () => {
    expect(JOBS["hr.employee_ytd.rebuild"]).toEqual({ schedule: "0 4 * * *", owner: "8C" });
  });

  it("a clean tenant writes NO sentinel and logs that the projection matches", async () => {
    w.logs.length = 0;
    await run();
    expect(await sentinels()).toEqual([]);
    expect(w.logs.filter((l) => l.msg === "employee_ytd matches its rebuild")).toHaveLength(1);
  });

  it("a hand-corrupted row writes exactly one sentinel naming the column and both values", async () => {
    await w.db.admin`
      update app.employee_ytd set gross = gross + 1
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    w.logs.length = 0;
    await run();
    const rows = await sentinels();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.mismatches).toEqual([
      {
        projection: "employee_ytd",
        side: "amount_differs",
        detail: "gross 2001.0000 <> 2000.0000",
        key: { company_id: s.company, employee_id: f.employeeAId, tax_year: "2026" },
      },
    ]);
    const errors = w.logs.filter((l) => l.msg === "employee_ytd drifted from its rebuild");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.level).toBe("error");
  });

  it("REPAIRS nothing — the corrupted value is still there afterwards (6C's compare precedent)", async () => {
    const before = await grossOf();
    await run();
    expect(await grossOf()).toBe(before);
    expect(await sentinels()).toHaveLength(2); // and it reported again
  });

  it("the sentinel is written by the tenant's SYSTEM principal (R8, spec:2179; hazard 20)", async () => {
    const rows = await sentinels();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.actor_id).toBe(s.system);
  });

  it("the payload narrows the compare: another company or another year reports clean and writes nothing", async () => {
    const other = await seedTenantV2(w.db, "YTD rebuild other tenant");
    await run({ companyId: other.company });
    await run({ year: 2027 });
    expect(await sentinels()).toHaveLength(2);
    await run({ companyId: s.company, year: 2026 });
    const rows = await sentinels();
    expect(rows).toHaveLength(3);
    expect(rows[2]!.after).toMatchObject({ companyId: s.company, year: 2026 });
  });

  it("once the value is put back the compare is clean again and no new sentinel is written", async () => {
    await w.db.admin`
      update app.employee_ytd set gross = gross - 1
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const before = (await sentinels()).length;
    await run();
    expect(await sentinels()).toHaveLength(before);
  });
});

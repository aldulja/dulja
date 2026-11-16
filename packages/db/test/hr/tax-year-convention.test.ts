import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import {
  generateStatutorySchedule,
  listSchedules,
  missingEmployerRegistrations,
  readSchedule,
} from "../../src/hr/schedule";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import {
  moneyOutFixture,
  type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";
import { postPayrollRun } from "../../../../tests/invariants/support/payroll";

// 8C T15 — ⚠️ OD-23's two 8C clauses (docs/owner/od-23-employer-registrations.md, "What 8C adds"): the pay-date
// convention behind `employee_ytd.tax_year` (round 18 B7) and the employer registration number per scheme, which the
// statutory schedule is the first to consume. Every registration string here is INVENTED (hazard 1).

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
let schemeCode: string;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });
const asHuman = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, s.tenant, s.human, fn);

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Od23");
  f = await moneyOutFixture(db, s); // posts the January 2026 run, pay date 2026-02-05
  // The code is READ: payrollFixture seeds the scheme as `EPF`; only the rate table is SYNTH.
  const [scheme] = await db.admin<{ code: string }[]>`
    select code from app.statutory_scheme where id = ${f.schemeId}`;
  schemeCode = scheme!.code;
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("⚠️ OD-23 (a) — the pay-date convention, amendment B7", () => {
  it("a December period paid in January accumulates into the PAY DATE's year, not the period's", async () => {
    // The one case the convention is visible in: this run's period ends in 2026 and its money reaches the employee
    // in 2027.
    const crossing = await postPayrollRun(db, s, f, {
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      payDate: "2027-01-05",
      effectiveDate: "2026-12-31",
    });

    const rows = await asHuman(
      (tx) => tx<{ tax_year: number; gross: string }[]>`
        select tax_year, gross::text as gross from app.employee_ytd
         where company_id = ${s.company} and employee_id = ${f.employeeAId}
         order by tax_year`,
    );
    // Two rows: January 2026's (from moneyOutFixture) and December's, which landed in 2027 — each one run's gross.
    expect(rows).toEqual([
      { tax_year: 2026, gross: "2000.0000" },
      { tax_year: 2027, gross: "2000.0000" },
    ]);

    // ...and the crossing run contributed to 2027 ALONE.
    const deltas = await asHuman(
      (tx) => tx<{ tax_year: number }[]>`
        select tax_year from app.employee_ytd_delta(${crossing}) where employee_id = ${f.employeeAId}`,
    );
    expect(deltas.map((d) => d.tax_year)).toEqual([2027]);
  });

  it("the convention is recorded as a convention, never as a statutory claim (hazard 1)", async () => {
    const [c] = await db.admin<{ description: string | null }[]>`
      select col_description('app.employee_ytd'::regclass, attnum) as description
        from pg_attribute where attrelid = 'app.employee_ytd'::regclass and attname = 'tax_year'`;
    expect(c!.description).toMatch(/B7/);
    expect(c!.description).toMatch(/payroll_run\.pay_date/);
    expect(c!.description).toMatch(/NOT a statutory claim/);
  });
});

describe("⚠️ OD-23 (b) — the employer registration numbers", () => {
  it("a schedule generates with a NULL registration, and the null is visible rather than blank", async () => {
    const store = new MemoryObjectStore();
    const [result] = await asHuman((tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    // The RECORD is complete — a missing registration is a filing fact, not a ledger fact, and test 30's tie-out is
    // unaffected by it.
    expect(result!.totalEmployee.toString()).toBe("100.0000");
    expect(result!.employerRegistration).toBeNull();
    expect(await asHuman((tx) => readSchedule(tx, result!.scheduleId))).toMatchObject({
      employerRegistration: null,
    });

    // And the gap is NAMED — 8A's own OD-23 rule: a missing registration is stated by name, never an empty box.
    expect(await asHuman((tx) => missingEmployerRegistrations(tx, s.company))).toEqual([
      schemeCode,
    ]);
  });

  it("once the owner supplies a number it round-trips onto every reader", async () => {
    await asHuman(
      (tx) => tx`
        update app.statutory_scheme set employer_registration = 'SYNTH-EMPLOYER-0001'
         where id = ${f.schemeId}`,
    );
    const store = new MemoryObjectStore();
    const [result] = await asHuman((tx) =>
      generateStatutorySchedule(tx, ctx(), store, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    expect(result!.employerRegistration).toBe("SYNTH-EMPLOYER-0001");
    expect((await asHuman((tx) => readSchedule(tx, result!.scheduleId))).employerRegistration).toBe(
      "SYNTH-EMPLOYER-0001",
    );
    const listed = await asHuman((tx) => listSchedules(tx, { companyId: s.company, limit: 10 }));
    expect(listed.map((r) => r.employerRegistration)).toEqual(
      listed.map(() => "SYNTH-EMPLOYER-0001"),
    );
    expect(await asHuman((tx) => missingEmployerRegistrations(tx, s.company))).toEqual([]);
  });

  it.skip("⚠️ OD-23: every scheme in the owner's company carries its registration", async () => {
    // Un-skip when the owner answers. The executable form of the psql command in the owner record's Verify line.
    const missing = await asHuman((tx) => missingEmployerRegistrations(tx, s.company));
    expect(missing, `schemes without an employer registration: ${missing.join(", ")}`).toEqual([]);
  });
});

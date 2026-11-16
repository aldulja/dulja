import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { payslipRows, payslipRunState } from "../../src/hr/payslip";
import {
  hrReportFixture,
  type HrReportFixture,
} from "../../../../tests/invariants/support/hr-reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

// 8D T5 — payslipRows (spec:2083). SYNTH figures (hazard 1): per employee BASIC 2000.0000, employee share 50.0000,
// employer share 100.0000, net 1950.0000.

const MYR = currency("MYR");

describe("payslipRows — spec:2083, one bundle per employee of one posted run", () => {
  let db: Db;
  let s: Seed;
  let f: HrReportFixture;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "payslip-rows");
    f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  const bundles = () =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }),
    );

  it("returns one bundle per employee in the run, in employee-number order", async () => {
    const out = await bundles();
    expect(out.map((b) => b.header.employeeId)).toEqual([
      f.payroll.employeeAId,
      f.payroll.employeeBId,
    ]);
    expect(out.map((b) => b.header.employeeNumber)).toEqual(
      out.map((b) => b.header.employeeNumber).toSorted(),
    );
    for (const b of out) {
      expect(b.header.periodStart).toBe(f.periodStart);
      expect(b.header.periodEnd).toBe(f.periodEnd);
      expect(b.header.payDate).toBe(f.payDate);
      expect(b.header.runKind).toBe("regular");
      expect(b.rows.length).toBeGreaterThan(0);
      for (const r of b.rows) expect(r["employee_id"]).toBe(b.header.employeeId);
    }
  });

  it("gross − deductions = net on every bundle, at 4 dp, as strings — the SYNTH figures", async () => {
    for (const b of await bundles()) {
      expect(b.header.gross).toBe("2000.0000");
      expect(b.header.totalDeductions).toBe("50.0000");
      expect(b.header.net).toBe("1950.0000");
      const computed = Money.of(b.header.gross, MYR).subtract(
        Money.of(b.header.totalDeductions, MYR),
      );
      expect(computed.toString()).toBe(Money.of(b.header.net, MYR).toString());
    }
  });

  it("the rows carry every component and scheme line and NOT the net-pay leg; their net contributions sum to net", async () => {
    for (const b of await bundles()) {
      expect(b.rows.some((r) => r["component_id"] === null && r["scheme_id"] === null)).toBe(false);
      expect(b.rows.map((r) => r["share"]).toSorted()).toEqual(["employee", "employer", null]);
      const net = b.rows.reduce(
        (a, r) => a.add(Money.of(String(r["net_contribution"]), MYR)),
        Money.zero(MYR),
      );
      expect(net.toString()).toBe(b.header.net);
    }
  });

  it("Σ net over the bundles equals the run's credit to salaries payable (2400) — per employee and in total", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const out = await payslipRows(tx, {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
      });
      const reported = out.reduce((a, b) => a.add(Money.of(b.header.net, MYR)), Money.zero(MYR));
      const [row] = await tx<{ credit: string }[]>`
        select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${s.company} and le.document_id = ${f.runDocumentId} and a.code = '2400'`;
      expect(reported.toString()).toBe(Money.of(row!.credit, MYR).toString());
      expect(reported.toString()).toBe("3900.0000");
      // Per employee: the net-pay leg posted to 2400 for that employee is the payslip's net. The leg is the
      // all-null payroll_line beside the posting's net-pay document_line.
      for (const b of out) {
        const [leg] = await tx<{ amount: string }[]>`
          select pl.amount::text as amount
            from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
           where dl.document_id = ${f.runDocumentId} and pl.employee_id = ${b.header.employeeId}
             and pl.component_id is null and pl.scheme_id is null`;
        expect(Money.of(leg!.amount, MYR).toString()).toBe(b.header.net);
      }
    });
  });

  it("a draft run yields no bundle — a payslip is made from posted figures only (spec:2083)", async () => {
    // UNCONDITIONAL: `hrReportFixture` seeds a February DRAFT run over the same two employees for exactly this.
    const state = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRunState(tx, { companyId: s.company, payrollDocumentId: f.draftRunDocumentId }),
    );
    expect(state).toEqual({ status: "draft" });
    const out = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.draftRunDocumentId }),
    );
    expect(out).toEqual([]);
  });

  it("employeeIds narrows the result and an unknown id yields nothing", async () => {
    const [first] = await bundles();
    const only = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
        employeeIds: [first!.header.employeeId],
      }),
    );
    expect(only.map((b) => b.header.employeeId)).toEqual([first!.header.employeeId]);
    const none = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      payslipRows(tx, {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
        employeeIds: [f.contractorId],
      }),
    );
    expect(none).toEqual([]);
  });

  it("the run state is bound to the company; a second tenant sees nothing", async () => {
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        payslipRunState(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }),
      ),
    ).toEqual({ status: "posted" });
    const other = await seedTenantV2(db, "payslip-rows-b");
    const out = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      payslipRows(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }),
    );
    expect(out).toEqual([]);
    expect(
      await withTenant(db.rw, other.tenant, other.human, (tx) =>
        payslipRunState(tx, { companyId: s.company, payrollDocumentId: f.runDocumentId }),
      ),
    ).toBeNull();
  });
});

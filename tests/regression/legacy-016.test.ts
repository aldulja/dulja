import { beforeAll, describe, expect, it } from "vitest";
import {
  calculatePayrollRun,
  checkEmployeeYtdProjection,
  postDocument,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";
import { payrollFixture, postPayrollRun, type PayrollFixture } from "../invariants/support/payroll";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("016"); // ← this file's own LEGACY number

describe("LEGACY-016 Min/max prices that ratchet permanently, maintained on INSERT only — 3B", () => {
  // first proven by spec:354, spec:1210
  it("no ratcheting extreme is stored anywhere in the costing tables", async () => {
    const { db } = await ctx.inventory();
    const cols = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and table_name in ('cost_layer', 'cost_consumption', 'stock_valuation')`;
    for (const c of cols) expect(c.column_name).not.toMatch(/min|max|latest|lowest|highest/i);
  });
  it("a mis-keyed price is corrected by reversing the document, and the layer follows", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    const fat = await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "1.000000", unitPrice: "0.0100" }],
    });
    await ctx.reverse(db, s, fat.documentId, "2026-01-10");
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "1.000000", unitPrice: "1.0000" }],
    });
    expect((await ctx.valuation(db, s, "2026-01-31")).unitCost).toBe("1.0000");
  });
});

describe("LEGACY-016 A maintained figure that only ratchets upward — 8C", () => {
  // first proven by spec:354; the 8C instance is employee_ytd.net, which a correction must be able to move DOWN.
  let db: Db;
  let s: Seed;
  let f: MoneyOutFixture;
  const ytdCtx = (actor: string): TenantContext => ({
    tenantId: s.tenant,
    actorId: actor,
    requestId: "00000000-0000-0000-0000-000000000000",
  });
  const netOf = async () =>
    (
      await db.admin<{ net: string }[]>`
        select net::text as net from app.employee_ytd
         where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`
    )[0]!.net;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-016 8C"); // its own tenant: moneyOutFixture is not idempotent
    f = await moneyOutFixture(db, s);
  }, 240_000);

  /**
   * A `supplementary` run that RECOVERS `amount` of over-paid net (ADR 0076's correction path). 8B's calculator
   * refuses a negative net, so the shape is hand-drafted on a real supplementary draft: its calculated lines are
   * replaced (a draft's lines are editable) by the two lines 8B's policy reads for a recovery — an ADV_RECOVERY
   * DEDUCTION line (credit 1400) and a net-pay `account` line carrying a DEBIT to 2400 (the policy's debit rule) — each
   * with its payroll_line so `line.employee` resolves the EMPLOYEE dimension. The shape is what is regressed.
   */
  async function postRecovery(amount: string): Promise<string> {
    const run = await withTenant(db.rw, ytdCtx(s.human), (tx) =>
      calculatePayrollRun(tx, ytdCtx(s.human), {
        companyId: s.company,
        kind: "supplementary",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        payDate: "2026-04-05", // the same tax year as January's run (round 18 B7)
        effectiveDate: "2026-03-31",
        branchId: s.hq,
        employeeIds: [f.employeeAId],
      }),
    );
    await withTenant(db.rw, ytdCtx(s.human), async (tx) => {
      const [employee] = await tx<{ home_branch_id: string }[]>`
        select home_branch_id from app.employee where id = ${f.employeeAId}`;
      const dimensions = JSON.stringify({ BRANCH: employee!.home_branch_id });
      await tx`delete from app.document_line where document_id = ${run.documentId}`;
      const [recovery] = await tx<{ id: string }[]>`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, amount, dimensions)
        values (${s.tenant}, ${s.company}, ${run.documentId}, 1, 'payroll', ${amount},
                ${dimensions}::text::jsonb)
        returning id`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, amount)
        values (${recovery!.id}, ${s.tenant}, ${s.company}, ${f.employeeAId}, ${f.componentAdvanceId}, ${amount})`;
      const [netLine] = await tx<{ id: string }[]>`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                       debit, credit, amount, dimensions)
        values (${s.tenant}, ${s.company}, ${run.documentId}, 2, 'account', ${f.salariesPayableAccountId},
                ${amount}, 0, ${amount}, ${dimensions}::text::jsonb)
        returning id`;
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${netLine!.id}, ${s.tenant}, ${s.company}, ${f.employeeAId}, ${amount})`;
    });
    await withTenant(db.rw, ytdCtx(s.human), (tx) =>
      transitionDocument(tx, ytdCtx(s.human), { documentId: run.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, ytdCtx(f.approver), (tx) =>
      transitionDocument(tx, ytdCtx(f.approver), { documentId: run.documentId, to: "approved" }),
    );
    await withTenant(db.rw, ytdCtx(f.approver), (tx) =>
      postDocument(tx, ytdCtx(f.approver), { documentId: run.documentId }),
    );
    return run.documentId;
  }

  it("a supplementary run carrying a DEBIT net moves employee_ytd.net DOWN, and gross not at all", async () => {
    const [before] = await db.admin<{ gross: string }[]>`
      select gross::text as gross from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`;
    expect(await netOf()).toBe("1950.0000");
    await postRecovery("100.0000");
    // The legacy figure could only ratchet up. The sign comes from document_line.debit — where the POLICY put the
    // direction — never from payroll_line.amount, which 8B constrains >= 0 (§4.4.2 A9).
    expect(await netOf()).toBe("1850.0000");
    const [after] = await db.admin<{ gross: string; by_component: Record<string, string> }[]>`
      select gross::text as gross, by_component from app.employee_ytd
       where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`;
    expect(after!.gross).toBe(before!.gross);
    expect(after!.by_component).toEqual({ ADV_RECOVERY: "100.0000", BASIC: "2000.0000" });
  });

  it("and the rebuild still matches, because both sides read the same signed delta", async () => {
    expect(
      await withTenant(db.rw, ytdCtx(s.system), (tx) => checkEmployeeYtdProjection(tx)),
    ).toEqual([]);
  });
});

describe("LEGACY-016 A maintained figure that moves by the whole period on a correction — review 2026-11-15 (HRP-02)", () => {
  // A correction to a posted period must move employee_ytd by the DIFFERENCE. Before HRP-02's fix a supplementary run
  // re-paid the whole period, so a 500 raise found after January posted moved gross by 2500 (ADR 0076's amendment).
  let db: Db;
  let s: Seed;
  let f: PayrollFixture;
  const as = (actor: string): TenantContext => ({
    tenantId: s.tenant,
    actorId: actor,
    requestId: "00000000-0000-0000-0000-000000000000",
  });
  const JAN = {
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    payDate: "2026-02-05",
    effectiveDate: "2026-01-31",
  };
  const grossOf = async () =>
    (
      await db.admin<{ gross: string }[]>`
        select gross::text as gross from app.employee_ytd
         where company_id = ${s.company} and employee_id = ${f.employeeAId} and tax_year = 2026`
    )[0]!.gross;

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-016 HRP-02"); // its own tenant: payrollFixture is not idempotent
    f = await payrollFixture(db, s);
    await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
  }, 240_000);

  it("a supplementary correction moves employee_ytd.gross by the difference, and the rebuild agrees", async () => {
    await postPayrollRun(db, s, f, JAN);
    expect(await grossOf()).toBe("2000.0000");
    await withTenant(db.rw, as(s.human), async (tx) => {
      await tx`update app.compensation_line set effective_to = '2026-01-14'
                where employee_id = ${f.employeeAId} and effective_to is null`;
      await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
               values (${s.tenant}, ${f.employeeAId}, ${f.componentBasicId}, '2026-01-15', '2500.0000')`;
    });
    await postPayrollRun(db, s, f, { ...JAN, kind: "supplementary", employeeIds: [f.employeeAId] });
    expect(await grossOf()).toBe("2500.0000");
    expect(await withTenant(db.rw, as(s.system), (tx) => checkEmployeeYtdProjection(tx))).toEqual(
      [],
    );
  });
});

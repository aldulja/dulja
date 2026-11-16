import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { PayrollCalculationError } from "@dulja/domain/payroll";
import { calculatePayrollRun, readPayrollRun, recalculatePayrollRun } from "../../src/hr/run";
import { PayrollRunError } from "../../src/hr/run-error";
import { ytdFromPostedLines } from "../../src/hr/ytd";
import { postDocument, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedPayComponent, seedRateTable, seedTenantV2, type Seed } from "../fixtures";
import {
  payrollFixture,
  secondApprover,
  type PayrollFixture,
} from "../../../../tests/invariants/support/payroll";

// 8B T10 — the run service (§4.12.6, spec:2081). Every figure comes from the synthetic SYNTH table (§4.12.4): a base
// of 2000.0000 sits in its 1000–5000 band, so each employee's shares are 50.0000 and 100.0000 (hazard 1).

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: PayrollFixture;
const ctxOf = (seed: Seed, actor?: string) => ({
  tenantId: seed.tenant,
  actorId: actor ?? seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
/** Test-side edits to 8A rows, as the tenant's system principal: `compensation_gate` admits it, and the audit
 *  trigger needs a tenant context that `db.admin` does not set. */
const asSystem = (fn: (tx: Sql) => Promise<unknown>) =>
  withTenant(db.migrator, s.tenant, s.system, fn);

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Run");
  f = await payrollFixture(db, s); // the chart, the PAYROLL type, SYNTH, two employees
  await grantCodes(db, s, {
    codes: ["hr.payroll.prepare", "hr.payroll.approve", "hr.payroll.post"],
  });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** The refusal's code, or "resolved". */
const code = (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (error: unknown) => (error as { code?: string }).code,
  );

const RUN = {
  kind: "regular" as const,
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payDate: "2026-02-05",
  effectiveDate: "2026-01-31",
};
const regularRun = () =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    calculatePayrollRun(tx, ctxOf(s), { ...RUN, companyId: s.company, branchId: s.hq }),
  );
/** A throwaway draft for the tests below. Migration 0128 admits one regular run per company and period (HRP-08) and
 *  these tests draft many, so each is a SUPPLEMENTARY run naming both employees — with nothing of its period posted,
 *  it carries exactly a regular run's lines (ADR 0076's amendment). `over` moves it to another period. */
const run = (over: Partial<Omit<typeof RUN, "kind">> = {}) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    calculatePayrollRun(tx, ctxOf(s), {
      ...RUN,
      kind: "supplementary",
      employeeIds: [f.employeeAId, f.employeeBId],
      ...over,
      companyId: s.company,
      branchId: s.hq,
    }),
  );
/** The month the posting test posts, so no later January draft has a posted run of its period to net against. */
const NOV = {
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: "2026-12-05",
  effectiveDate: "2026-11-30",
};

describe("calculatePayrollRun (§4.12.6, spec:2081)", () => {
  it("writes ONE document, ONE payroll_run and one line per component, scheme share and net pay", async () => {
    const r = await regularRun();
    expect(r.employeeCount).toBe(2);
    // Per employee: 1 earning + 1 employee share + 1 employer share + 1 net-pay account line = 4.
    expect(r.lineCount).toBe(8);
    expect(r.pinnedTables).toEqual([{ schemeId: f.schemeId, version: 1 }]);
    expect(r.gross.toString()).toBe("4000.0000");
    expect(r.net.toString()).toBe("3900.0000");

    const [head] = await db.admin<{ kind: string; period_start: string; pinned_tables: unknown }[]>`
      select kind, to_char(period_start, 'YYYY-MM-DD') as period_start, pinned_tables
        from app.payroll_run where document_id = ${r.documentId}`;
    expect(head!.kind).toBe("regular");
    expect(head!.period_start).toBe("2026-01-01");
    expect(head!.pinned_tables).toEqual([{ schemeId: f.schemeId, version: 1 }]);

    const [doc] = await db.admin<
      { status: string; number: string | null; series: string; posting_policy_id: string | null }[]
    >`
      select status::text as status, number::text as number, series, posting_policy_id
        from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("draft");
    expect(doc!.number).toBeNull(); // numbering happens at issue, in the posting service (§4.3.6)
    expect(doc!.series).toBe("PAY");
    expect(doc!.posting_policy_id).toBeNull(); // pinned by postDocument (§4.3.2 step 13), never here
  });

  it("every payroll line carries the employee's HOME branch in document_line.dimensions (amendment A3)", async () => {
    const r = await run();
    const rows = await db.admin<{ employee_id: string; branch: string }[]>`
      select pl.employee_id, dl.dimensions->>'BRANCH' as branch
        from app.document_line dl join app.payroll_line pl on pl.document_line_id = dl.id
       where dl.document_id = ${r.documentId}`;
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.branch).toBe(row.employee_id === f.employeeAId ? s.hq : f.branchB);
    }
  });

  it("a pinned line records the rate table it used, per line (SAH-013)", async () => {
    const r = await run();
    const rows = await db.admin<
      { rate_table_id: string | null; rate_table_version: number | null }[]
    >`
      select pl.rate_table_id, pl.rate_table_version
        from app.document_line dl join app.payroll_line pl on pl.document_line_id = dl.id
       where dl.document_id = ${r.documentId} and pl.scheme_id is not null`;
    expect(rows).toHaveLength(4); // two employees × two shares
    for (const row of rows) {
      expect(row.rate_table_id).toBe(f.rateTableId);
      expect(row.rate_table_version).toBe(1);
    }
  });

  it("the run POSTS through postDocument and the ledger balances (spec:2081, hazard 22)", async () => {
    const r = await run(NOV);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }),
    );
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      postDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId }),
    );

    const [sums] = await db.admin<{ d: string; c: string; n: number }[]>`
      select coalesce(sum(base_debit), 0)::text as d, coalesce(sum(base_credit), 0)::text as c,
             count(*)::int as n
        from app.ledger_entry where document_id = ${r.documentId}`;
    expect(sums!.d).toBe(sums!.c);
    expect(sums!.d).toBe("4200.0000"); // 2 × (2000 earning + 100 employer share)
    expect(sums!.n).toBe(10); // per employee: earning, employee share, employer share ×2, net pay
    const dims = await db.admin<{ code: string; n: number }[]>`
      select dt.code, count(*)::int as n from app.ledger_entry_dimension led
        join app.ledger_entry le on le.id = led.entry_id
        join app.dimension_type dt on dt.id = led.dimension_type_id
       where le.document_id = ${r.documentId}
       group by dt.code order by dt.code`;
    // Every one of the 10 ledger lines carries BOTH dimensions.
    expect(dims).toEqual([
      { code: "BRANCH", n: 10 },
      { code: "EMPLOYEE", n: 10 },
    ]);
    // The posted run pinned a policy, and the service never wrote it.
    const [doc] = await db.admin<{ posting_policy_id: string | null; status: string }[]>`
      select posting_policy_id, status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("posted");
    expect(doc!.posting_policy_id).not.toBeNull();

    // Year-to-date figures come from POSTED lines only (8C's employee_ytd supersedes this read).
    const ytd = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromPostedLines(tx, s.company, 2026, [f.employeeAId]),
    );
    expect(ytd[f.employeeAId]!["gross"]!.toString()).toBe("2000.0000");
    expect(ytd[f.employeeAId]!["net"]!.toString()).toBe("1950.0000");
    expect(ytd[f.employeeAId]!["EPF.employee"]!.toString()).toBe("50.0000");
    expect(ytd[f.employeeAId]!["EPF.employer"]!.toString()).toBe("100.0000");
  });

  it("a posted run's lines are frozen: the payroll_line draft-only guard refuses an edit", async () => {
    const [line] = await db.admin<{ document_line_id: string }[]>`
      select pl.document_line_id from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.document d on d.id = dl.document_id
       where d.status = 'posted' and d.company_id = ${s.company} limit 1`;
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx`update app.payroll_line set amount = 1 where document_line_id = ${line!.document_line_id}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("recalculatePayrollRun replaces a DRAFT run's lines, returns a submitted one to draft, refuses an approved one", async () => {
    const r = await run();
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId),
    );
    expect(again.documentId).toBe(r.documentId);
    expect(again.lineCount).toBe(8);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document_line where document_id = ${r.documentId}`;
    expect(n!.n).toBe(8); // replaced, not doubled

    // Bound to its company when the caller names one: another company's id is NOT FOUND, never recalculated.
    const elsewhere = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId, {
        companyId: "00000000-0000-7000-8000-000000000000",
      }),
    ).catch((error: unknown) => error);
    expect((elsewhere as PayrollRunError).code).toBe("ERR_NOT_FOUND");

    // 8B T11: a SUBMITTED run is returned to draft by the recalculation (spec:2081; recalculation.test.ts has the
    // event); an APPROVED one is refused.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId),
    );
    const [back] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(back!.status).toBe("draft");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s), { documentId: r.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, f.approver, (tx) =>
      transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        recalculatePayrollRun(tx, ctxOf(s), r.documentId),
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("an unverified table refuses the run and writes NOTHING (test 29)", async () => {
    // A verified table cannot be un-verified (`verified_by` is stamped and immutable), so the legal way to get an
    // unverified table covering the period is to LOAD one: version 2 opens 2026-01-01, is the highest covering
    // version, and is offered — unverified.
    const unverified = await seedRateTable(db, s, {
      schemeId: f.schemeId,
      version: 2,
      verified: false,
    });
    const [before] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where company_id = ${s.company}`;
    const refused = await run().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PayrollCalculationError);
    expect((refused as PayrollCalculationError).code).toBe("ERR_PAYROLL_RATE_TABLE_UNVERIFIED");
    expect((refused as PayrollCalculationError).detail).toContain("v2 is not verified");
    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where company_id = ${s.company}`;
    expect(after!.n).toBe(before!.n);
    // Move it out of the period rather than verifying it: an UNVERIFIED row is not frozen (8A), and the cases after
    // this one assert that a line pins version 1.
    await asSystem(
      (tx) =>
        tx`update app.statutory_rate_table set effective_from = '2027-01-01' where id = ${unverified}`,
    );
  });

  it("readPayrollRun returns every line with its pin, for the approval screen (spec:2087)", async () => {
    const r = await run();
    const detail = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, r.documentId),
    );
    expect(detail.status).toBe("draft");
    expect(detail.series).toBe("PAY");
    expect(detail.lines).toHaveLength(8);
    expect(detail.lines.every((l) => l.employeeNumber.startsWith("E-"))).toBe(true);
    expect(
      detail.lines.filter((l) => l.schemeId !== null).every((l) => l.rateTableVersion === 1),
    ).toBe(true);
    expect(detail.lines[0]!.amount).toEqual({ amount: "2000.0000", currency: "MYR" });
    expect(detail.lines.map((l) => l.overrideReason)).toEqual(Array(8).fill(null));
  });

  it("readPayrollRun lists everyone who changed compensation in the period (spec:2174 R3)", async () => {
    const r = await run();
    const detail = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, r.documentId),
    );
    // `payrollFixture` entered every compensation_line as `s.human`, effective inside the period.
    expect(detail.compensationChangedBy).toHaveLength(2);
    expect(new Set(detail.compensationChangedBy.map((c) => c.principalId))).toEqual(
      new Set([s.human]),
    );
    expect(detail.compensationChangedBy.map((c) => c.employeeNumber)).toEqual(["E-0001", "E-0002"]);

    // A change effective entirely AFTER the period is not this run's doing and is not listed.
    await asSystem(
      (tx) => tx`
        update app.compensation_line set effective_from = date '2099-01-01'
         where employee_id = ${f.employeeAId} and component_id = ${f.componentBasicId}`,
    );
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readPayrollRun(tx, r.documentId),
    );
    expect(after.compensationChangedBy.map((c) => c.employeeNumber)).toEqual(["E-0002"]);
    await asSystem(
      (tx) => tx`
        update app.compensation_line set effective_from = date '2026-01-01'
         where employee_id = ${f.employeeAId} and component_id = ${f.componentBasicId}`,
    );
  });

  it("a quantity-based component writes its QUANTITY onto the payroll line (§4.12.6, §2.9)", async () => {
    const unpaid = await seedPayComponent(db, s, {
      code: "UNPAID_LEAVE",
      kind: "deduction",
      quantityBased: true,
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
        values (${s.tenant}, ${f.employeeAId}, ${unpaid}, '2026-01-01', '100.0000', '3.000000')`,
    );

    const r = await run();
    expect(r.lineCount).toBe(9);
    expect(r.net.toString()).toBe("3600.0000"); // (2000 − 300 − 50) + (2000 − 50)
    const [line] = await db.admin<{ quantity: string | null; amount: string; line_no: number }[]>`
      select pl.quantity::text as quantity, pl.amount::text as amount, dl.line_no
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.component_id = ${unpaid}`;
    expect(line!.quantity).toBe("3.000000"); // the column's own scale, numeric(19,6) — and NOT null
    expect(line!.amount).toBe("300.0000"); // 100.0000 × 3, and NOT prorated
    expect(line!.line_no).toBe(2); // earnings, then deductions, then the scheme shares (fixed order, test 33)

    // A FIXED component on the same run keeps a null quantity.
    const [basic] = await db.admin<{ quantity: string | null }[]>`
      select pl.quantity::text as quantity from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.component_id = ${f.componentBasicId} limit 1`;
    expect(basic!.quantity).toBeNull();

    // Close it before the period, so the cases after this one still see eight lines.
    await asSystem(
      (tx) => tx`
        update app.compensation_line set effective_from = '2025-01-01', effective_to = '2025-12-31'
         where component_id = ${unpaid}`,
    );
  });

  it("gross and net are Money and never a number (§3.7.5)", async () => {
    const r = await run();
    expect(r.gross).toBeInstanceOf(Money);
    expect(r.gross.currency).toBe(MYR);
    expect(r.net.isNegative()).toBe(false);
  });

  it("refuses a malformed period, an empty run, and a preparer who cannot read compensation", async () => {
    const calc = (actor: string, over: Partial<typeof RUN> & { employeeIds?: string[] }) =>
      withTenant(db.rw, s.tenant, actor, (tx) =>
        calculatePayrollRun(tx, ctxOf(s, actor), {
          ...RUN,
          ...over,
          companyId: s.company,
          branchId: s.hq,
        }),
      );
    expect(await code(calc(s.human, { periodEnd: "2025-12-31" }))).toBe("ERR_VALIDATION_FAILED");
    expect(await code(calc(s.human, { periodStart: "2026-02-30" }))).toBe("ERR_VALIDATION_FAILED");
    // Nobody is employed in 2025 (both were hired 2026-01-01).
    expect(
      await code(
        calc(s.human, {
          periodStart: "2025-01-01",
          periodEnd: "2025-01-31",
          payDate: "2025-02-05",
          effectiveDate: "2026-01-31",
        }),
      ),
    ).toBe("ERR_VALIDATION_FAILED");
    // A named employee who is not employed in the period is refused, never silently dropped.
    expect(await code(calc(s.human, { kind: "final", employeeIds: [s.human] } as never))).toBe(
      "ERR_VALIDATION_FAILED",
    );
    const noComp = await secondApprover(db, s, ["hr.payroll.prepare"]);
    expect(await code(calc(noComp, {}))).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a final run names its employees and keeps them on recalculation", async () => {
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      calculatePayrollRun(tx, ctxOf(s), {
        ...RUN,
        kind: "final",
        companyId: s.company,
        branchId: s.hq,
        employeeIds: [f.employeeBId],
      }),
    );
    expect(r.employeeCount).toBe(1);
    const again = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      recalculatePayrollRun(tx, ctxOf(s), r.documentId),
    );
    expect(again.employeeCount).toBe(1);
    expect(again.lineCount).toBe(4);
  });
});

// Acceptance test 35 (spec:2453) — "`employee_ytd` rebuilt from opening rows plus posted lines matches the maintained
// projection row for row; recalculating a submitted run returns it to draft and voids the pending approval; a rate
// table can be verified only by a principal other than the one who loaded it." — and the re-run of test 2 (spec:2420,
// deterministic projections) over `employee_ytd`. 8C Task 9. Clause 2 is 8B's (Task 11) and clause 3 is 8A's; both are
// re-run here against the shipped system, not re-implemented. Figures are the synthetic SYNTH table's (hazard 1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The PRODUCTION withTenant (§4.2.2): root `tests/` never uses the 4-argument test helper.
import {
  calculatePayrollRun,
  checkEmployeeYtdProjection,
  listDocumentEvents,
  projectionChecks,
  recalculatePayrollRun,
  runIntegrityCheck,
  transitionDocument,
  upsertEmployeeYtdOpening,
  withTenant,
  ytdFromEmployeeYtd,
  type TenantContext,
} from "@dulja/db";
import { Money, currency } from "@dulja/domain";
import { seedTenantV2, startDb, type Db, type Seed } from "@dulja/db/test";
import { moneyOutFixture, type MoneyOutFixture } from "./support/payroll-money";
import { postPayrollRun } from "./support/payroll";

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
let schemeCode: string;
const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});
/** The compare as the job runs it: the tenant's system principal (hazard 20). */
const compare = () => withTenant(db.rw, ctx(s.system), (tx) => checkEmployeeYtdProjection(tx));

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 35");
  f = await moneyOutFixture(db, s); // January's run posted (pay date 2026-02-05)
  // A second posted run, so the compare folds more than one delta per (employee, year) — the case where a
  // hand-written jsonb aggregation would differ from the MERGE's at the first trailing zero (round 18 B6).
  await postPayrollRun(db, s, f, {
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    payDate: "2026-03-05",
    effectiveDate: "2026-02-28",
  });
  // The scheme's code is READ: payrollFixture seeds it as `EPF`; only the rate table is SYNTH.
  const [scheme] = await db.admin<{ code: string }[]>`
    select code from app.statutory_scheme where id = ${f.schemeId}`;
  schemeCode = scheme!.code;
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("acceptance test 35 — the employee_ytd rebuild (spec:2453) and the test-2 re-run (spec:2420)", () => {
  it("clause 1: the rebuild matches the maintained projection ROW FOR ROW, and an opening disturbs neither side (B14)", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.employee_ytd where company_id = ${s.company} and tax_year = 2026`;
    expect(rows[0]!.n).toBe(2); // two employees, one row each, both runs folded in
    expect(await compare()).toEqual([]);

    const before = await withTenant(db.rw, ctx(s.human), (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      upsertEmployeeYtdOpening(tx, ctx(s.human), {
        companyId: s.company,
        employeeId: f.employeeAId,
        year: 2026,
        gross: Money.of("500.0000", MYR),
        net: Money.of("450.0000", MYR),
        byComponent: { BASIC: "500.0000" },
        byScheme: { [schemeCode]: { employee: "25.0000", employer: "50.0000" } },
        source: "manual:test-35",
      }),
    );

    // (a) the compare is untouched by the opening — Σ posted deltas against Σ posted deltas, on both sides
    expect(await compare()).toEqual([]);
    // (b) the READ is opening + projection: spec:2453's "opening rows plus posted lines"
    const after = await withTenant(db.rw, ctx(s.human), (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]),
    );
    expect(after[f.employeeAId]!.gross!.toString()).toBe(
      before[f.employeeAId]!.gross!.add(Money.of("500.0000", MYR)).toString(),
    );
    expect(after[f.employeeAId]!.net!.toString()).toBe(
      before[f.employeeAId]!.net!.add(Money.of("450.0000", MYR)).toString(),
    );
  });

  it("test 2 re-run: the rebuild is deterministic — two runs return the same (empty) answer, and the registry holds it", async () => {
    expect(projectionChecks().map((c) => c.name)).toContain("employee_ytd");
    const report = await withTenant(db.rw, ctx(s.system), (tx) =>
      runIntegrityCheck(tx, ctx(s.system), { companyId: s.company }),
    );
    expect(report.projections.checked).toContain("employee_ytd");
    expect(report.projections.mismatches.filter((m) => m.projection === "employee_ytd")).toEqual(
      [],
    );
    expect(await compare()).toEqual(await compare());
  });

  it("a hand-corrupted gross IS reported, with the column and both values", async () => {
    await db.admin`
      update app.employee_ytd set gross = gross + 1
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    try {
      const mismatches = await compare();
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]).toMatchObject({
        projection: "employee_ytd",
        side: "amount_differs",
        key: { company_id: s.company, employee_id: f.employeeAId, tax_year: "2026" },
      });
      expect(mismatches[0]!.detail).toBe("gross 4001.0000 <> 4000.0000");
    } finally {
      await db.admin`
        update app.employee_ytd set gross = gross - 1
         where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    }
    expect(await compare()).toEqual([]);
  });

  it("a scale-only difference in a jsonb figure is reported — the compare is textual, never numeric (B6)", async () => {
    await db.admin`
      update app.employee_ytd set by_component = '{"BASIC": "4000.00"}'::jsonb
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    try {
      const mismatches = await compare();
      expect(mismatches.map((m) => m.detail)).toEqual([
        'by_component {"BASIC": "4000.00"} <> {"BASIC": "4000.0000"}',
      ]);
    } finally {
      await db.admin`
        update app.employee_ytd set by_component = '{"BASIC": "4000.0000"}'::jsonb
         where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    }
    expect(await compare()).toEqual([]);
  });

  it("a row the rebuild produces but the projection lacks is missing_in_projection, and a stray row missing_in_rebuild", async () => {
    const [gone] = await db.admin<{ gross: string }[]>`
      delete from app.employee_ytd where company_id = ${s.company} and employee_id = ${f.employeeBId}
      returning gross::text as gross`;
    expect(gone).toBeDefined();
    await db.admin`
      insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net)
      values (${s.tenant}, ${s.company}, ${f.employeeAId}, 2031, 1.0000, 1.0000)`;
    try {
      const mismatches = await compare();
      expect(mismatches.map((m) => [m.key["employee_id"], m.key["tax_year"], m.side])).toEqual(
        expect.arrayContaining([
          [f.employeeBId, "2026", "missing_in_projection"],
          [f.employeeAId, "2031", "missing_in_rebuild"],
        ]),
      );
      expect(mismatches).toHaveLength(2);
      // The payload's narrowing: year 2031 sees only the stray row, and another company sees nothing.
      const narrowed = await withTenant(db.rw, ctx(s.system), (tx) =>
        checkEmployeeYtdProjection(tx, { companyId: s.company, year: 2031 }),
      );
      expect(narrowed.map((m) => m.side)).toEqual(["missing_in_rebuild"]);
    } finally {
      await db.admin`
        delete from app.employee_ytd where company_id = ${s.company} and tax_year = 2031`;
      await db.admin`
        insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net,
                                      by_component, by_scheme)
        select ${s.tenant}, x.company_id, x.employee_id, x.tax_year,
               sum(x.gross), sum(x.net),
               app.jsonb_add_money_agg(x.by_component), app.jsonb_add_scheme_agg(x.by_scheme)
          from app.payroll_run r
          join app.document d on d.id = r.document_id and d.status = 'posted'
          cross join lateral app.employee_ytd_delta(r.document_id) x
         where r.company_id = ${s.company} and x.employee_id = ${f.employeeBId}
         group by x.company_id, x.employee_id, x.tax_year`;
    }
    expect(await compare()).toEqual([]);
  });

  it("clause 2 (8B's, re-run): recalculating a SUBMITTED run returns it to draft and voids the approval", async () => {
    const run = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company,
        kind: "regular",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        payDate: "2026-05-05",
        effectiveDate: "2026-04-30",
        branchId: s.hq,
      }),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: run.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      recalculatePayrollRun(tx, ctx(s.human), run.documentId),
    );
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${run.documentId}`;
    expect(doc!.status).toBe("draft");
    const events = await withTenant(db.rw, ctx(s.human), (tx) =>
      listDocumentEvents(tx, run.documentId),
    );
    expect(events.at(-1)).toMatchObject({
      fromStatus: "submitted",
      toStatus: "draft",
      reason: "recalculated",
    });
    // The pending approval is void: the approver cannot approve a draft (R1 needs a fresh submission).
    await expect(
      withTenant(db.rw, ctx(f.approver), (tx) =>
        transitionDocument(tx, ctx(f.approver), { documentId: run.documentId, to: "approved" }),
      ),
    ).rejects.toThrow();
    // A POSTED run is never recalculated; and a draft or submitted run contributes nothing to the projection.
    await expect(
      withTenant(db.rw, ctx(s.human), (tx) =>
        recalculatePayrollRun(tx, ctx(s.human), f.payrollDocumentId),
      ),
    ).rejects.toMatchObject({ code: "ERR_DOC_NOT_DRAFT" });
    expect(await compare()).toEqual([]);
  });

  it("clause 3 (8A's, re-run): the rate table the runs pinned was verified by a DIFFERENT principal", async () => {
    const [row] = await db.admin<{ loaded_by: string; verified_by: string | null }[]>`
      select loaded_by::text as loaded_by, verified_by::text as verified_by
        from app.statutory_rate_table where id = ${f.rateTableId}`;
    expect(row!.verified_by).not.toBeNull();
    expect(row!.verified_by).not.toBe(row!.loaded_by); // 8A's ERR_HR_SELF_VERIFY trigger, proven by data
  });
});

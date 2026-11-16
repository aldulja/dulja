import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calculatePayrollRun,
  postDocument,
  readPayrollRun,
  recalculatePayrollRun,
  setStatutoryOverride,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedRateTable,
  seedStatutoryScheme,
  seedTenantV2,
  startDb,
  type Db,
  type Seed,
} from "@dulja/db/test";
import {
  payrollFixture,
  postPayrollRun,
  SYNTH_TABLE,
  type PayrollFixture,
} from "./support/payroll";

// Review 2026-11-15, findings HRP-02, HRP-08, HRP-12 and HRP-15 (docs/review/findings/hr-payroll-importer.md on
// claude/review-hr-payroll-importer). Every figure is SYNTH's or invented (hazard 1). The cases share one tenant and
// each uses its own month, so their order matters only where a comment says so.

let db: Db;
let s: Seed;
let f: PayrollFixture;

const ctx = (actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const asHuman = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.rw, ctx(s.human), fn);
const month = (m: string, end: string, pay: string) => ({
  periodStart: `2026-${m}-01`,
  periodEnd: `2026-${m}-${end}`,
  payDate: pay,
  effectiveDate: `2026-${m}-${end}`,
});

async function draft(
  period: ReturnType<typeof month>,
  kind: "regular" | "supplementary",
  employeeIds?: string[],
): Promise<string> {
  const r = await asHuman((tx) =>
    calculatePayrollRun(tx, ctx(s.human), {
      companyId: s.company,
      kind,
      branchId: s.hq,
      ...period,
      ...(employeeIds === undefined ? {} : { employeeIds }),
    }),
  );
  return r.documentId;
}
const submit = (id: string) =>
  asHuman((tx) => transitionDocument(tx, ctx(s.human), { documentId: id, to: "submitted" }));
const approve = (id: string) =>
  withTenant(db.rw, ctx(f.approver), (tx) =>
    transitionDocument(tx, ctx(f.approver), { documentId: id, to: "approved" }),
  );
const post = (id: string) =>
  withTenant(db.rw, ctx(f.approver), (tx) => postDocument(tx, ctx(f.approver), { documentId: id }));
const statusOf = async (id: string) =>
  (
    await db.admin<
      { status: string }[]
    >`select status::text as status from app.document where id = ${id}`
  )[0]!.status;
const lastReason = async (id: string) =>
  (
    await db.admin<{ reason: string | null }[]>`
      select reason from app.document_event where document_id = ${id} order by created_at desc, id desc limit 1`
  )[0]!.reason;
const creditTo2400 = async (id: string) =>
  (
    await db.admin<{ credit: string | null }[]>`
      select sum(le.credit)::text as credit from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${id} and a.code = '2400'`
  )[0]!.credit;
const ytdOf = async (employeeId: string) =>
  (
    await db.admin<{ gross: string; net: string }[]>`
      select gross::text as gross, net::text as net from app.employee_ytd
       where employee_id = ${employeeId} and tax_year = 2026`
  )[0]!;
/** A new BASIC figure from `from`: the open line is closed the day before (one open line per component, 8A). */
const addBasic = (employeeId: string, from: string, amount: string) =>
  asHuman(async (tx) => {
    await tx`
      update app.compensation_line set effective_to = ${from}::date - 1
       where employee_id = ${employeeId} and component_id = ${f.componentBasicId} and effective_to is null`;
    await tx`
      insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
      values (${s.tenant}, ${employeeId}, ${f.componentBasicId}, ${from}::date, ${amount})`;
  });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Payroll corrections");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.read"] });
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("HRP-02 — a supplementary run carries only the delta against what the period already posted (ADR 0076)", () => {
  // Order matters inside this block: January's regular run is posted once and every case corrects it.
  const JAN = month("01", "31", "2026-02-05");

  it("a raise found after posting pays the difference once, and employee_ytd moves by the difference", async () => {
    await postPayrollRun(db, s, f, { ...JAN });
    expect(await ytdOf(f.employeeAId)).toEqual({ gross: "2000.0000", net: "1950.0000" });

    // A's January salary was 2500, not 2000. SYNTH's band 1000–5000 is 50/100 on both, so EPF does not move.
    await addBasic(f.employeeAId, "2026-01-15", "2500.0000");
    const supp = await draft(JAN, "supplementary", [f.employeeAId]);
    const lines = (await asHuman((tx) => readPayrollRun(tx, supp))).lines.map((l) => ({
      component: l.componentCode,
      scheme: l.schemeCode,
      share: l.share,
      amount: l.amount.amount,
    }));
    expect(lines).toEqual([
      { component: "BASIC", scheme: null, share: null, amount: "500.0000" },
      { component: null, scheme: null, share: null, amount: "500.0000" },
    ]);
    await submit(supp);
    await approve(supp);
    await post(supp);
    expect(await creditTo2400(supp)).toBe("500.0000");
    expect(await ytdOf(f.employeeAId)).toEqual({ gross: "2500.0000", net: "2450.0000" });
  });

  it("a supplementary run with nothing to correct is refused, never a second full payment", async () => {
    await expect(draft(JAN, "supplementary", [f.employeeBId])).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*nothing to correct/,
    );
  });

  it("an OVER-payment (a negative delta) is refused with a clear error until the owner settles recovery", async () => {
    await addBasic(f.employeeBId, "2026-01-20", "1500.0000");
    await expect(draft(JAN, "supplementary", [f.employeeBId])).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*BASIC.*-500\.0000.*negative correction/,
    );
  });

  it("an override on a supplementary run is the PERIOD's figure and survives a recalculation", async () => {
    // A's January: posted 2000 + 500 → EPF employee share 50 posted. The accountant's figure for the period is 60.
    await addBasic(f.employeeAId, "2026-01-25", "2600.0000");
    const supp = await draft(JAN, "supplementary", [f.employeeAId]);
    await asHuman((tx) =>
      setStatutoryOverride(tx, ctx(s.human), {
        documentId: supp,
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "60.0000", currency: "MYR" },
        reason: "accountant's figure",
      }),
    );
    const shareLine = async () =>
      (await asHuman((tx) => readPayrollRun(tx, supp))).lines.find(
        (l) => l.schemeCode === "EPF" && l.share === "employee",
      )!;
    expect((await shareLine()).amount.amount).toBe("10.0000"); // 60 − 50 posted
    await asHuman((tx) => recalculatePayrollRun(tx, ctx(s.human), supp));
    expect((await shareLine()).amount.amount).toBe("10.0000");
    expect((await shareLine()).overrideReason).toBe("accountant's figure");
  });
});

describe("HRP-02 — a supplementary run calculated before another run of its period posted cannot post", () => {
  it("the second of two drafts for the same correction is refused at post, naming the recalculation", async () => {
    const MAR = month("03", "31", "2026-04-05");
    const first = await draft(MAR, "supplementary", [f.employeeAId]);
    const second = await draft(MAR, "supplementary", [f.employeeAId]);
    for (const id of [first, second]) {
      await submit(id);
      await approve(id);
    }
    await post(first);
    await expect(post(second)).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: .*recalculate/);
    expect(await statusOf(second)).toBe("approved");
  });
});

describe("HRP-08 — one regular run per company and period", () => {
  it("a second regular run for a period that already has one is refused", async () => {
    const FEB = month("02", "28", "2026-03-05");
    await draft(FEB, "regular");
    await expect(draft(FEB, "regular")).rejects.toThrow(
      /ERR_VALIDATION_FAILED: .*regular payroll run .* already covers/,
    );
  });

  it("the database refuses it too, whoever writes the row", async () => {
    const APR = month("04", "30", "2026-05-05");
    await draft(APR, "regular");
    // A supplementary draft over an overlapping span, turned into a regular run by a direct write.
    const other = await draft(
      {
        periodStart: "2026-04-15",
        periodEnd: "2026-05-14",
        payDate: "2026-05-20",
        effectiveDate: "2026-04-30",
      },
      "supplementary",
      [f.employeeAId],
    );
    await expect(
      asHuman((tx) => tx`update app.payroll_run set kind = 'regular' where document_id = ${other}`),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED/);
  });
});

describe("HRP-12 — an employment or statutory-profile change returns a submitted or approved run to draft", () => {
  it("a statutory profile change effective in the period returns the run, with its reason", async () => {
    const MAY = month("05", "31", "2026-06-05");
    const id = await draft(MAY, "supplementary", [f.employeeAId]);
    await submit(id);
    await approve(id);
    await asHuman(
      (tx) => tx`
        insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, child_relief_count)
        values (${s.tenant}, ${f.employeeAId}, '2026-05-01', 2)`,
    );
    expect(await statusOf(id)).toBe("draft");
    expect(await lastReason(id)).toBe("statutory_profile_changed");
  });

  it("a termination date set inside the period returns the run, with its reason", async () => {
    const JUN = month("06", "30", "2026-07-05");
    const id = await draft(JUN, "supplementary", [f.employeeBId]);
    await submit(id);
    await asHuman(
      (tx) => tx`update app.employee set terminated_on = '2026-06-10' where id = ${f.employeeBId}`,
    );
    expect(await statusOf(id)).toBe("draft");
    expect(await lastReason(id)).toBe("employment_changed");
  });
});

describe("HRP-15 — an override can be recorded for a share the calculator computed as zero (spec:2087)", () => {
  it("the override creates the share's line when the scheme feeds the employee", async () => {
    // A synthetic schedule with a zero bracket (invented, hazard 1): A's salary falls in it, so no line is written.
    const zeroScheme = await seedStatutoryScheme(db, s, { code: "SYNTHZ" });
    await seedRateTable(db, s, {
      schemeId: zeroScheme,
      version: 1,
      verified: true,
      definition: {
        ...SYNTH_TABLE,
        scheme: "SYNTHZ",
        kind: "progressive_schedule",
        table: {
          brackets: [
            { from: "0", to: "9000", rate: "0", cumulative: "0" },
            { from: "9000", to: null, rate: "0.1", cumulative: "0" },
          ],
          reliefs: {},
        },
      },
    });
    await asHuman(
      (tx) => tx`
        insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
        values (${s.tenant}, ${f.componentBasicId}, ${zeroScheme})`,
    );
    const JUL = month("07", "31", "2026-08-05");
    const id = await draft(JUL, "supplementary", [f.employeeAId]);
    const zLines = async () =>
      (await asHuman((tx) => readPayrollRun(tx, id))).lines.filter(
        (l) => l.schemeCode === "SYNTHZ",
      );
    expect(await zLines()).toEqual([]);

    await asHuman((tx) =>
      setStatutoryOverride(tx, ctx(s.human), {
        documentId: id,
        employeeId: f.employeeAId,
        schemeId: zeroScheme,
        share: "employee",
        amount: { amount: "50.0000", currency: "MYR" },
        reason: "accountant's figure below threshold",
      }),
    );
    expect((await zLines()).map((l) => [l.share, l.amount.amount, l.overrideReason])).toEqual([
      ["employee", "50.0000", "accountant's figure below threshold"],
    ]);
  });

  it("but never for a scheme that does not feed the employee", async () => {
    const other = await seedStatutoryScheme(db, s, { code: "SYNTHN" });
    const JUL = month("07", "31", "2026-08-05");
    const id = await draft(JUL, "supplementary", [f.employeeAId]);
    await expect(
      asHuman((tx) =>
        setStatutoryOverride(tx, ctx(s.human), {
          documentId: id,
          employeeId: f.employeeAId,
          schemeId: other,
          share: "employee",
          amount: { amount: "5.0000", currency: "MYR" },
          reason: "x",
        }),
      ),
    ).rejects.toThrow(/no earning feeding that scheme/);
  });
});

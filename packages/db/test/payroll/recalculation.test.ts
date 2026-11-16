import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculatePayrollRun, readPayrollRun, recalculatePayrollRun } from "../../src/hr/run";
import { listOverrides, setStatutoryOverride } from "../../src/hr/override";
import { listDocumentEvents, postDocument, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { grantCodes, seedTenantV2, type Seed } from "../fixtures";
import {
  payrollFixture,
  secondApprover,
  type PayrollFixture,
} from "../../../../tests/invariants/support/payroll";

// 8B T11 — R3 (spec:2174, migration 0090), test 35's recalculation clause (spec:2081), the manual statutory override
// (spec:2087) and 0090's bounded "who changed compensation" lookup. Every figure is the synthetic SYNTH table's
// (§4.12.4): a base of 1000–5000 pays shares of 50.0000 and 100.0000 (hazard 1).

let db: Db;
let s: Seed;
let f: PayrollFixture;
const ctxOf = (seed: Seed, actor?: string) => ({
  tenantId: seed.tenant,
  actorId: actor ?? seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const RUN = {
  kind: "regular" as const,
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payDate: "2026-02-05",
  effectiveDate: "2026-01-31",
};
const asHuman = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, s.tenant, s.human, fn);
const as = <T>(actor: string, fn: (tx: Sql) => Promise<T>) =>
  withTenant(db.rw, s.tenant, actor, fn);
/** A throwaway draft. Migration 0128 admits one regular run per company and period (HRP-08) and these tests draft
 *  many, so each is a SUPPLEMENTARY run naming both employees — with nothing of its period posted, it carries exactly
 *  a regular run's lines (ADR 0076's amendment). `over` moves it to another period. */
const draftRun = (over: Partial<Omit<typeof RUN, "kind">> = {}) =>
  asHuman((tx) =>
    calculatePayrollRun(tx, ctxOf(s), {
      ...RUN,
      kind: "supplementary",
      employeeIds: [f.employeeAId, f.employeeBId],
      ...over,
      companyId: s.company,
      branchId: s.hq,
    }),
  );
const submit = (documentId: string) =>
  asHuman((tx) => transitionDocument(tx, ctxOf(s), { documentId, to: "submitted" }));
const approve = (documentId: string) =>
  as(f.approver, (tx) =>
    transitionDocument(tx, ctxOf(s, f.approver), { documentId, to: "approved" }),
  );
const statusOf = async (documentId: string) =>
  (
    await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${documentId}`
  )[0]!.status;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Recalc");
  f = await payrollFixture(db, s); // grants s.human hr.compensation.read
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.compensation.manage"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("R3 — a compensation change returns a submitted or approved run to draft (spec:2174, test 35)", () => {
  it("a change effective IN the period returns a SUBMITTED run to draft with reason compensation_changed", async () => {
    const r = await draftRun();
    await submit(r.documentId);

    // A raise from the 15th: the open line is closed and a new one opened (0083's one-open-line index), both in
    // one transaction — two R3 firings, one backward transition.
    await asHuman(async (tx) => {
      await tx`update app.compensation_line set effective_to = '2026-01-14'
                where employee_id = ${f.employeeAId} and component_id = ${f.componentBasicId}
                  and effective_to is null`;
      await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
               values (${s.tenant}, ${f.employeeAId}, ${f.componentBasicId}, '2026-01-15', '2500.0000')`;
    });

    expect(await statusOf(r.documentId)).toBe("draft");
    const events = await asHuman((tx) => listDocumentEvents(tx, r.documentId));
    const back = events.filter((e) => e.fromStatus === "submitted" && e.toStatus === "draft");
    expect(back).toHaveLength(1);
    expect(back[0]!.reason).toBe("compensation_changed");
    expect(back[0]!.actorId).toBe(s.human);
  });

  it("an APPROVED run is returned too, and the approval is void — R1 needs a fresh submission (spec:2081)", async () => {
    const r = await draftRun();
    await submit(r.documentId);
    await approve(r.documentId);

    await asHuman(
      (tx) => tx`update app.compensation_line set amount = '2600.0000'
                  where employee_id = ${f.employeeAId} and effective_from = '2026-01-15'`,
    );

    expect(await statusOf(r.documentId)).toBe("draft");
    const events = await asHuman((tx) => listDocumentEvents(tx, r.documentId));
    expect(events.at(-1)).toMatchObject({
      fromStatus: "approved",
      toStatus: "draft",
      reason: "compensation_changed",
    });
    // The old approval does not carry over: posting the draft is illegal, and approving needs a new submission.
    await expect(
      as(f.approver, (tx) =>
        transitionDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
  });

  it("a change effective OUTSIDE the period leaves the run alone", async () => {
    const r = await draftRun();
    await submit(r.documentId);
    await asHuman(
      (tx) => tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, effective_to, amount)
        values (${s.tenant}, ${f.employeeBId}, ${f.componentAdvanceId}, '2026-06-01', '2026-06-30', '10.0000')`,
    );
    expect(await statusOf(r.documentId)).toBe("submitted");
  });

  it("a change to ANOTHER employee leaves a run that employee is not on alone", async () => {
    const r = await asHuman((tx) =>
      calculatePayrollRun(tx, ctxOf(s), {
        ...RUN,
        kind: "supplementary",
        employeeIds: [f.employeeAId],
        companyId: s.company,
        branchId: s.hq,
      }),
    );
    await submit(r.documentId);
    await asHuman(
      (tx) => tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, effective_to, amount)
        values (${s.tenant}, ${f.employeeBId}, ${f.componentAdvanceId}, '2026-01-05', '2026-01-05', '1.0000')`,
    );
    expect(await statusOf(r.documentId)).toBe("submitted");
  });

  it("a POSTED run is NEVER touched — the change is picked up by the next supplementary run (spec:2174)", async () => {
    // Its own month: a posted January run would leave the January drafts below nothing to correct (ADR 0076).
    const r = await draftRun({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      payDate: "2026-12-05",
      effectiveDate: "2026-11-30",
    });
    await submit(r.documentId);
    await approve(r.documentId);
    await as(f.approver, (tx) =>
      postDocument(tx, ctxOf(s, f.approver), { documentId: r.documentId }),
    );

    await asHuman(
      (tx) => tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, effective_to, amount)
        values (${s.tenant}, ${f.employeeBId}, ${f.componentAdvanceId}, '2026-11-20', '2026-11-20', '2.0000')`,
    );
    expect(await statusOf(r.documentId)).toBe("posted");
  });
});

describe("test 35's recalculation clause — recalculating a submitted run returns it to draft (spec:2081)", () => {
  it("a SUBMITTED run is returned to draft with reason recalculated and needs a fresh submission", async () => {
    const r = await draftRun();
    await submit(r.documentId);
    await asHuman((tx) => recalculatePayrollRun(tx, ctxOf(s), r.documentId));

    expect(await statusOf(r.documentId)).toBe("draft");
    const events = await asHuman((tx) => listDocumentEvents(tx, r.documentId));
    expect(events.at(-1)).toMatchObject({
      fromStatus: "submitted",
      toStatus: "draft",
      reason: "recalculated",
    });
  });

  it("an APPROVED run is refused: it returns to draft only through R3 or a transition with a reason", async () => {
    const r = await draftRun();
    await submit(r.documentId);
    await approve(r.documentId);
    await expect(
      asHuman((tx) => recalculatePayrollRun(tx, ctxOf(s), r.documentId)),
    ).rejects.toMatchObject({ code: "ERR_DOC_NOT_DRAFT" });
    expect(await statusOf(r.documentId)).toBe("approved");
  });
});

describe("manual statutory override (spec:2087)", () => {
  it("an override replaces ONE employee's share, records reason + entered_by, and is LISTED for approval", async () => {
    const r = await draftRun();
    await asHuman((tx) =>
      setStatutoryOverride(tx, ctxOf(s), {
        documentId: r.documentId,
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "77.0000", currency: "MYR" },
        reason: "authority letter 2026-01-02",
      }),
    );

    // ONE row, not two: both employees are on the scheme and spec:2087's override is per employee.
    const overrides = await asHuman((tx) => listOverrides(tx, r.documentId));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      employeeId: f.employeeAId,
      employeeNumber: "E-0001",
      schemeCode: "EPF",
      share: "employee",
      amount: "77.0000",
      reason: "authority letter 2026-01-02",
      enteredBy: s.human,
    });

    const [line] = await db.admin<{ amount: string; entered_by: string }[]>`
      select pl.amount::text as amount, pl.entered_by::text as entered_by
        from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.employee_id = ${f.employeeAId} and pl.share = 'employee'`;
    expect(line!.amount).toBe("77.0000");
    expect(line!.entered_by).toBe(s.human); // stamped from the session, never from a payload (LEGACY-044)

    const [untouched] = await db.admin<{ amount: string; override_reason: string | null }[]>`
      select pl.amount::text as amount, pl.override_reason
        from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${r.documentId} and pl.employee_id = ${f.employeeBId} and pl.share = 'employee'`;
    expect(untouched!.override_reason).toBeNull();

    // The run the approver reads IS the run the override produced: A's net pay moved with it.
    const detail = await asHuman((tx) => readPayrollRun(tx, r.documentId));
    expect(detail.overrides).toHaveLength(1);
    expect(detail.overrides[0]!.amount).toEqual({ amount: "77.0000", currency: "MYR" });
    const netA = detail.lines.find(
      (l) => l.employeeId === f.employeeAId && l.schemeId === null && l.componentId === null,
    );
    // A's BASIC is 2600.0000 from the R3 cases above, so the net is 2600 − 77, not 2600 − 50.
    expect(netA!.amount.amount).toBe("2523.0000");
  });

  it("an override on a SUBMITTED run is refused — the approver approves what will post", async () => {
    const r = await draftRun();
    await submit(r.documentId);
    await expect(
      asHuman((tx) =>
        setStatutoryOverride(tx, ctxOf(s), {
          documentId: r.documentId,
          employeeId: f.employeeAId,
          schemeId: f.schemeId,
          share: "employee",
          amount: { amount: "1.0000", currency: "MYR" },
          reason: "too late",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("an override SURVIVES a recalculation — it is an input, not an output", async () => {
    const r = await draftRun();
    await asHuman((tx) =>
      setStatutoryOverride(tx, ctxOf(s), {
        documentId: r.documentId,
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "88.0000", currency: "MYR" },
        reason: "authority letter",
      }),
    );
    await asHuman((tx) => recalculatePayrollRun(tx, ctxOf(s), r.documentId));
    const overrides = await asHuman((tx) => listOverrides(tx, r.documentId));
    expect(overrides.map((o) => o.amount)).toEqual(["88.0000"]);
    expect(overrides.map((o) => o.employeeId)).toEqual([f.employeeAId]);
  });

  it("a second override REPLACES the first, and a different principal may enter it (no ERR_ACTOR_IMMUTABLE)", async () => {
    const r = await draftRun();
    const second = await secondApprover(db, s, ["hr.payroll.prepare", "hr.compensation.read"]);
    const entry = (amount: string, reason: string) => ({
      documentId: r.documentId,
      employeeId: f.employeeAId,
      schemeId: f.schemeId,
      share: "employer" as const,
      amount: { amount, currency: "MYR" },
      reason,
    });
    await asHuman((tx) => setStatutoryOverride(tx, ctxOf(s), entry("120.0000", "first letter")));
    await as(second, (tx) =>
      setStatutoryOverride(tx, ctxOf(s, second), entry("130.0000", "second letter")),
    );
    const overrides = await asHuman((tx) => listOverrides(tx, r.documentId));
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      share: "employer",
      amount: "130.0000",
      reason: "second letter",
      enteredBy: second,
    });
  });

  it("refuses a share the calculation never produced, a foreign currency, a negative figure and a blank reason", async () => {
    const r = await draftRun();
    const base = {
      documentId: r.documentId,
      employeeId: f.employeeAId,
      schemeId: f.schemeId,
      share: "employee" as const,
      amount: { amount: "1.0000", currency: "MYR" },
      reason: "letter",
    };
    const refused = (input: typeof base) =>
      asHuman((tx) => setStatutoryOverride(tx, ctxOf(s), input)).then(
        () => "resolved",
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(await refused({ ...base, schemeId: f.componentBasicId })).toBe("ERR_VALIDATION_FAILED");
    expect(await refused({ ...base, amount: { amount: "1.0000", currency: "USD" } })).toBe(
      "ERR_VALIDATION_FAILED",
    );
    expect(await refused({ ...base, amount: { amount: "-1.0000", currency: "MYR" } })).toBe(
      "ERR_VALIDATION_FAILED",
    );
    expect(await refused({ ...base, reason: "   " })).toBe("ERR_VALIDATION_FAILED");
    // …and a run of another company is not found under the route's company scope.
    expect(
      await asHuman((tx) =>
        setStatutoryOverride(tx, ctxOf(s), base, {
          companyId: "00000000-0000-7000-8000-000000000001",
        }),
      ).then(
        () => "resolved",
        (e: unknown) => (e as { code?: string }).code,
      ),
    ).toBe("ERR_NOT_FOUND");
    expect(await asHuman((tx) => listOverrides(tx, r.documentId))).toEqual([]);
  });
});

describe("0090's bounded lookup — the approver sees WHO changed compensation, never how much (spec:2174)", () => {
  it("an approver without hr.compensation.read reads the list; the rows themselves stay hidden", async () => {
    const r = await draftRun();
    // The approver holds hr.payroll.read (and approve, post) — NOT hr.compensation.read.
    const direct = await as(f.approver, (tx) => tx`select id from app.compensation_line`);
    expect(direct).toHaveLength(0); // compensation_gate still binds app_rw (test 32)

    const detail = await as(f.approver, (tx) => readPayrollRun(tx, r.documentId));
    expect(detail.compensationChangedBy.length).toBeGreaterThan(0);
    expect(new Set(detail.compensationChangedBy.map((c) => c.principalId))).toEqual(
      new Set([s.human]),
    );
    expect(detail.compensationChangedBy.map((c) => c.effectiveFrom)).toContain("2026-01-15");
  });

  it("answers nothing to a principal holding neither hr.payroll.read nor hr.compensation.read", async () => {
    const stranger = await secondApprover(db, s, ["hr.payroll.prepare"]);
    const rows = await as(
      stranger,
      (tx) =>
        tx`select * from app.compensation_changes_in_period(${s.company}, '2026-01-01', '2026-12-31')`,
    );
    expect(rows).toHaveLength(0);
  });

  it("returns three columns and no figure, and is an app_auth-owned definer without BYPASSRLS", async () => {
    const cols = await as(
      f.approver,
      (tx) =>
        tx`select * from app.compensation_changes_in_period(${s.company}, '2026-01-01', '2026-12-31')`,
    );
    expect(cols.length).toBeGreaterThan(0);
    expect(Object.keys(cols[0]!).toSorted()).toEqual([
      "effective_from",
      "employee_id",
      "principal_id",
    ]);
    const [fn] = await db.admin<
      { owner: string; secdef: boolean; bypass: boolean; config: string[] }[]
    >`
      select r.rolname as owner, p.prosecdef as secdef, r.rolbypassrls as bypass, p.proconfig as config
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'app' and p.proname = 'compensation_changes_in_period'`;
    expect(fn).toEqual({
      owner: "app_auth",
      secdef: true,
      bypass: false,
      config: ["search_path=app, pg_temp"],
    });
    // app_auth may read the three facts and nothing else of a compensation line.
    const [grants] = await db.admin<{ amount: boolean; who: boolean }[]>`
      select has_column_privilege('app_auth', 'app.compensation_line', 'amount', 'select') as amount,
             has_column_privilege('app_auth', 'app.compensation_line', 'entered_by', 'select') as who`;
    expect(grants).toEqual({ amount: false, who: true });
  });

  it("is bound to the current tenant: another tenant's approver gets nothing for this company", async () => {
    const other = await seedTenantV2(db, "Recalc-B");
    await grantCodes(db, other, { codes: ["hr.payroll.read"] });
    const rows = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) =>
        tx`select * from app.compensation_changes_in_period(${s.company}, '2026-01-01', '2026-12-31')`,
    );
    expect(rows).toHaveLength(0);
  });
});

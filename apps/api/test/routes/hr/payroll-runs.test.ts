import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRateTable, seedTenantV2, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import {
  payrollFixture,
  secondApprover,
  type PayrollFixture,
} from "../../../../../tests/invariants/support/payroll";

// 8B T10 — the payroll-runs route module over HTTP. Figures come from the synthetic SYNTH table only (hazard 1).

let api: StartedApi;
let s: Seed;
let f: PayrollFixture;
let preparer: string;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "PayrollApi");
  f = await payrollFixture(api.db, s);
  // The seeded hr_payroll shape: prepare and read, plus 8A's compensation read the calculation needs.
  preparer = await secondApprover(api.db, s, [
    "hr.payroll.prepare",
    "hr.payroll.read",
    "hr.compensation.read",
  ]);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => {
  await api.stop();
});

const body = () => ({
  kind: "regular" as const,
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  payDate: "2026-02-05",
  effectiveDate: "2026-01-31",
  branchId: s.hq,
});
const path = () => `/v1/companies/${s.company}/payroll-runs`;
const create = (as: string, extra: Record<string, unknown> = {}) =>
  api.request({ method: "POST", path: path(), as, body: { ...body(), ...extra } });
/** Migration 0128 admits one regular run per company and period (HRP-08), so every case below that drafts a regular
 *  run of its own, beyond the first test's January, takes its own month of 2026. */
const inMonth = (m: number) => {
  const mm = String(m).padStart(2, "0");
  const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  return {
    periodStart: `2026-${mm}-01`,
    periodEnd: `2026-${mm}-${last}`,
    payDate: `2026-${mm}-${last}`,
    effectiveDate: `2026-${mm}-${last}`,
  };
};

describe("POST /v1/companies/{companyId}/payroll-runs", () => {
  it("a preparer creates a DRAFT run and gets every line back", async () => {
    const res = await create(preparer);
    expect(res.status).toBe(201);
    const run = (await res.json()) as {
      status: string;
      series: string;
      number: string | null;
      lines: { amount: { amount: string; currency: string }; rateTableVersion: number | null }[];
      pinnedTables: unknown[];
      compensationChangedBy: unknown[];
    };
    expect(run.status).toBe("draft");
    expect(run.series).toBe("PAY");
    expect(run.number).toBeNull();
    expect(run.lines).toHaveLength(8);
    expect(run.lines[0]!.amount).toEqual({ amount: "2000.0000", currency: "MYR" });
    expect(run.pinnedTables).toEqual([{ schemeId: f.schemeId, version: 1 }]);
    expect(run.compensationChangedBy).toHaveLength(2); // the fixture's two lines, both effective 2026-01-01
  });

  it("a principal with only hr.payroll.read is refused with ERR_RBAC_FORBIDDEN", async () => {
    const reader = await secondApprover(api.db, s, ["hr.payroll.read"]);
    await api.loadPrincipals();
    const res = await create(reader);
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a preparer who cannot read compensation is refused, naming the code, rather than paid nothing", async () => {
    const blind = await secondApprover(api.db, s, ["hr.payroll.prepare"]);
    await api.loadPrincipals();
    const res = await create(blind);
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.compensation.read");
  });

  it("the unsafe methods require Idempotency-Key (spec:2055)", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: preparer,
      body: body(),
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("validates the body: a regular run names no employee, dates are calendar dates and in order", async () => {
    for (const extra of [
      { employeeIds: [f.employeeAId] },
      { periodEnd: "2025-12-31" },
      { periodStart: "2026-02-30" },
      { payDate: "2025-12-01" },
      { surprise: true },
    ]) {
      const res = await create(preparer, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
    // A FINAL run may name its employees.
    const final = await create(preparer, { kind: "final", employeeIds: [f.employeeBId] });
    expect(final.status).toBe(201);
    expect(((await final.json()) as { lines: unknown[] }).lines).toHaveLength(4);
  });

  it("an unverified rate table answers 422 ERR_PAYROLL_RATE_TABLE_UNVERIFIED through the wire (test 29)", async () => {
    // LOADED, not un-verified: `verified_by` is stamped and immutable. Version 2 opens 2026-01-01 with an open end,
    // so it covers the run's period and is the highest covering version.
    const unverified = await seedRateTable(api.db, s, {
      schemeId: f.schemeId,
      version: 2,
      verified: false,
    });
    const res = await create(preparer);
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_PAYROLL_RATE_TABLE_UNVERIFIED");
    expect(problem.detail).toContain("is not verified");
    expect(problem.remedy).toContain("hr.statutory_table.verify");
    // An unverified row is not frozen (8A), so move it clear of the period for the cases below.
    await withTenant(
      api.db.migrator,
      s.tenant,
      s.system,
      (tx) =>
        tx`update app.statutory_rate_table set effective_from = '2027-01-01' where id = ${unverified}`,
    );
  });
});

describe("the run's lifecycle runs on 2B's GENERIC transitions route", () => {
  it("submit / approve / post — R2 at the middleware, then a different approver posts", async () => {
    const created = (await (await create(preparer, inMonth(2))).json()) as { documentId: string };
    const t = (to: string, as: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${created.documentId}/transitions`,
        as,
        body: { to },
      });
    expect((await t("submitted", preparer)).status).toBe(200);
    // R2: `preparer` holds prepare and read only, and §4.5.4's `requireDocumentPermission("approve")` resolves the
    // PAYROLL policy's `approval.approve` (hr.payroll.approve) per request.
    const selfApprove = await t("approved", preparer);
    expect(selfApprove.status).toBe(403);
    expect((await problemOf(selfApprove)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await t("approved", f.approver)).status).toBe(200);
    expect((await t("posted", f.approver)).status).toBe(200);

    const after = await api.request({
      method: "GET",
      path: `${path()}/${created.documentId}`,
      as: f.approver,
    });
    expect(after.status).toBe(200);
    const run = (await after.json()) as { status: string; number: string | null };
    expect(run.status).toBe("posted");
    expect(run.number).not.toBeNull(); // numbered at issue, inside the posting service (§4.3.6)

    // A posted run is not recalculated.
    const recalc = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/recalculate`,
      as: preparer,
    });
    expect(recalc.status).toBe(409);
    expect((await problemOf(recalc)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("R1 THROUGH THE WIRE: a maker holding prepare AND approve cannot approve its own run (spec:2172)", async () => {
    // Holding both codes clears §4.5.4's middleware, so the refusal can only come from 2B's
    // `app.document_status_before`, which checks R1 before R2. This case goes red if R1 is deleted.
    const maker = await secondApprover(api.db, s, [
      "hr.payroll.prepare",
      "hr.payroll.approve",
      "hr.payroll.read",
      "hr.compensation.read",
    ]);
    await api.loadPrincipals();
    const own = (await (await create(maker, inMonth(3))).json()) as { documentId: string };
    const t = (to: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${own.documentId}/transitions`,
        as: maker,
        body: { to },
      });
    expect((await t("submitted")).status).toBe(200);
    const makerApproves = await t("approved");
    expect(makerApproves.status).toBe(409);
    const problem = await problemOf(makerApproves);
    expect(problem.code).toBe("ERR_SOD_MAKER_IS_CHECKER"); // exactly this, never an alternation
    expect(problem.detail).toContain("cannot approve it");
  });
});

describe("recalculate, read and list", () => {
  it("recalculates a draft in place and returns the same document", async () => {
    const created = (await (await create(preparer, inMonth(4))).json()) as { documentId: string };
    const res = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/recalculate`,
      as: preparer,
    });
    expect(res.status).toBe(200);
    const run = (await res.json()) as { documentId: string; lines: unknown[]; status: string };
    expect(run.documentId).toBe(created.documentId);
    expect(run.status).toBe("draft");
    expect(run.lines).toHaveLength(8);
  });

  it("a submitted run is returned to draft by a recalculation (spec:2081)", async () => {
    const created = (await (await create(preparer, inMonth(5))).json()) as { documentId: string };
    const submitted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${created.documentId}/transitions`,
      as: preparer,
      body: { to: "submitted" },
    });
    expect(submitted.status).toBe(200);
    const res = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/recalculate`,
      as: preparer,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("draft");
  });

  it("POST …/overrides records ONE employee's share with its reason, flagged and listed (spec:2087, T11)", async () => {
    const created = (await (await create(preparer, inMonth(6))).json()) as { documentId: string };
    const res = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/overrides`,
      as: preparer,
      body: {
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "77.0000", currency: "MYR" },
        reason: "authority letter",
      },
    });
    expect(res.status).toBe(200);
    const run = (await res.json()) as {
      status: string;
      overrides: {
        employeeNumber: string;
        schemeCode: string;
        amount: unknown;
        enteredBy: string;
      }[];
      lines: { overrideReason: string | null; schemeCode: string | null }[];
    };
    expect(run.status).toBe("draft");
    expect(run.overrides).toHaveLength(1);
    expect(run.overrides[0]).toMatchObject({
      employeeNumber: "E-0001",
      schemeCode: "EPF",
      amount: { amount: "77.0000", currency: "MYR" },
      enteredBy: preparer, // the session's actor; the body has no actor member at all (SAH-044)
    });
    expect(run.lines.filter((l) => l.overrideReason !== null)).toHaveLength(1);

    // .strict(): an actor smuggled in the body is refused, not ignored.
    const smuggled = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/overrides`,
      as: preparer,
      body: {
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "1.0000", currency: "MYR" },
        reason: "x",
        enteredBy: f.approver,
      },
    });
    expect(smuggled.status).toBe(400);

    // A reader cannot enter one.
    const reader = await secondApprover(api.db, s, ["hr.payroll.read"]);
    await api.loadPrincipals();
    const refused = await api.request({
      method: "POST",
      path: `${path()}/${created.documentId}/overrides`,
      as: reader,
      body: {
        employeeId: f.employeeAId,
        schemeId: f.schemeId,
        share: "employee",
        amount: { amount: "1.0000", currency: "MYR" },
        reason: "x",
      },
    });
    expect(refused.status).toBe(403);
  });

  it("the approver reads who changed compensation in the period, without hr.compensation.read (0090)", async () => {
    const created = (await (
      await create(preparer, { kind: "supplementary", employeeIds: [f.employeeAId, f.employeeBId] })
    ).json()) as { documentId: string };
    const res = await api.request({
      method: "GET",
      path: `${path()}/${created.documentId}`,
      as: f.approver,
    });
    expect(res.status).toBe(200);
    const run = (await res.json()) as { compensationChangedBy: { employeeNumber: string }[] };
    expect(run.compensationChangedBy.map((c) => c.employeeNumber).toSorted()).toEqual([
      "E-0001",
      "E-0002",
    ]);
  });

  it("a run is bound to its path company: another company's id is 404, never another tenant's row", async () => {
    const created = (await (await create(preparer, inMonth(7))).json()) as { documentId: string };
    const unknown = await api.request({
      method: "GET",
      path: `${path()}/00000000-0000-7000-8000-000000000000`,
      as: preparer,
    });
    expect(unknown.status).toBe(404);
    expect((await problemOf(unknown)).code).toBe("ERR_NOT_FOUND");
    const own = await api.request({
      method: "GET",
      path: `${path()}/${created.documentId}`,
      as: preparer,
    });
    expect(own.status).toBe(200);
  });

  it("the list pages on (period_start, id), filters by literal filter[…] keys and refuses a flat parameter", async () => {
    const first = await api.request({
      method: "GET",
      path: `${path()}?limit=1&filter[kind][eq]=regular`,
      as: preparer,
    });
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: { documentId: string; kind: string; lines?: unknown }[];
      next_cursor: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.kind).toBe("regular");
    expect(page.items[0]!.lines).toBeUndefined(); // detail-only
    expect(page.next_cursor).not.toBeNull();
    const second = await api.request({
      method: "GET",
      path: `${path()}?limit=1&filter[kind][eq]=regular&cursor=${page.next_cursor!}`,
      as: preparer,
    });
    const next = (await second.json()) as { items: { documentId: string }[] };
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.documentId).not.toBe(page.items[0]!.documentId);

    const posted = await api.request({
      method: "GET",
      path: `${path()}?filter[status][eq]=posted`,
      as: preparer,
    });
    const postedItems = ((await posted.json()) as { items: { status: string }[] }).items;
    expect(postedItems.length).toBeGreaterThan(0);
    expect(postedItems.every((i) => i.status === "posted")).toBe(true);

    const bad = await api.request({ method: "GET", path: `${path()}?kind=regular`, as: preparer });
    expect(bad.status).toBe(400); // a flat parameter is refused, never silently ignored (§4.2.8)
    expect((await problemOf(bad)).code).toBe("ERR_VALIDATION_FAILED");
  });
});

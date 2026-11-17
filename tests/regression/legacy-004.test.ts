import { beforeAll, describe, expect, it } from "vitest";
import { checkEmployeeYtdProjection, projectionChecks, withTenant } from "@dulja/db";
import { seedTenantV2, type Db, type Seed } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { moneyOutFixture, type MoneyOutFixture } from "../invariants/support/payroll-money";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("004"); // ← this file's own LEGACY number

describe("LEGACY-004 Weighted-average cost advanced on INSERT only, with no rebuild path — 3B", () => {
  // first proven by spec:231, spec:1210
  it("cost is a function of the movements, so reversing the second purchase restores the first's cost", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "10.0000" },
      ],
    });
    const second = await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-20",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "20.0000" },
      ],
    });
    const mid = await ctx.valuation(db, s, "2026-01-31");
    expect(mid.unitCost).toBe("15.0000");

    await ctx.reverse(db, s, second.documentId, "2026-01-25");
    const after = await ctx.valuation(db, s, "2026-01-31");
    // The old system left 15.0000 here for ever. There is no running scalar to leave stale: the layers are
    // derived from an immutable, ordered movement ledger, and the reversal added movements.
    expect(after.quantity).toBe("100.000000");
    expect(after.unitCost).toBe("10.0000");
  });
});

describe("LEGACY-004 A derived figure advanced on INSERT only, with no rebuild path — 8C", () => {
  // first proven by spec:231; employee_ytd is Phase 8's instance of the shape (spec:2084, D14).
  let db: Db;
  let s: Seed;
  let f: MoneyOutFixture;
  const ytdCtx = () => ({
    tenantId: s.tenant,
    actorId: s.system,
    requestId: "00000000-0000-0000-0000-000000000000",
  });

  beforeAll(async () => {
    db = (await sharedDb()).db;
    s = await seedTenantV2(db, "LEGACY-004 8C"); // its own tenant: moneyOutFixture is not idempotent
    f = await moneyOutFixture(db, s);
  }, 240_000);

  it("employee_ytd HAS a rebuild path, and it is registered in the one registry the nightly job walks", () => {
    // The legacy system had no way to recompute a figure it had accumulated wrongly. Registration is what makes the
    // rebuild reachable from the nightly integrity job rather than from a hand-run script.
    expect(projectionChecks().map((c) => c.name)).toContain("employee_ytd");
  });

  it("the rebuild REPORTS a hand-corrupted row instead of carrying it forward", async () => {
    await db.admin`
      update app.employee_ytd set net = net + 7
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    const mismatches = await withTenant(db.rw, ytdCtx(), (tx) => checkEmployeeYtdProjection(tx));
    expect(mismatches.map((m) => m.detail)).toEqual(["net 1957.0000 <> 1950.0000"]);
    await db.admin`
      update app.employee_ytd set net = net - 7
       where company_id = ${s.company} and employee_id = ${f.employeeAId}`;
    expect(await withTenant(db.rw, ytdCtx(), (tx) => checkEmployeeYtdProjection(tx))).toEqual([]);
  });
});

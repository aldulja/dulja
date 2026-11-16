import { describe, expect, it } from "vitest";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";
import { withTenant } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import {
  CATALOGUE_7B,
  cachedReportFixture,
  readDefinition,
  readEnvelope,
  runDefinition,
} from "../invariants/support/reports";

const ctx = costingContext("015"); // ← this file's own SAH number

describe("SAH-015 A date window computed from a predicate that can never be satisfied — 3B", () => {
  // first proven by spec:347, spec:2039
  it("the as-of window is the ONE parameter, and it filters the same set the body sums", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-05-10",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000" },
      ],
    });
    // Before the receipt: no row at all — never a NULL average, never a blank figure with no error.
    expect(await ctx.valuationOrNone(db, s, "2026-04-30")).toBeUndefined();
    expect((await ctx.valuation(db, s, "2026-05-31")).unitCost).toBe("10.0000");
  });
});

describe("SAH-015 A date window computed from a predicate that can never be satisfied — 7B", () => {
  // The defect: a window built so that no row could ever satisfy it, and no error either — an empty report that
  // looked like an empty business. Every windowed definition in the 7B catalogue expresses its window as TWO
  // clauses on ONE field with TWO DISTINCT parameters, a lower bound and an upper one — the only shape that can
  // be satisfied and the only shape a reader can check. Asserted mechanically over all twenty-two.
  it("no definition builds a window from one parameter used twice, and every two-clause window is lower-then-upper", () => {
    for (const code of CATALOGUE_7B) {
      const d = readEnvelope(code).definition;
      const byField = new Map<string, { op: string; param: string }[]>();
      for (const c of d.dataset.filters) byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
      for (const [field, clauses] of byField) {
        const params = clauses.map((c) => c.param);
        expect(
          new Set(params).size,
          `${code}: ${field} has ${clauses.length} clauses and ${new Set(params).size} distinct parameters`,
        ).toBe(params.length);
        if (clauses.length === 2) {
          const ops = clauses.map((c) => c.op).toSorted();
          expect(
            ops[0] === "gte" && (ops[1] === "lt" || ops[1] === "lte"),
            `${code}: ${field} is windowed by ${ops.join(" and ")}`,
          ).toBe(true);
        }
        expect(clauses.length, `${code}: ${field}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("a reversed window returns no rows and raises nothing — an empty answer, not an error", async () => {
    const { db } = await sharedDb();
    const f = await cachedReportFixture(db, "sah015-7b");
    const rows = await withTenant(f.db.rw, f.s.tenant, f.reader, (tx) =>
      runDefinition(tx, readDefinition("accounting.general_ledger"), {
        companyId: f.s.company,
        fromDate: "2026-01-31",
        toDate: "2026-01-01",
        accountId: null,
        branchId: null,
      }),
    );
    expect(rows).toEqual([]);
    // …and the same window the right way round is NOT empty, so the empty answer above is the window's.
    const forward = await withTenant(f.db.rw, f.s.tenant, f.reader, (tx) =>
      runDefinition(tx, readDefinition("accounting.general_ledger"), {
        companyId: f.s.company,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        accountId: null,
        branchId: null,
      }),
    );
    expect(forward.length).toBeGreaterThan(0);
  });
});

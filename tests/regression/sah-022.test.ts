import { describe, expect, it } from "vitest";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("022"); // ← this file's own SAH number

describe("SAH-022 A singleton SELECT that omitted a key column and raised -811 — 3B", () => {
  // first proven by spec:412
  it("every costing read is keyed on its full primary key, and two rows are two rows", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const second = await ctx.secondWarehouse(db, s);
    const jobs = recordingJobs();
    for (const w of [warehouse, second]) {
      await postInventoryDocument(db, s, {
        documentTypeId: receipt,
        warehouseId: w,
        jobs,
        effectiveDate: "2026-01-10",
        lines: [{ itemId: item, warehouseId: w, quantity: "1.000000", unitPrice: "7.0000" }],
      });
    }
    // One item in two warehouses is TWO valuation rows, never a -811 and never a silent first-of-many.
    const rows = await ctx.valuationRows(db, s, "2026-01-31");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.warehouseId)).size).toBe(2);
  });
});

// 9B Task 15 — ⚠️ OD-27, Part VII #7 ("Does MatOpens.Job ever differ from 0 in production? SAH-022 is a hard failure
// if so, and inert if not."), asked of the customer's own data at load time. A job-partitioned legacy opening stock is
// refused rather than merged; the one-argument `loadFromCorpus` seeds a tenant of its own (contracts §4.17.1).
import { loadFromCorpus } from "../invariants/support/cut-over";
import { sliceRegression } from "../support/regression";
sliceRegression(
  "SAH-022",
  "A singleton SELECT that omitted a key column and raised -811",
  "9B",
  "refuses to load opening stock from a job-partitioned source rather than merging it, and loads normally when every Job is 0",
  async ({ expect: check }) => {
    await check(loadFromCorpus("matopens-partitioned")).rejects.toThrow(
      "ERR_IMPORT_SOURCE_UNREADABLE: MATOPENS.MOPJOB has 2 distinct non-zero values (for example 7, 9); the legacy opening stock is partitioned by job",
    );
    // The committed corpus has no MATOPENS: the question is inert, the load runs, and nothing is skipped for it.
    const skips = await loadFromCorpus("cut-over");
    check(skips.filter((k) => k.reason.includes("partitioned by job"))).toEqual([]);
  },
);

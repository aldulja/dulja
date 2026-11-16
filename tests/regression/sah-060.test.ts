import { describe, expect, it } from "vitest";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("060"); // ← this file's own SAH number

describe("SAH-060 A repair with two different sort orders that dropped columns it rebuilt — 3B", () => {
  // first proven by spec:718, spec:1204
  it("the rebuild writes every column of stock_valuation, and reading it twice gives one answer", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    // One receipt, so the rebuild has a pair to write. Without it `app.stock_valuation` stays empty and the
    // column assertion below would pass over `{}` — vacuously true, which is the one thing it must not be.
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs: recordingJobs(),
      effectiveDate: "2026-01-10",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "3.000000", unitPrice: "4.0000" }],
    });
    const first = await ctx.rebuild(db, s, "2026-01-31");
    const second = await ctx.rebuild(db, s, "2026-01-31");
    expect(second).toEqual(first);
    const [row] = await ctx.storedValuation(db, s, "2026-01-31");
    // Every non-key column is written by the rebuild — none is dropped from the insert list.
    expect(Object.keys(row ?? {}).toSorted()).toEqual(["quantity", "updated_at", "value"]);
  });
});

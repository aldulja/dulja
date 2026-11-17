import { describe, expect, it } from "vitest";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("006"); // ← this file's own LEGACY number

describe("LEGACY-006 An edit keyed on the OLD key desynchronised two aggregates for ever — 3B", () => {
  // first proven by spec:251, spec:1210
  it("there is no in-place aggregate maintenance to key wrongly — movements are append-only and signed", async () => {
    const { db } = await ctx.inventory();
    const [triggers] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'inventory_movement' and t.tgname = 'inventory_movement_immutable'`;
    expect(triggers!.n).toBe(1); // an UPDATE is refused outright, so there is no edit path to get wrong
  });
  it("re-pointing an item means reversing the document and posting a new one, which nets to zero", async () => {
    const { db, s, item, warehouse, receipt } = await ctx.inventory();
    const jobs = recordingJobs();
    const first = await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "100.000000", unitPrice: "10.0000" },
      ],
    });
    await ctx.reverse(db, s, first.documentId, "2026-01-11");
    // `valuationOrNone`, not `valuation`: absence IS the assertion here, and `valuation` throws on it.
    expect(await ctx.valuationOrNone(db, s, "2026-01-31")).toBeUndefined(); // 100 in, 100 out, nothing left
  });
});

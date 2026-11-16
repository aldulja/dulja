import { describe, expect, it } from "vitest";
import { costingContext } from "./support/costing";

const ctx = costingContext("010"); // ← this file's own LEGACY number

describe("LEGACY-010 A costing dimension in the SELECT list but not in the sort or the group break — 3B", () => {
  // first proven by spec:302, spec:1225
  it("the chronological key is all four columns, spelled out, in every costing ordering", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing", "packages/domain/src/costing"]);
    const orderings = files
      .flatMap((f) => f.text.split("\n").filter((l) => /order by/i.test(l)))
      // A CHRONOLOGICAL ordering is one that names any part of §4.3.5's key. The two costing files also
      // order a fiscal-period lookup by `starts_on`, the valuation page by item and warehouse code, and a
      // drift report by ordinal — none of those is the costing key, and demanding four columns of them
      // would assert something the defect never was. Naming ONE part of the key and not the rest is
      // precisely LEGACY-010 (a dimension in the SELECT list but not in the sort), so that is what is refused.
      .filter((l) => /effective_(date|at)|posting_seq|\bsequence\b|line_no|movement_no/.test(l))
      // …and a read of app.document_line is NOT one, however it is ordered. `line_no` is that table's own
      // natural order — it is the line's position on its document, not a costing dimension — so ordering a
      // document's lines by it is correct and complete. 3C put two such reads in landed-cost.ts (the
      // allocation basis and the item lines), which is where they belong; the filter above admitted them
      // only because `line_no` is also the third column of §4.3.5's key. Narrowed rather than relaxed: a
      // read of inventory_movement, cost_layer or cost_consumption still has to name all four columns —
      // and a line that names BOTH a costing table and document_line (a join) is still held to the key,
      // so the exemption cannot be borrowed by mentioning document_line beside the movement it orders.
      .filter(
        (l) =>
          !/app\.document_line/.test(l) || /inventory_movement|cost_layer|cost_consumption/.test(l),
      );
    expect(orderings.length).toBeGreaterThan(0);
    for (const line of orderings) {
      // Every ordering names a date, a sequence, a line and a movement — or it is not the costing key.
      expect(line).toMatch(/effective_(date|at).*(sequence|posting_seq).*line_no.*movement_no/);
    }
  });
  it("a layer's scope is (company, item, warehouse) in the read AND in the group, so the two cannot disagree", async () => {
    const { db, s, item, warehouse } = await ctx.inventory();
    const layers = await ctx.openLayers(db, s, item, warehouse);
    expect(layers.every((l) => l.itemId === item && l.warehouseId === warehouse)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { costingContext } from "./support/costing";

const ctx = costingContext("062"); // ← this file's own LEGACY number

describe("LEGACY-062 The watermark written at a group break pointed at another material's document — 3B", () => {
  // first proven by spec:724
  it("there is no watermark column to point at the wrong row", async () => {
    const { db } = await ctx.inventory();
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'cost_layer'`;
    expect(cols.map((c) => c.column_name)).not.toContain("master_document_id");
    // The resume point is derived from committed row state each run (ADR 0038), so a group break cannot
    // attribute it to the wrong item: it is a per-row invalidated_at, not a per-item scalar.
    expect(cols.map((c) => c.column_name)).toContain("invalidated_at");
  });
});

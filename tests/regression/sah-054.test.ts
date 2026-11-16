import { describe, expect, it } from "vitest";
import { MOVEMENTS_PER_BATCH } from "@dulja/db";
import { postInventoryDocument, recordingJobs } from "../invariants/support/post-inventory";
import { costingContext } from "./support/costing";

const ctx = costingContext("054"); // ← this file's own SAH number

describe("SAH-054 A full recost aborts on the first historical below-cost sale — 3B", () => {
  // first proven by spec:674, spec:1368
  it("the replay is many bounded transactions, and a below-cost historical sale does not abort it", async () => {
    const { db, s, item, warehouse, receipt, issueType } = await ctx.inventory();
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-10",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "10.0000" },
      ],
    });
    // Sold at 4.0000 — below what it will cost after the back-dated purchase lands. The old system raised
    // MatOvercost here, from an ENTRY-TIME guard applied to a system-generated correction, and lost the run.
    await postInventoryDocument(db, s, {
      documentTypeId: issueType,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-12",
      lines: [{ itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "4.0000" }],
    });
    await postInventoryDocument(db, s, {
      documentTypeId: receipt,
      warehouseId: warehouse,
      jobs,
      effectiveDate: "2026-01-05",
      lines: [
        { itemId: item, warehouseId: warehouse, quantity: "10.000000", unitPrice: "90.0000" },
      ],
    });
    const out = await ctx.runReplay(db, s);
    expect(out.movementsReplayed).toBeGreaterThan(0);
    expect(out.adjustmentsPosted).toHaveLength(1);
  });
  it("MOVEMENTS_PER_BATCH is finite, so no recost is one all-or-nothing transaction", () => {
    expect(MOVEMENTS_PER_BATCH).toBe(500);
  });
});

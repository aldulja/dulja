import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReportDefinition } from "@dulja/domain";
import { DATASET_READ_CODES, DATASET_ROW_BOUNDS } from "../../src/reports/datasets";
import { assertDefinitionFields, rowsForDefinition } from "../../src/reports/statement";
import { readDefinition } from "../../../../tests/invariants/support/reports";
import {
  arApReportFixture,
  type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import { startDb, withTenant, type Db } from "../harness";

/**
 * Phase 7 second review, finding 4 — `document` admits `inventory.stock.read` (7B's count register reads stock
 * counts under it), but a code gates a dataset, not a document type: a clone of `inventory.count_register` keeps
 * its gate and source (ADR 0065's rules) yet may override the `countTypes` options to `SALES_INVOICE` or
 * `PAYMENT`, and every stock reader then printed the company's financial documents. Under a module code the
 * dataset now carries a literal row bound — the inventory module's document types only.
 */
describe("a dataset read under a module's code is bounded to that module's rows (7 second review, finding 4)", () => {
  let db: Db;
  let f: ArApReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "row-bounds");
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  const shipped = readDefinition("inventory.count_register");
  /** The review's clone: same code family, same gate and source, the type options overridden. */
  const financialClone: ReportDefinition = {
    ...shipped,
    parameters: shipped.parameters.map((p) =>
      p.name === "countTypes" ? { ...p, options: ["SALES_INVOICE", "PAYMENT", "RECEIPT"] } : p,
    ) as ReportDefinition["parameters"],
  };
  const parameters = { fromDate: "2026-01-01", toDate: "2026-01-31", countTypes: "SALES_INVOICE" };
  const rows = (definition: ReportDefinition) =>
    withTenant(db.rw, f.s.tenant, f.reader, (tx) =>
      rowsForDefinition(tx, definition, { companyId: f.s.company, parameters }),
    );

  it("the clone is a valid definition — the gate and source rules alone do not stop it", () => {
    expect(financialClone.permission).toBe("inventory.stock.read");
    expect(() => assertDefinitionFields(financialClone)).not.toThrow();
  });

  it("under inventory.stock.read the clone reads no financial document", async () => {
    expect(await rows(financialClone)).toEqual([]);
    for (const type of ["PAYMENT", "RECEIPT"]) {
      const read = await withTenant(db.rw, f.s.tenant, f.reader, (tx) =>
        rowsForDefinition(tx, financialClone, {
          companyId: f.s.company,
          parameters: { ...parameters, countTypes: type },
        }),
      );
      expect(read, type).toEqual([]);
    }
  });

  it("under accounting.report.read the same definition still reads every type", async () => {
    const read = await rows({ ...financialClone, permission: "accounting.report.read" });
    expect(read.length).toBeGreaterThan(0);
    expect(read.every((r) => r["document_type_code"] === "SALES_INVOICE")).toBe(true);
    expect(read.map((r) => r["document_id"])).toContain(f.invoiceId);
  });

  it("every bound is declared for an admitted code of its dataset, and names no other", () => {
    for (const [dataset, bounds] of Object.entries(DATASET_ROW_BOUNDS)) {
      for (const code of Object.keys(bounds!)) {
        expect(DATASET_READ_CODES[dataset as keyof typeof DATASET_READ_CODES]).toContain(code);
      }
    }
    expect(Object.keys(DATASET_ROW_BOUNDS.document!)).toEqual(["inventory.stock.read"]);
  });
});

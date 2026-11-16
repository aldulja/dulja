import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { DUPLICATE_TARGETS } from "../src/reconcile/duplicate-aggregates";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("reconcile('duplicate_aggregates') — §5.1 #5, LEGACY-049", () => {
  it("finds a natural key that appears more than once in a keyless aggregate table", async () => {
    const report = await reconcile(await reader(), "duplicate_aggregates");
    expect(report.kind).toBe("duplicate_aggregates");
    expect(report.rows).toContainEqual({
      table: "MATOBJECTS",
      key: "5|1",
      naturalKey: "MATERIAL,WAREHOUSE",
      occurrences: 2,
      tableRows: 3,
      status: "duplicate",
      why: "MatObjects and MatQuantity have no key columns, and the non-atomic UPDATE-then-INSERT upsert duplicates under concurrency; every later posting then updates both rows (LEGACY-049).",
    });
  });

  it("reports each table's row count so a clean table is visibly clean, not merely absent", async () => {
    const report = await reconcile(await reader(), "duplicate_aggregates");
    expect(report.summary.duplicatedKeys).toBe("1");
    expect(report.summary.excessRows).toBe("1");
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "MATQUANTITY", tableRows: null, status: "source_absent" }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "ACCTOTALS", key: null, tableRows: 2, status: "clean" }),
    );
    expect(report.rows).toContainEqual(
      expect.objectContaining({ table: "ACCOBJECTS", key: null, tableRows: 1, status: "clean" }),
    );
    // Every target has at least one row; the summary's counters agree with the rows.
    for (const target of DUPLICATE_TARGETS)
      expect(report.rows.some((r) => r.table === target.table)).toBe(true);
    expect(report.summary.tables).toBe(String(DUPLICATE_TARGETS.length));
    expect(report.summary.clean).toBe("2");
    expect(report.summary.sourceAbsent).toBe("2");
  });

  it("orders duplicated keys numerically and counts the excess over the first row", async () => {
    const corpus = loadCorpus();
    const mat = corpus.tables.MATOBJECTS!;
    const grown = await createReader(
      new FixtureLegacyDriver({
        ...corpus,
        tables: {
          ...corpus.tables,
          MATOBJECTS: {
            ...mat,
            rows: [
              ...mat.rows,
              { MATERIAL: "10", WAREHOUSE: "1", QNT: "1.000000" },
              { MATERIAL: "10", WAREHOUSE: "1", QNT: "1.000000" },
              { MATERIAL: "10", WAREHOUSE: "1", QNT: "1.000000" },
            ],
          },
        },
      }),
    );
    const report = await reconcile(grown, "duplicate_aggregates");
    expect(
      report.rows.filter((r) => r.table === "MATOBJECTS").map((r) => [r.key, r.occurrences]),
    ).toEqual([
      ["5|1", 2],
      ["10|1", 3],
    ]);
    expect(report.summary.duplicatedKeys).toBe("2");
    expect(report.summary.excessRows).toBe("3");
  });
});

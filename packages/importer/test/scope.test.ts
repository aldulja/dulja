import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { ALL_LEGACY_TABLES } from "../src/legacy/modules";
import { scope } from "../src/scope";
import { loadCorpus } from "./support/corpus";

describe("scope — Part VII #1 and #2, §5.1 #10 'scope first, migrate second'", () => {
  it("counts every table, finds each one's date range, and names its module", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.engineVersion).toBe("WI-V2.5.9.27139 Firebird 2.5");
    expect(report.source).toBe("fixture corpus");
    // Named tables only (plan 9A correction C1): every task from 7 onward adds one to the base corpus.
    expect(report.totalRows).toBeGreaterThanOrEqual(9);
    const byTable = new Map(report.tables.map((t) => [t.table, t]));
    expect(byTable.get("ACCOUNTS")).toEqual({
      table: "ACCOUNTS",
      module: "standard",
      rows: 5,
      dateColumn: null,
      dateRange: null,
      note: null,
    });
    expect(byTable.get("VOUCHERS")).toEqual({
      table: "VOUCHERS",
      module: "standard",
      rows: 2,
      dateColumn: "DATE",
      dateRange: { min: "2024-01-15", max: "2024-03-02" },
      note: null,
    });
    expect(byTable.get("VOUITEMS")).toEqual({
      table: "VOUITEMS",
      module: "standard",
      rows: 4,
      dateColumn: null,
      dateRange: null,
      note: null,
    });
    expect(report.tables.map((t) => t.table)).toEqual(report.tables.map((t) => t.table).toSorted());
  });

  it("reports both directions of the difference against the shipped 460-table map", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.unexpectedTables).toEqual([]);
    // The shipped map minus the tables present and in it. Holds at every corpus size, and still fails if
    // `scope` double-counts or drops a table.
    expect(report.missingTables).toHaveLength(
      ALL_LEGACY_TABLES.size - report.tables.length + report.unexpectedTables.length,
    );
    expect(report.missingTables).toContain("PAYROLLS");

    const corpus = loadCorpus();
    const custom = new FixtureLegacyDriver({
      ...corpus,
      tables: {
        ...corpus.tables,
        ZZCUSTOM: {
          columns: [{ name: "ID", kind: "integer", scale: 0, nullable: false }],
          keyColumns: [],
          rows: [],
        },
      },
    });
    const widened = await scope(custom);
    expect(widened.unexpectedTables).toEqual(["ZZCUSTOM"]);
    expect(widened.tables.find((t) => t.table === "ZZCUSTOM")?.module).toBeNull();
  });

  it("records a table it cannot read rather than failing the whole run", async () => {
    const corpus = loadCorpus();
    const broken = new FixtureLegacyDriver({
      ...corpus,
      tables: { ...corpus.tables, BILLITEMS: { columns: [], keyColumns: [], rows: [] } },
    });
    const report = await scope(broken);
    const row = report.tables.find((t) => t.table === "BILLITEMS");
    expect(row?.rows).toBe(0);
    expect(row?.note).toBe("no columns declared");
    // The unreadable table adds nothing; every other table is still counted.
    expect(report.totalRows).toBe((await scope(new FixtureLegacyDriver(corpus))).totalRows);
  });

  it("is timestamped in UTC to the second, so two runs are comparable", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import * as barrel from "../src/index";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const driver = () => new FixtureLegacyDriver(loadCorpus());

describe("LegacyReader — contracts §4.13.1, the surface 9B consumes unchanged", () => {
  it("carries a non-empty firebirdVersion or refuses to exist", async () => {
    const reader = await createReader(driver());
    expect(reader.firebirdVersion).toBe("WI-V2.5.9.27139 Firebird 2.5");

    const silent = new FixtureLegacyDriver({ ...loadCorpus(), engineVersion: null });
    await expect(createReader(silent)).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: the engine did not report a version; supply one \(OD-17, ADR 0081\)/,
    );
    await expect(createReader(silent, "   ")).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
    expect((await createReader(silent, "Firebird 1.5.6")).firebirdVersion).toBe("Firebird 1.5.6");
  });

  it("counts and ranges by table", async () => {
    const reader = await createReader(driver());
    // By membership and order, not by an exact list (plan 9A correction C1): every task from 7 onward adds a
    // table to the base corpus, and an exact-array expectation here would turn "this task grew the fixture" into
    // "the driver broke". `tables()` promises the corpus's keys, sorted — that is what is asserted.
    const names = await reader.tables();
    expect(names).toEqual(names.toSorted());
    for (const table of ["ACCOUNTS", "VOUCHERS", "VOUITEMS"]) expect(names).toContain(table);
    expect(await reader.count("VOUITEMS")).toBe(4);
    expect(await reader.dateRange("VOUCHERS", "DATE")).toEqual({
      min: "2024-01-15",
      max: "2024-03-02",
    });
  });

  it("reads in batches, filtered by a typed predicate and never by SQL text", async () => {
    const reader = await createReader(driver());
    const seen: Record<string, string | boolean | null>[] = [];
    for await (const rows of reader.read<Record<string, string | boolean | null>>("VOUITEMS", {
      columns: ["ID", "ROW", "DEBIT"],
      where: { op: "eq", column: "ID", value: "2" },
      batch: 1,
    })) {
      expect(rows).toHaveLength(1);
      seen.push(...rows);
    }
    expect(seen).toEqual([
      { ID: "2", ROW: "1", DEBIT: "250.0000" },
      { ID: "2", ROW: "2", DEBIT: "250.0000" },
    ]);
  });

  it("refuses a batch size of zero rather than looping forever", async () => {
    const reader = await createReader(driver());
    const iterate = async () => {
      for await (const _ of reader.read("VOUITEMS", { columns: ["ID"], batch: 0 })) break;
    };
    await expect(iterate()).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: batch size 0 is not a positive integer/,
    );
  });
});

describe("the barrel — §4.13.1's cross-slice surface and §4.13.2's loader surface", () => {
  it("exports 9A's reader, drivers, reports and module map, 9B's loader framework, Task 4's master loaders, Task 5's opening, Task 6's opening stock, Task 7's open items, Task 8's employees and Task 10's cut-over reconciliation, by value", () => {
    expect(Object.keys(barrel).toSorted()).toEqual([
      "ACCOUNT_CODE_PATTERN",
      "ACCOUNT_MAP_TARGETS",
      "AGGREGATE_RULES",
      "ALL_LEGACY_TABLES",
      "DATE_COLUMN_CANDIDATES",
      "EMPLOYEE_MATCH_STRATEGIES",
      "EMPTY_TARGET",
      "FixtureLegacyDriver",
      "IMPORT_TARGET_ENV",
      "JOB_PARTITIONED_TABLES",
      "LEGACY_MODULES",
      "LoadError",
      "MPOS_SOURCE_TABLES",
      "OPENING_BRANCH_CODE",
      "OPENING_STOCK_LINES_PER_DOCUMENT",
      "OdbcLegacyDriver",
      "READ_BATCH",
      "RECONCILIATION_KINDS",
      "ReportWriter",
      "SENSITIVE_SOURCES",
      "SENSITIVE_TARGETS",
      "SENSITIVE_TEXT_LIMIT",
      "SUSPENSE_CODE",
      "TEMPLATE_GROUP_RULES",
      "accountLoader",
      "accountMap",
      "assertAccountMap",
      "assertImportTarget",
      "assertNoJobPartition",
      "assertYtdReconciles",
      "baseCurrency",
      "catalogueTemplates",
      "classifyTemplate",
      "clearAccountMap",
      "clearKeyRing",
      "codeFromName",
      "connectOdbc",
      "createReader",
      "cutOverDate",
      "dateOf",
      "draftAndPost",
      "employeeLoader",
      "employeeMapping",
      "employeeYtdOpeningLoader",
      "explain",
      "flagOf",
      "importTargetFromEnv",
      "itemLoader",
      "loadSource",
      "loadSourceFromEnv",
      "loaderFor",
      "loaders",
      "lotLoader",
      "moduleOf",
      "moneyOf",
      "mposLoader",
      "normaliseLegacyName",
      "openItemLoader",
      "openingBalanceLoader",
      "openingStockLoader",
      "optionalDateOf",
      "optionalText",
      "orderLoaders",
      "partyLoader",
      "payMoneyOf",
      "preflight",
      "profile",
      "quantityOf",
      "rationalOf",
      "readAccountMap",
      "reconcile",
      "reconcileCutOver",
      "redactDsn",
      "refResolver",
      "replayLegacyMovements",
      "requireText",
      "runLoad",
      "scope",
      "sensitiveOf",
      "setAccountMap",
      "setKeyRing",
      "setLoadSource",
      "sortLegacyMovements",
      "templateStem",
      "toCsv",
      "treatmentOf",
      "unitLoader",
      "warehouseLoader",
    ]);
  });
});

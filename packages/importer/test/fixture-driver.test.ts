import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver, readCorpus } from "../src/drivers/fixture";
import { ALL_LEGACY_TABLES, LEGACY_MODULES, moduleOf } from "../src/legacy/modules";
import { loadCorpus } from "./support/corpus";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("FixtureLegacyDriver — the local equivalent every task is developed against (OD-17 default)", () => {
  it("answers the catalogue questions from the committed corpus", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    expect(driver.kind).toBe("fixture");
    expect(await driver.engineVersion()).toBe("WI-V2.5.9.27139 Firebird 2.5");
    // By membership and order, not by an exact list (plan 9A correction C1): every task from 7 onward adds a
    // table to the base corpus, and an exact-array expectation here would turn "this task grew the fixture" into
    // "the driver broke". `tables()` promises the corpus's keys, sorted — that is what is asserted.
    const names = await driver.tables();
    expect(names).toEqual(names.toSorted());
    for (const table of ["ACCOUNTS", "VOUCHERS", "VOUITEMS"]) expect(names).toContain(table);
    expect(await driver.keyColumns("VOUITEMS")).toEqual(["SITE", "ID", "ROW"]);
    const columns = await driver.columns("VOUITEMS");
    expect(columns.find((c) => c.name === "DEBIT")).toEqual({
      name: "DEBIT",
      kind: "decimal",
      scale: 4,
      nullable: true,
    });
    expect(columns.find((c) => c.name === "ACCOUNT")).toEqual({
      name: "ACCOUNT",
      kind: "integer",
      scale: 0,
      nullable: true,
    });
  });

  it("counts, ranges and pages without ever producing a number for a money column", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    expect(await driver.count("VOUITEMS")).toBe(4);
    expect(await driver.minMax("VOUCHERS", "DATE")).toEqual({
      min: "2024-01-15",
      max: "2024-03-02",
    });

    const batches: string[][] = [];
    for await (const rows of driver.cursor(
      { table: "VOUITEMS", columns: ["ID", "DEBIT"], orderBy: ["SITE", "ID", "ROW"] },
      3,
    )) {
      batches.push(rows.map((r) => [String(r.ID), String(r.DEBIT)].join(":")));
      for (const row of rows) expect(typeof row.DEBIT).not.toBe("number");
    }
    expect(batches).toEqual([["1:100.0000", "1:0.0000", "2:250.0000"], ["2:250.0000"]]);
  });

  it("orders and ranges a numeric column by value, as Firebird does, not by its text", async () => {
    const corpus = loadCorpus();
    const accounts = corpus.tables.ACCOUNTS;
    if (!accounts) throw new Error("the base corpus lost ACCOUNTS");
    const driver = new FixtureLegacyDriver({
      ...corpus,
      tables: {
        ...corpus.tables,
        // Its own rows, not the base corpus's (9A T11 grew ACCOUNTS): "100" and "9" are what text order gets wrong.
        ACCOUNTS: {
          ...accounts,
          rows: ["10", "100", "9", "11"].map((ID) => ({ ...accounts.rows[0], ID })),
        },
      },
    });
    expect(await driver.minMax("ACCOUNTS", "ID")).toEqual({ min: "9", max: "100" });
    const ids: string[] = [];
    for await (const rows of driver.cursor(
      { table: "ACCOUNTS", columns: ["ID"], orderBy: ["ID"] },
      10,
    ))
      ids.push(...rows.map((r) => String(r.ID)));
    expect(ids).toEqual(["9", "10", "11", "100"]);
  });

  it("refuses a table or column it does not hold, naming it", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    await expect(driver.columns("PAYROLLS")).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: table PAYROLLS is not in the corpus/,
    );
    await expect(driver.minMax("VOUCHERS", "NOSUCH")).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: column VOUCHERS.NOSUCH is not in the corpus/,
    );
  });

  it("refuses a row file the catalogue does not declare", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-corpus-"));
    writeFileSync(join(dir, "catalog.json"), JSON.stringify({ engineVersion: null, tables: {} }));
    writeFileSync(join(dir, "BILLS.json"), "[]");
    expect(() => readCorpus(dir)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: BILLS has rows but no catalog entry/,
    );
  });
});

describe("LEGACY_MODULES — the 460-table map that answers Part VII #1", () => {
  it("covers the seventeen shipped databases and routes a table to its module", () => {
    expect(LEGACY_MODULES).toHaveLength(17);
    expect(moduleOf("VOUITEMS")?.id).toBe("standard");
    expect(moduleOf(" vouitems ")?.id).toBe("standard");
    expect(moduleOf("POSTICKETS")?.id).toBe("mpossystem");
    expect(moduleOf("PAYROLLS")?.id).toBe("salaries");
    expect(moduleOf("SPRORDERS")?.disposition).toBe("customisation");
    expect(moduleOf("NOSUCHTABLE")).toBeUndefined();
    // The dossier's own totals: 460 tables across the seventeen databases (analysis §4, Appendix A), and no
    // table in two modules — a duplicate would shrink the set below the sum of the lists.
    expect(ALL_LEGACY_TABLES.size).toBe(460);
    expect(LEGACY_MODULES.reduce((n, m) => n + m.tables.length, 0)).toBe(460);
    expect(Object.fromEntries(LEGACY_MODULES.map((m) => [m.database, m.tables.length]))).toEqual({
      Types: 1,
      System: 29,
      Standard: 107,
      mposStandard: 51,
      mposSystem: 18,
      Hospitals: 50,
      Academy: 44,
      Services: 38,
      Salaries: 36,
      Archives: 25,
      Payments: 22,
      Special: 11,
      FixedAssets: 10,
      Orders: 10,
      Additions: 3,
      Appointments: 3,
      tcbReports: 2,
    });
  });
});

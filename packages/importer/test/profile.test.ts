import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter, toCsv } from "../src/artefacts";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { profile } from "../src/profile";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const BOM = "﻿";

describe("profile — contracts §4.13.1 and Part VII #1", () => {
  it("returns the frozen shape: generatedAt, tables with optional ranges, modulesInUse", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(Object.keys(report).toSorted()).toEqual(["generatedAt", "modulesInUse", "tables"]);
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Named tables only (plan 9A correction C1, applied where the test is first written): every task from 7
    // onward adds one to the base corpus, and an exact-array expectation here would turn "this task grew the
    // fixture" into "the profiler broke".
    const byName = new Map(report.tables.map((t) => [t.name, t]));
    expect(byName.get("ACCOUNTS")).toEqual({ name: "ACCOUNTS", rows: 5 });
    expect(byName.get("VOUCHERS")).toEqual({
      name: "VOUCHERS",
      rows: 2,
      dateRange: { min: "2024-01-15", max: "2024-03-02" },
    });
    expect(byName.get("VOUITEMS")).toEqual({ name: "VOUITEMS", rows: 4 });
    expect(report.tables.map((t) => t.name)).toEqual(report.tables.map((t) => t.name).toSorted());
  });

  it("answers 'which modules are actually used' — a module is in use when any of its tables has a row", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.modulesInUse.standard).toBe(true);
    expect(report.modulesInUse.hospitals).toBe(false);
    expect(report.modulesInUse.academy).toBe(false);
    // EMPLOYEES (9A Task 11) is a Salaries table with rows.
    expect(report.modulesInUse.salaries).toBe(true);
    // Every one of the seventeen is answered, so an absent key can never be read as "unknown".
    expect(Object.keys(report.modulesInUse)).toHaveLength(17);
  });

  it("omits dateRange rather than reporting a null range for a table with no date column", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.tables.find((t) => t.name === "ACCOUNTS")).not.toHaveProperty("dateRange");
  });

  it("does not mark a module in use for a table that is present but empty", async () => {
    const corpus = loadCorpus();
    const withEmpty = new FixtureLegacyDriver({
      ...corpus,
      tables: {
        ...corpus.tables,
        // The base corpus's only Salaries table with rows (9A Task 11), emptied so PAYROLLS is the question.
        EMPLOYEES: { ...corpus.tables.EMPLOYEES!, rows: [] },
        PAYROLLS: {
          columns: [{ name: "ID", kind: "integer", scale: 0, nullable: false }],
          keyColumns: ["ID"],
          rows: [],
        },
      },
    });
    const report = await profile(await createReader(withEmpty));
    expect(report.tables.find((t) => t.name === "PAYROLLS")).toEqual({ name: "PAYROLLS", rows: 0 });
    expect(report.modulesInUse.salaries).toBe(false);
  });
});

describe("ReportWriter — ADR 0083", () => {
  it("writes JSON and CSV, hashes each artefact, and indexes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-9a-"));
    const writer = new ReportWriter(dir, {
      source: "fixture corpus",
      engineVersion: "Firebird 2.5",
    });
    writer.json("profile.json", { ok: true }, 1);
    writer.csv("drift.csv", [{ table: "ACCTOTALS", stored: "100.0000", recomputed: "90.0000" }]);
    const index = writer.finish();

    expect(index.artefacts.map((a) => a.name)).toEqual(["profile.json", "drift.csv", "index.json"]);
    expect(index.artefacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(index.artefacts[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // index.json lists itself with an empty digest: a file cannot carry the hash of its own final bytes.
    expect(index.artefacts[2]).toEqual({
      name: "index.json",
      kind: "json",
      rows: 2,
      bytes: 0,
      sha256: "",
    });
    expect(index.engineVersion).toBe("Firebird 2.5");
    expect(index.source).toBe("fixture corpus");
    expect(index.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(readFileSync(join(dir, "drift.csv"), "utf8")).toBe(
      [BOM, "table,stored,recomputed\r\nACCTOTALS,100.0000,90.0000\r\n"].join(""),
    );
    // The file on disk is the value `finish()` returned, not one entry short of it.
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).toEqual(index);
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).artefacts).toHaveLength(3);
    // Calling it twice yields the same index, not a growing one.
    expect(writer.finish()).toEqual(index);
  });

  it("hashes exactly the bytes written", async () => {
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "dulja-9a-"));
    const writer = new ReportWriter(dir, { source: "s", engineVersion: "v" });
    const entry = writer.bytes("t.report", Buffer.from([0xff, 0x00, 0x80]));
    const onDisk = readFileSync(join(dir, "t.report"));
    expect(entry).toEqual({
      name: "t.report",
      kind: "blob",
      rows: 1,
      bytes: 3,
      sha256: createHash("sha256").update(onDisk).digest("hex"),
    });
  });

  it("refuses an artefact name that would leave the output directory or overwrite the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-9a-"));
    const writer = new ReportWriter(dir, { source: "s", engineVersion: "v" });
    expect(() => writer.json("../escape.json", {}, 0)).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(() => writer.json("/tmp/abs.json", {}, 0)).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(() => writer.json("index.json", {}, 0)).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
  });

  it("escapes CSV per RFC 4180 so an Arabic name with a comma cannot shift a column", () => {
    expect(toCsv([{ name: 'محمد, "أحمد"', note: "line\nbreak" }])).toBe(
      [BOM, 'name,note\r\n"محمد, ""أحمد""","line\nbreak"\r\n'].join(""),
    );
  });

  it("neutralises a cell a spreadsheet would run as a formula, and leaves a signed figure a number", () => {
    expect(
      toCsv([{ name: "=HYPERLINK(1)", at: "@SUM(A1)", difference: "-50.0000", plus: "+1" }]),
    ).toBe([BOM, "name,at,difference,plus\r\n'=HYPERLINK(1),'@SUM(A1),-50.0000,+1\r\n"].join(""));
    expect(toCsv([{ v: "-1+cmd|' /C calc'!A0" }])).toBe(
      [BOM, "v\r\n'-1+cmd|' /C calc'!A0\r\n"].join(""),
    );
  });

  it("unions the headers of every row, in first-seen order, and writes a missing cell empty", () => {
    expect(toCsv([{ a: "1" }, { b: null, a: "2" }])).toBe([BOM, "a,b\r\n1,\r\n2,\r\n"].join(""));
    expect(toCsv([])).toBe(BOM);
  });
});

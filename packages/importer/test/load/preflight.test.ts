import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The registry before any loader module (9B T6's import-order note).
import { loaders } from "../../src/load/registry";
import { mposLoader } from "../../src/load/mpos";
import { FixtureLegacyDriver } from "../../src/drivers/fixture";
import { preflight } from "../../src/load/preflight";
import type { Loader, SourceColumn } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";

const columns: readonly SourceColumn[] = [
  {
    name: "UNTID",
    required: true,
    confidence: "hypothesis",
    note: "the unit's own key; the Units table's Prefix is UNT (dossier §3)",
  },
  { name: "UNTNAME", required: true, confidence: "hypothesis", note: "the unit's display name" },
  {
    name: "UNTNOTE",
    required: false,
    confidence: "hypothesis",
    note: "free text, carried to name_ar when present",
  },
];

const stub = (
  sourceTable: string,
  cols: readonly SourceColumn[],
  targetTable = "unit_of_measure",
): Loader<unknown, unknown> => ({
  sourceTable,
  targetTable,
  dependsOn: [],
  sourceColumns: cols,
  sourceKey: (r) => String((r as Record<string, string>)["UNTID"]),
  map: (r) => r,
  load: async () => ({ inserted: 0, skipped: 0, batchIds: [] }),
});

const driver = (): FixtureLegacyDriver => new FixtureLegacyDriver(loadCorpus("cut-over"));

const ABSENT = {
  column: "*",
  problem: "absent_table",
  required: true,
  confidence: "hypothesis",
  note: "the loader's source table is not in the catalogue",
} as const;

describe("pre-flight — the column map is data with a confidence, checked against the live catalogue (hazard 3)", () => {
  it("passes when every declared column exists", async () => {
    const report = await preflight(driver(), [stub("UNITS", columns)]);
    expect(report).toEqual({ ok: true, findings: [], checkedTables: ["UNITS"] });
  });

  it("fails on a missing REQUIRED column and names it, its loader and its note", async () => {
    const extra: SourceColumn[] = [
      ...columns,
      { name: "UNTFACTOR", required: true, confidence: "hypothesis", note: "conversion factor" },
    ];
    const report = await preflight(driver(), [stub("UNITS", extra)]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      {
        loader: "unit_of_measure",
        sourceTable: "UNITS",
        column: "UNTFACTOR",
        problem: "missing",
        required: true,
        confidence: "hypothesis",
        note: "conversion factor",
      },
    ]);
  });

  it("records a missing OPTIONAL column as a finding but stays ok — the loader simply has less to map", async () => {
    const extra: SourceColumn[] = [
      ...columns,
      { name: "UNTCOLOUR", required: false, confidence: "hypothesis", note: "unused" },
    ];
    const report = await preflight(driver(), [stub("UNITS", extra)]);
    expect(report.ok).toBe(true);
    expect(report.findings.map((f) => [f.column, f.required])).toEqual([["UNTCOLOUR", false]]);
  });

  it("matches a column name exactly — Firebird stores upper case, and a lower-case declaration is not a match", async () => {
    const lower: SourceColumn[] = [
      { name: "untid", required: true, confidence: "hypothesis", note: "the key, mis-cased" },
    ];
    const report = await preflight(driver(), [stub("UNITS", lower)]);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.column)).toEqual(["untid"]);
  });

  it("reports an absent TABLE once, not once per column", async () => {
    const report = await preflight(driver(), [stub("NOSUCHTABLE", columns)]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([
      { loader: "unit_of_measure", sourceTable: "NOSUCHTABLE", ...ABSENT },
    ]);
    expect(report.checkedTables).toEqual([]);
  });

  it("reports an absent table once when TWO loaders share it, naming the first in selected order", async () => {
    // Task 4's account and party loaders both read one legacy table, so a source missing it is a real shape.
    const report = await preflight(driver(), [
      stub("NOSUCHTABLE", columns, "account"),
      stub("NOSUCHTABLE", columns, "party"),
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([{ loader: "account", sourceTable: "NOSUCHTABLE", ...ABSENT }]);
    expect(report.checkedTables).toEqual([]);
  });

  it("checks a shared PRESENT table and lists it once, but reports each loader's own missing columns", async () => {
    const extra: SourceColumn[] = [
      ...columns,
      { name: "UNTFACTOR", required: false, confidence: "hypothesis", note: "party's column" },
    ];
    const report = await preflight(driver(), [
      stub("UNITS", columns, "account"),
      stub("UNITS", extra, "party"),
    ]);
    expect(report.ok).toBe(true);
    expect(report.checkedTables).toEqual(["UNITS"]);
    expect(report.findings.map((f) => [f.loader, f.column])).toEqual([["party", "UNTFACTOR"]]);
  });

  it("asks the catalogue, never the rows: a declared column of an empty table is still checked", async () => {
    const corpus = loadCorpus("cut-over");
    const empty = new FixtureLegacyDriver({
      ...corpus,
      tables: { UNITS: { ...corpus.tables["UNITS"]!, rows: [] } },
    });
    const extra: SourceColumn[] = [
      ...columns,
      { name: "UNTFACTOR", required: true, confidence: "hypothesis", note: "conversion factor" },
    ];
    const report = await preflight(empty, [stub("UNITS", extra)]);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.column)).toEqual(["UNTFACTOR"]);
  });
});

// 9B T14 — ⚠️ OD-17 (the live database). Hazard 3's ratchet: a column is `verified` only once a live catalogue has been
// read and the reading recorded in ADR 0084 by `TABLE.COLUMN` (docs/owner/od-17-live-database.md). With OD-17 open,
// every declared column is `hypothesis`, so the first case is vacuous today and load-bearing the moment one is promoted.
// The written-but-unregistered historical POS loader (T13) is held to the same rule: a yes to OD-16 registers it as is.
const declaredLoaders = (): readonly Loader<unknown, unknown>[] => [
  ...loaders,
  mposLoader as unknown as Loader<unknown, unknown>,
];
const ADR_0084 = fileURLToPath(
  new URL("../../../../docs/adr/0084-idempotent-loaders-keyed-on-import-batch.md", import.meta.url),
);

describe("column confidence — hazard 3's ratchet (OD-17, 9B T14)", () => {
  it("every declared column is either verified or hypothesis, and none is verified without an ADR 0084 line", () => {
    const declared = declaredLoaders().flatMap((l) =>
      l.sourceColumns.map((c) => ({ table: l.sourceTable, ...c })),
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.filter((c) => c.confidence !== "verified" && c.confidence !== "hypothesis"),
    ).toEqual([]);
    const adr = readFileSync(ADR_0084, "utf8");
    const unrecorded = declared
      .filter((c) => c.confidence === "verified")
      .map((c) => [c.table, c.name].join("."))
      .filter((pair) => !adr.includes(pair));
    expect(unrecorded).toEqual([]);
  });

  it("with OD-17 unanswered, no declared column is verified — no live catalogue has been read", () => {
    // Remove this case in the commit that records the live reading in ADR 0084 (docs/owner/od-17-live-database.md,
    // step 5): it is the gate's own pin, so a promotion without that commit fails here first.
    const verified = declaredLoaders().flatMap((l) =>
      l.sourceColumns
        .filter((c) => c.confidence === "verified")
        .map((c) => [l.sourceTable, c.name].join(".")),
    );
    expect(verified).toEqual([]);
  });

  it("every declared column carries a non-empty note — a column with no reason is a guess with a name", () => {
    const bare = declaredLoaders().flatMap((l) =>
      l.sourceColumns
        .filter((c) => c.note.trim() === "")
        .map((c) => [l.sourceTable, c.name].join(".")),
    );
    expect(bare).toEqual([]);
  });
});

// contracts §3.7.1's shape (9A's `odbc.test.ts` precedent): a suite that needs the owner's database is skipped, never
// failed, when `LEGACY_ODBC_DSN` is not set. It writes nothing and needs no Dulja database: pre-flight asks only the
// legacy catalogue. Run it as `docs/owner/od-17-live-database.md` step 2 says; its `confirmed:` lines are the list
// step 4 promotes, read from the customer's catalogue rather than from memory.
const LIVE_DSN = process.env["LEGACY_ODBC_DSN"];
describe.skipIf(!LIVE_DSN)("the registered loaders against the live catalogue (OD-17)", () => {
  it("passes pre-flight with zero required-column findings, and prints the columns it confirmed", async () => {
    const { connectOdbc } = await import("../../src/drivers/odbc");
    const live = await connectOdbc({ dsn: LIVE_DSN as string });
    try {
      const report = await preflight(live, loaders);
      for (const f of report.findings)
        console.log(
          [
            "finding:",
            [f.sourceTable, f.column].join("."),
            f.problem,
            f.required ? "required" : "optional",
          ].join(" "),
        );
      const missing = new Set(report.findings.map((f) => [f.sourceTable, f.column].join(".")));
      const confirmed = loaders
        .filter((l) => report.checkedTables.includes(l.sourceTable))
        .flatMap((l) => l.sourceColumns.map((c) => [l.sourceTable, c.name].join(".")))
        .filter((pair) => !missing.has(pair));
      for (const pair of [...new Set(confirmed)].toSorted())
        console.log(["confirmed:", pair].join(" "));
      expect(report.findings.filter((f) => f.required)).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      await live.close();
    }
  });
});

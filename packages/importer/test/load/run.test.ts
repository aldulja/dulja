import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { batchCounts, withTenant, type TenantContext } from "@dulja/db";
import { startDb, type Db, type Seed } from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { createReader } from "../../src/reader";
import { refResolver } from "../../src/load/refs";
import { loaders } from "../../src/load/registry";
import {
  baseCurrency,
  EMPTY_TARGET,
  loadSource,
  loadSourceFromEnv,
  READ_BATCH,
  runLoad,
  setLoadSource,
} from "../../src/load/run";
import { LoadError, type LoadContext, type Loader, type SkipRecord } from "../../src/load/types";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant } from "../support/tenant";

let db: Db;
const runs: string[] = [];

/** A fresh run id, remembered so its artefact directory is removed afterwards. */
function newRun(): string {
  const id = randomUUID();
  runs.push(id);
  return id;
}

function sourceOf(corpus: LegacyCorpus): () => Promise<{
  driver: FixtureLegacyDriver;
  reader: Awaited<ReturnType<typeof createReader>>;
  close: () => Promise<void>;
}> {
  return async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  };
}

function withRows(rows: readonly LegacyRow[]): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  return { ...corpus, tables: { UNITS: { ...corpus.tables["UNITS"]!, rows } } };
}

interface UnitTarget {
  code: string;
  nameEn: string;
  nameAr: string | null;
  currency: string;
}

interface UnitLoaderOptions {
  targetTable?: string;
  wholeTable?: boolean;
  /** Rows whose UNTID is listed are skipped by `map` with this reason. */
  skipInMap?: ReadonlySet<string>;
  /** The first row of each `load` call is answered as a C15 skip. */
  skipInLoad?: boolean;
  /** Answer one id short. */
  shortAnswer?: boolean;
}

/**
 * The framework's own loader (Task 4's real `unitLoader` is proven in `master.test.ts`). It writes a real table because `runLoad`
 * commits, and records how often `load` ran. It reads `baseCurrency()` inside `map` — the one place that proves a
 * map can mint money in the company's currency without a `LoadContext`.
 */
function unitLoader(options: UnitLoaderOptions = {}): {
  loader: Loader<LegacyRow, UnitTarget>;
  calls: number[];
} {
  const calls: number[] = [];
  const loader: Loader<LegacyRow, UnitTarget> = {
    sourceTable: "UNITS",
    targetTable: options.targetTable ?? "unit_of_measure",
    dependsOn: [],
    sourceColumns: [
      { name: "UNTID", required: true, confidence: "hypothesis", note: "the Units key" },
      { name: "UNTNAME", required: true, confidence: "hypothesis", note: "the unit's name" },
      { name: "UNTNOTE", required: false, confidence: "hypothesis", note: "the Arabic name" },
    ],
    ...(options.wholeTable ? { wholeTable: true } : {}),
    sourceKey: (row) => String(row["UNTID"]),
    async map(row, refs) {
      const id = String(row["UNTID"]);
      if (options.skipInMap?.has(id)) return { skip: `unit ${id} has no usable name` };
      // An unresolvable reference answers null, it never throws.
      expect(await refs.byLegacyRef("item", id)).toBeNull();
      return {
        code: `U${id}`,
        nameEn: String(row["UNTNAME"]),
        nameAr:
          row["UNTNOTE"] === null || row["UNTNOTE"] === undefined ? null : String(row["UNTNOTE"]),
        currency: baseCurrency(),
      };
    },
    async load(tx, ctx, rows) {
      calls.push(rows.length);
      const batchIds: string[] = [];
      const skips: SkipRecord[] = [];
      for (const [i, row] of rows.entries()) {
        if (options.skipInLoad && i === 0) {
          batchIds.push(EMPTY_TARGET);
          skips.push({
            loader: "unit_of_measure",
            sourceTable: "UNITS",
            sourceKey: row.code.slice(1),
            reason: "known only inside load (C15)",
          });
          continue;
        }
        const [made] = await tx<{ id: string }[]>`
          insert into app.unit_of_measure (tenant_id, company_id, code, name_en, name_ar)
          values (app.current_tenant(), ${ctx.companyId}, ${row.code}, ${row.nameEn}, ${row.nameAr})
          returning id`;
        batchIds.push(made!.id);
      }
      return {
        inserted: rows.length - skips.length,
        skipped: skips.length,
        batchIds: options.shortAnswer ? batchIds.slice(1) : batchIds,
        ...(skips.length > 0 ? { skips } : {}),
      };
    },
  };
  return { loader, calls };
}

/** Makes `list` the WHOLE registry for the duration of `fn` and always restores the registered loaders, so no case
 *  leaks a loader into another and Task 4's real loaders never run against the framework's UNITS-only cases. */
async function registered<T>(
  list: readonly Loader<LegacyRow, UnitTarget>[],
  fn: () => Promise<T>,
): Promise<T> {
  const saved = loaders.splice(0, loaders.length);
  loaders.push(...(list as unknown as Loader<unknown, unknown>[]));
  try {
    return await fn();
  } finally {
    loaders.splice(0, loaders.length, ...saved);
  }
}

async function tenant(name: string): Promise<Seed> {
  return seedLoadableTenant(db, name);
}

async function ctxFor(s: Seed, over: Partial<LoadContext> = {}): Promise<LoadContext> {
  return loadContextFor(db, s, over.runId ?? newRun(), over);
}

function human(s: Seed): TenantContext {
  return { tenantId: s.tenant, actorId: s.human, requestId: randomUUID() };
}

async function units(s: Seed): Promise<{ id: string; code: string; name_en: string }[]> {
  return withTenant(
    db.rw,
    human(s),
    (tx) =>
      tx<{ id: string; code: string; name_en: string }[]>`
      select id, code, name_en from app.unit_of_measure where company_id = ${s.company} order by code`,
  );
}

interface BatchRow {
  source_key: string;
  target_table: string;
  target_id: string;
  run_id: string;
  loaded_by: string;
}

async function batches(s: Seed): Promise<BatchRow[]> {
  return withTenant(
    db.rw,
    human(s),
    (tx) =>
      tx<BatchRow[]>`
      select source_key, target_table, target_id::text, run_id::text, loaded_by::text
        from app.import_batch where company_id = ${s.company} order by source_key`,
  );
}

function artefact(runId: string, name: string): string {
  return join("artefacts", "legacy", runId, name);
}

beforeAll(async () => {
  db = await startDb();
  setLoadSource(sourceOf(loadCorpus("cut-over")));
}, 180_000);

afterAll(async () => {
  setLoadSource(loadSourceFromEnv);
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("runLoad — contracts §4.13.2 and ADR 0084", () => {
  it("pages at 500 rows, and the empty target is the all-zero uuid", () => {
    expect(READ_BATCH).toBe(500);
    expect(EMPTY_TARGET).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("loads every row once, as the system principal, and records each key against the row it became", async () => {
    const s = await tenant("load-once");
    const { loader } = unitLoader();
    const ctx = await ctxFor(s);
    const report = await registered([loader], () => runLoad(db.rw, ctx));
    expect(report.perLoader).toEqual({
      unit_of_measure: { inserted: 3, skipped: 0, conflicts: 0 },
    });
    expect(report.skips).toEqual([]);
    expect(report.reconciliation).toEqual([]);

    const made = await units(s);
    expect(made.map((u) => [u.code, u.name_en])).toEqual([
      ["U1", "Piece"],
      ["U2", "Carton"],
      ["U3", "Kilogram"],
    ]);
    const byCode = new Map(made.map((u) => [u.code, u.id]));
    expect(await batches(s)).toEqual(
      ["1", "2", "3"].map((key) => ({
        source_key: key,
        target_table: "unit_of_measure",
        target_id: byCode.get(`U${key}`),
        run_id: ctx.runId,
        loaded_by: s.system,
      })),
    );
    // The §4.13.2 resolver answers what the load recorded, for this company only.
    const resolved = await registered([loader], () =>
      withTenant(db.rw, human(s), (tx) =>
        refResolver(tx, s.company).byLegacyRef("unit_of_measure", "2"),
      ),
    );
    expect(resolved).toBe(byCode.get("U2"));
    expect(
      await withTenant(db.rw, human(s), (tx) =>
        batchCounts(tx, { companyId: s.company, runId: ctx.runId }),
      ),
    ).toEqual([{ targetTable: "unit_of_measure", rows: 3 }]);
  });

  it("re-running the same load inserts nothing twice (SAH-049): every key is a silent skip, and map is not called", async () => {
    const s = await tenant("load-rerun");
    const { loader, calls } = unitLoader();
    const first = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    const second = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    expect(first.perLoader["unit_of_measure"]).toEqual({ inserted: 3, skipped: 0, conflicts: 0 });
    expect(second.perLoader["unit_of_measure"]).toEqual({ inserted: 0, skipped: 3, conflicts: 0 });
    expect(second.skips).toEqual([]);
    expect(calls).toEqual([3]);
    expect(await units(s)).toHaveLength(3);
    expect(await batches(s)).toHaveLength(3);
    // No committed row carries the all-zero target: every row of this corpus produced one.
    expect((await batches(s)).filter((b) => b.target_id === EMPTY_TARGET)).toEqual([]);
  });

  it("a dry run reads, checks and maps every row, reports what mapped, and writes nothing", async () => {
    const s = await tenant("load-dry");
    const { loader, calls } = unitLoader({ skipInMap: new Set(["2"]) });
    const report = await registered([loader], async () =>
      runLoad(db.rw, await ctxFor(s, { dryRun: true })),
    );
    expect(report.perLoader["unit_of_measure"]).toEqual({ inserted: 2, skipped: 1, conflicts: 0 });
    expect(report.skips.map((k) => k.sourceKey)).toEqual(["2"]);
    expect(calls).toEqual([]);
    expect(await units(s)).toEqual([]);
    expect(await batches(s)).toEqual([]);
  });

  it("refuses a changed source row for a key an earlier run mapped, naming the key, and writes nothing of that page", async () => {
    const s = await tenant("load-moved");
    const { loader } = unitLoader();
    await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    const before = await units(s);

    const moved = loadCorpus("cut-over").tables["UNITS"]!.rows.map((r) =>
      r["UNTID"] === "3" ? { ...r, UNTNAME: "Renamed after the freeze" } : r,
    );
    // A fourth, new row in the same page: it must not be written either, because the page refuses whole.
    setLoadSource(sourceOf(withRows([...moved, { UNTID: "4", UNTNAME: "Dozen", UNTNOTE: null }])));
    const runId = newRun();
    try {
      await expect(
        registered([loader], async () => runLoad(db.rw, await ctxFor(s, { runId }))),
      ).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/3 was loaded with different data on an earlier run/,
      );
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
    expect(await units(s)).toEqual(before);
    expect(await batches(s)).toHaveLength(3);
    const failed = JSON.parse(readFileSync(artefact(runId, "load-failed.json"), "utf8")) as {
      error: string;
      perLoader: Record<string, { conflicts: number }>;
    };
    expect(failed.error).toMatch(/^ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/3/);
    expect(failed.perLoader["unit_of_measure"]!.conflicts).toBe(1);
    expect(existsSync(artefact(runId, "index.json"))).toBe(true);
  });

  it("loads a key the source holds twice with identical data once, and reports the second sighting (SAH-049)", async () => {
    const s = await tenant("load-dup-same");
    const rows = loadCorpus("cut-over").tables["UNITS"]!.rows;
    setLoadSource(sourceOf(withRows([...rows, rows[0]!])));
    try {
      const { loader } = unitLoader();
      const report = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
      expect(report.perLoader["unit_of_measure"]).toEqual({
        inserted: 3,
        skipped: 1,
        conflicts: 0,
      });
      expect(report.skips).toEqual([
        {
          loader: "unit_of_measure",
          sourceTable: "UNITS",
          sourceKey: "1",
          reason:
            "the source holds this key twice with identical data; it was loaded once (SAH-049)",
        },
      ]);
      expect(await units(s)).toHaveLength(3);
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
  });

  it("refuses a key the source holds twice with different data, across a page boundary and in a dry run", async () => {
    const s = await tenant("load-dup-diff");
    const many = Array.from({ length: READ_BATCH }, (_, i) => ({
      UNTID: String(i + 1),
      UNTNAME: `Unit ${i + 1}`,
      UNTNOTE: null,
    }));
    setLoadSource(
      sourceOf(withRows([...many, { UNTID: "7", UNTNAME: "Not unit 7", UNTNOTE: null }])),
    );
    try {
      const { loader } = unitLoader();
      await expect(
        registered([loader], async () => runLoad(db.rw, await ctxFor(s, { dryRun: true }))),
      ).rejects.toThrow(
        /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/7 appears twice in the source with different data/,
      );
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
  });

  it("reports a map skip, records nothing for it, and reports it again on the next run (§5.1 #3)", async () => {
    const s = await tenant("load-map-skip");
    const { loader } = unitLoader({ skipInMap: new Set(["2"]) });
    const first = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    const second = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    const skip = {
      loader: "unit_of_measure",
      sourceTable: "UNITS",
      sourceKey: "2",
      reason: "unit 2 has no usable name",
    };
    expect(first.skips).toEqual([skip]);
    expect(first.perLoader["unit_of_measure"]).toEqual({ inserted: 2, skipped: 1, conflicts: 0 });
    expect(second.skips).toEqual([skip]);
    expect((await batches(s)).map((b) => b.source_key)).toEqual(["1", "3"]);
  });

  it("carries load's own skip reasons into the register (C15), and records their rows against the empty target", async () => {
    const s = await tenant("load-c15");
    const { loader } = unitLoader({ skipInLoad: true });
    const report = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    expect(report.perLoader["unit_of_measure"]).toEqual({ inserted: 2, skipped: 1, conflicts: 0 });
    expect(report.skips).toEqual([
      {
        loader: "unit_of_measure",
        sourceTable: "UNITS",
        sourceKey: "1",
        reason: "known only inside load (C15)",
      },
    ]);
    expect((await batches(s)).map((b) => [b.source_key, b.target_id === EMPTY_TARGET])).toEqual([
      ["1", true],
      ["2", false],
      ["3", false],
    ]);
  });

  it("calls a paged loader once per page and a whole-table loader once, in one transaction (C13)", async () => {
    const rows = Array.from({ length: READ_BATCH * 2 + 1 }, (_, i) => ({
      UNTID: String(i + 1),
      UNTNAME: `Unit ${i + 1}`,
      UNTNOTE: null,
    }));
    setLoadSource(sourceOf(withRows(rows)));
    try {
      const paged = unitLoader();
      await registered([paged.loader], async () =>
        runLoad(db.rw, await ctxFor(await tenant("load-paged"))),
      );
      expect(paged.calls).toEqual([500, 500, 1]);
      const whole = unitLoader({ wholeTable: true });
      const s = await tenant("load-whole");
      await registered([whole.loader], async () => runLoad(db.rw, await ctxFor(s)));
      expect(whole.calls).toEqual([1001]);
      expect(await units(s)).toHaveLength(1001);
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
  });

  it("refuses a load that answers the wrong number of target ids, and commits nothing of that page", async () => {
    const s = await tenant("load-short");
    const { loader } = unitLoader({ shortAnswer: true });
    await expect(registered([loader], async () => runLoad(db.rw, await ctxFor(s)))).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: unit_of_measure \(UNITS\): load returned 2 target ids for 3 mapped rows/,
    );
    expect(await units(s)).toEqual([]);
    expect(await batches(s)).toEqual([]);
  });

  it("refuses `only: pos_ticket` before opening any source: the historical POS loader is not registered (OD-16, 9B T13)", async () => {
    // The CLI's `load --only` and the job's `only` both reach `runLoad`, so this is the one refusal both see. The real
    // registry, untouched: `mposLoader` is exported and never in `loaders` (§2.12's default, start clean).
    const s = await tenant("load-only-mpos");
    let opened = false;
    setLoadSource(async () => {
      opened = true;
      return sourceOf(loadCorpus("cut-over"))();
    });
    try {
      await expect(runLoad(db.rw, await ctxFor(s, { only: ["pos_ticket"] }))).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: no loader targets pos_ticket; registered target tables are unit_of_measure, warehouse, account, party, employee, item, opening_balance, open_item, employee_ytd_opening, lot, opening_stock$/,
      );
      expect(opened).toBe(false);
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
  });

  it("restricts a run to `only`, and refuses a name no loader targets before opening the source (C14)", async () => {
    const s = await tenant("load-only");
    const a = unitLoader();
    const b = unitLoader({ targetTable: "unit_alias" });
    // Two loaders of one source table need disjoint keys; `only` runs just the first.
    const report = await registered([a.loader, b.loader], async () =>
      runLoad(db.rw, await ctxFor(s, { only: ["unit_of_measure"] })),
    );
    expect(Object.keys(report.perLoader)).toEqual(["unit_of_measure"]);
    expect(b.calls).toEqual([]);

    let opened = false;
    setLoadSource(async () => {
      opened = true;
      return sourceOf(loadCorpus("cut-over"))();
    });
    try {
      await expect(
        registered([a.loader], async () =>
          runLoad(db.rw, await ctxFor(s, { only: ["unit_of_measuer"] })),
        ),
      ).rejects.toThrow(
        /^ERR_VALIDATION_FAILED: no loader targets unit_of_measuer; registered target tables are unit_of_measure$/,
      );
      expect(opened).toBe(false);
    } finally {
      setLoadSource(sourceOf(loadCorpus("cut-over")));
    }
    // The second loader now runs and meets keys the first one mapped: a key belongs to one target.
    await expect(
      registered([a.loader, b.loader], async () =>
        runLoad(db.rw, await ctxFor(s, { only: ["unit_alias"] })),
      ),
    ).rejects.toThrow(
      /^ERR_IMPORT_DUPLICATE_SOURCE_KEY: UNITS\/1 is already mapped to unit_of_measure/,
    );
  });

  it("stops at pre-flight on a missing required column, before any row is read, and leaves the report", async () => {
    const s = await tenant("load-preflight");
    const { loader } = unitLoader();
    const wider: Loader<LegacyRow, UnitTarget> = {
      ...loader,
      sourceColumns: [
        ...loader.sourceColumns,
        { name: "UNTFACTOR", required: true, confidence: "hypothesis", note: "conversion factor" },
      ],
    };
    const runId = newRun();
    await expect(
      registered([wider], async () => runLoad(db.rw, await ctxFor(s, { runId }))),
    ).rejects.toThrow(
      /^ERR_IMPORT_SOURCE_UNREADABLE: pre-flight failed: the source has no UNITS\.UNTFACTOR\./,
    );
    expect(await units(s)).toEqual([]);
    const pre = JSON.parse(readFileSync(artefact(runId, "preflight.json"), "utf8")) as {
      ok: boolean;
    };
    expect(pre.ok).toBe(false);
  });

  it("reads a missing OPTIONAL column as NULL rather than failing the read", async () => {
    const s = await tenant("load-optional");
    const { loader } = unitLoader();
    const wider: Loader<LegacyRow, UnitTarget> = {
      ...loader,
      sourceColumns: [
        ...loader.sourceColumns,
        {
          name: "UNTCOLOUR",
          required: false,
          confidence: "hypothesis",
          note: "not in this source",
        },
      ],
    };
    const report = await registered([wider], async () => runLoad(db.rw, await ctxFor(s)));
    expect(report.perLoader["unit_of_measure"]!.inserted).toBe(3);
  });

  it("writes an artefact index whose entries carry their own sha256 (C9)", async () => {
    const s = await tenant("load-artefacts");
    const { loader } = unitLoader({ skipInMap: new Set(["3"]) });
    const report = await registered([loader], async () => runLoad(db.rw, await ctxFor(s)));
    const named = report.artefacts.artefacts.filter((a) => a.name !== "index.json");
    expect(named.map((a) => a.name)).toEqual([
      "preflight.json",
      "loader-unit_of_measure.json",
      "load-summary.json",
      "skips.csv",
    ]);
    expect(named.every((a) => /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect(report.artefacts.engineVersion).toBe("WI-V2.5.9.27139 Firebird 2.5");
  });

  it("refuses a context the operator mistyped before opening anything", async () => {
    const s = await tenant("load-context");
    await expect(runLoad(db.rw, await ctxFor(s, { cutOverDate: "2026-02-30" }))).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: cutOverDate 2026-02-30 is not a YYYY-MM-DD date/,
    );
    await expect(runLoad(db.rw, { ...(await ctxFor(s)), companyId: randomUUID() })).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: no company .* in this tenant$/,
    );
  });

  it("scopes the source and the base currency to the run: outside one, both refuse", async () => {
    expect(() => baseCurrency()).toThrow(
      /^ERR_VALIDATION_FAILED: baseCurrency\(\) was called outside a runLoad/,
    );
    expect(() => loadSource()).toThrow(
      /^ERR_IMPORT_SOURCE_UNREADABLE: loadSource\(\) was called outside a runLoad/,
    );
    const saved = process.env["LEGACY_ODBC_DSN"];
    delete process.env["LEGACY_ODBC_DSN"];
    try {
      await expect(
        loadSourceFromEnv({ tenantId: randomUUID(), companyId: randomUUID() }),
      ).rejects.toThrow(/^ERR_IMPORT_SOURCE_UNREADABLE: LEGACY_ODBC_DSN is not set/);
    } finally {
      if (saved !== undefined) process.env["LEGACY_ODBC_DSN"] = saved;
    }
  });

  it("carries every LoadError code as a field, never as an AppError (§3.1)", () => {
    const e = new LoadError("ERR_IMPORT_UNBALANCED_SOURCE", "voucher 17 is out by 3.0000");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("ERR_IMPORT_UNBALANCED_SOURCE");
    expect(e.detail).toBe("voucher 17 is out by 3.0000");
    expect(e.message).toBe("ERR_IMPORT_UNBALANCED_SOURCE: voucher 17 is out by 3.0000");
  });
});

describe("the CLI's load command — the operator's path to the same runLoad", () => {
  it("loads as the tenant's system principal from --fixture, and exits 1 when the run reported skips", async () => {
    const s = await tenant("load-cli");
    const { loader } = unitLoader({ skipInMap: new Set(["3"]) });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const saved = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = db.url("app_rw");
    try {
      const code = await registered([loader], () =>
        main([
          "load",
          "--fixture",
          "cut-over",
          "--tenant-id",
          s.tenant,
          "--company-id",
          s.company,
          "--cut-over-date",
          "2026-01-31",
          "--only",
          "unit_of_measure",
        ]),
      );
      const summary = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        runId: string;
        perLoader: Record<string, { inserted: number }>;
        skips: number;
      };
      runs.push(summary.runId);
      expect(code).toBe(1);
      expect(summary.perLoader["unit_of_measure"]!.inserted).toBe(2);
      expect(summary.skips).toBe(1);
      expect((await batches(s)).map((b) => [b.source_key, b.run_id, b.loaded_by])).toEqual([
        ["1", summary.runId, s.system],
        ["2", summary.runId, s.system],
      ]);
    } finally {
      log.mockRestore();
      setLoadSource(sourceOf(loadCorpus("cut-over")));
      if (saved === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = saved;
    }
  });
});

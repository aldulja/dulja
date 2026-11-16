import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { valuationAsOf, withTenant } from "@dulja/db";
import { startDb, type Db } from "@dulja/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import { createReader } from "../../src/reader";
import { readAccountMap } from "../../src/load/account-map";
import { clearAccountMap, setAccountMap } from "../../src/load/accounts";
import { loaders } from "../../src/load/registry";
import { runLoad, setLoadSource } from "../../src/load/run";
import { reconcileCutOver } from "../../src/load/reconcile-cut-over";
import { clearKeyRing, setKeyRing } from "../../src/load/employees";
import { loadCorpus } from "../support/corpus";
import { loadContextFor, seedLoadableTenant, TEST_KEY_RING } from "../support/tenant";

// The registry must be built before any loader module is imported on its own (9B T6's note).
void loaders;

let db: Db;
const runs: string[] = [];
const MAP = fileURLToPath(new URL("../fixtures/account-map.json", import.meta.url));

function newRun(): string {
  const id = randomUUID();
  runs.push(id);
  return id;
}

function useCorpus(corpus: LegacyCorpus): void {
  setLoadSource(async () => {
    const driver = new FixtureLegacyDriver(corpus);
    return { driver, reader: await createReader(driver), close: () => driver.close() };
  });
}

function withoutRows(table: string): LegacyCorpus {
  const corpus = loadCorpus("cut-over");
  return {
    ...corpus,
    tables: { ...corpus.tables, [table]: { ...corpus.tables[table]!, rows: [] } },
  };
}

beforeAll(async () => {
  db = await startDb();
  setAccountMap(readAccountMap(MAP));
  setKeyRing(TEST_KEY_RING);
}, 300_000);

afterAll(async () => {
  clearAccountMap();
  clearKeyRing();
  for (const id of runs) rmSync(join("artefacts", "legacy", id), { recursive: true, force: true });
  await db?.stop();
});

describe("an opening never runs ahead of its parents (2026-11-15 review, HRP-04)", () => {
  it("refuses only:[opening_stock] on a fresh company, records nothing, and the full run then opens the stock", async () => {
    const s = await seedLoadableTenant(db, `order-${randomUUID().slice(0, 8)}`);
    useCorpus(loadCorpus("cut-over"));
    await expect(
      runLoad(db.rw, await loadContextFor(db, s, newRun(), { only: ["opening_stock"] })),
    ).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: this run loads opening_stock without item, which has never been loaded into company .* although the source's MATERIALS has rows; .*an opening reported now is one-shot and final — run item first/,
    );
    const [batches] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.import_batch where company_id = ${s.company}`;
    expect(batches!.n).toBe(0);

    // A dry run writes nothing and is not refused.
    const dry = await runLoad(
      db.rw,
      await loadContextFor(db, s, newRun(), { only: ["opening_stock"], dryRun: true }),
    );
    expect(dry.perLoader["opening_stock"]).toBeDefined();

    const full = await runLoad(db.rw, await loadContextFor(db, s, newRun()));
    expect(full.perLoader["opening_stock"]!.inserted).toBeGreaterThan(0);
    const ctx = await loadContextFor(db, s, randomUUID());
    const valuation = await withTenant(db.rw, ctx, (tx) =>
      valuationAsOf(tx, { companyId: s.company, asOf: ctx.cutOverDate, cursor: null, limit: 100 }),
    );
    expect(valuation.length).toBeGreaterThan(0);
    const reader = await createReader(new FixtureLegacyDriver(loadCorpus("cut-over")));
    const rec = await withTenant(db.rw, ctx, (tx) => reconcileCutOver(tx, reader, ctx));
    expect(rec.unexplained).toEqual([]);
  }, 300_000);

  it("a parent whose source table is empty is not missing: only:[opening_stock] after a run that loaded no lot", async () => {
    const s = await seedLoadableTenant(db, `order-${randomUUID().slice(0, 8)}`);
    useCorpus(withoutRows("MATBATCHES"));
    await runLoad(
      db.rw,
      await loadContextFor(db, s, newRun(), { only: ["unit_of_measure", "warehouse", "item"] }),
    );
    // MATBATCHES is empty, so `lot` has recorded nothing and is not refused as missing; `opening_stock` runs.
    const report = await runLoad(
      db.rw,
      await loadContextFor(db, s, newRun(), { only: ["opening_stock"] }),
    );
    expect(report.perLoader["opening_stock"]).toBeDefined();
  }, 300_000);

  it("reconcileCutOver does not explain a position the load reported because its item was loaded after it", async () => {
    const s = await seedLoadableTenant(db, `order-${randomUUID().slice(0, 8)}`);
    // The first full run reads a source whose MATERIALS is empty: every stock position is reported (its item did not
    // import) and recorded. The items arrive in a later run, after the opening read those positions.
    useCorpus(withoutRows("MATERIALS"));
    await runLoad(db.rw, await loadContextFor(db, s, newRun()));
    useCorpus(loadCorpus("cut-over"));
    await runLoad(db.rw, await loadContextFor(db, s, newRun(), { only: ["item", "lot"] }));

    const ctx = await loadContextFor(db, s, randomUUID());
    const reader = await createReader(new FixtureLegacyDriver(loadCorpus("cut-over")));
    const rec = await withTenant(db.rw, ctx, (tx) => reconcileCutOver(tx, reader, ctx));
    expect(rec.ok).toBe(false);
    const widget = rec.stockValuation.find((r) => r.key === "WIDGET/MAIN-STORE");
    expect(widget).toMatchObject({ dulja: "0.0000", explanation: null });
    expect(widget!.label).toMatch(
      /before its item, warehouse or lot was loaded, so its skip is a load-order mistake/,
    );
    expect(rec.unexplained.map((u) => u.key)).toContain("WIDGET/MAIN-STORE");
  }, 300_000);
});

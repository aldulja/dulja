import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver, type LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyRow } from "../../src/legacy/types";
import { assertNoJobPartition, JOB_PARTITIONED_TABLES } from "../../src/load/matopens-guard";
import { createReader } from "../../src/reader";
import { loadCorpus } from "../support/corpus";

/** The cut-over corpus plus a `MATOPENS` table with the given rows (9B's prefixed spelling, `MOPJOB`). */
const corpusWith = (rows: readonly LegacyRow[], job = "MOPJOB"): LegacyCorpus => {
  const base = loadCorpus("cut-over");
  return {
    ...base,
    tables: {
      ...base.tables,
      MATOPENS: {
        keyColumns: ["MOPID"],
        columns: [
          { name: "MOPID", kind: "integer", scale: 0, nullable: false },
          { name: job, kind: "integer", scale: 0, nullable: true },
        ],
        constraints: [],
        rows: [...rows],
      },
    },
  };
};
const readerOf = async (corpus: LegacyCorpus) => createReader(new FixtureLegacyDriver(corpus));

describe("Part VII #7 / LEGACY-022 — MatOpens.Job, asked of the customer's data rather than assumed (9B T15)", () => {
  it("names the one table and column the question is about", () => {
    expect(JOB_PARTITIONED_TABLES).toEqual([{ table: "MATOPENS", column: "MOPJOB" }]);
  });

  it("returns null when every Job is 0 or NULL — LEGACY-022 is inert for this customer", async () => {
    const reader = await readerOf(
      corpusWith([
        { MOPID: "1", MOPJOB: "0" },
        { MOPID: "2", MOPJOB: null },
        { MOPID: "3", MOPJOB: "0.0000" },
        { MOPID: "4", MOPJOB: " " },
      ]),
    );
    expect(await assertNoJobPartition(reader)).toBeNull();
  });

  it("reports the finding when any Job differs from 0 — LEGACY-022 is a hard failure for this customer", async () => {
    const reader = await readerOf(
      corpusWith([
        { MOPID: "1", MOPJOB: "0" },
        { MOPID: "2", MOPJOB: "7" },
        { MOPID: "3", MOPJOB: "9" },
        { MOPID: "4", MOPJOB: "7" },
      ]),
    );
    expect(await assertNoJobPartition(reader)).toEqual({
      table: "MATOPENS",
      column: "MOPJOB",
      distinctNonZero: 2,
      sample: ["7", "9"],
    });
  });

  it("caps the sample at five values, sorted", async () => {
    const rows = ["12", "3", "40", "5", "6", "77", "8"].map((job, i) => ({
      MOPID: String(i + 1),
      MOPJOB: job,
    }));
    expect(await assertNoJobPartition(await readerOf(corpusWith(rows)))).toEqual({
      table: "MATOPENS",
      column: "MOPJOB",
      distinctNonZero: 7,
      sample: ["12", "3", "40", "5", "6"],
    });
  });

  it("returns null when the table is absent — a customer without MatOpens has no question to answer", async () => {
    expect(await assertNoJobPartition(await readerOf(loadCorpus("cut-over")))).toBeNull();
  });

  it("FAILS CLOSED when MATOPENS is present but its job column cannot be read — the question is unanswerable, not inert", async () => {
    // 9A's `questions` corpus spells the column `JOB` (its probe reads `MATOPENS.JOB`); 9B's dossier spelling is
    // `MOPJOB`. Both are hypotheses until OD-17's live catalogue (docs/owner/od-17-live-database.md); meanwhile a
    // source the guard cannot ask refuses opening stock rather than assuming every job is 0.
    const reader = await readerOf(corpusWith([{ MOPID: "1", JOB: "7" }], "JOB"));
    await expect(assertNoJobPartition(reader)).rejects.toThrow(
      "ERR_IMPORT_SOURCE_UNREADABLE: MATOPENS is in the source but MATOPENS.MOPJOB could not be read",
    );
  });
});

describe("the `matopens-partitioned` corpus LEGACY-022's regression block loads", () => {
  it("is the committed `cut-over` corpus plus a MATOPENS table, and nothing else — so the two cannot drift apart", () => {
    const base = loadCorpus("cut-over");
    const partitioned = loadCorpus("matopens-partitioned");
    const { MATOPENS, ...rest } = partitioned.tables;
    expect(rest).toEqual(base.tables);
    expect(partitioned.engineVersion).toBe(base.engineVersion);
    expect(MATOPENS!.rows.map((r) => r["MOPJOB"])).toEqual(["0", "7", "9"]);
  });
});

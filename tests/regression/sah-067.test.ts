import { describe, expect, it } from "vitest";
import { sharedDb } from "../support/regression";
import { sourceFiles } from "../support/source";

/** Any `test/` or `tests/` directory, the same shape `scripts/lint/rules/posting-only-tables.ts` uses.
 *  A suite that proves an index exists by turning the sequential scan OFF is not a production plan hint —
 *  packages/db/test/report-indexes.test.ts does exactly that, deliberately, and no test tree ships. */
const TEST_TREE = /(^|\/)tests?\//;

/** A plan pinned into source: an Oracle-style `/*+ INDEX(...) *\/` hint, a session `enable_seqscan` switch,
 *  or a `PLAN (…)` clause. SAH-067's root cause was an answer that depended on which index the planner
 *  chose, so the defence is that no shipped file chooses for it. */
const PINNED_PLAN = /\+INDEX\s*\(|enable_seqscan|PLAN\s*\(/i;

describe("SAH-067 Stock-on-hand replays the entire movement history under a forced index-navigation plan — 3A", () => {
  it("stock on hand is a stored projection, not a replay — and it has a primary key to update", async () => {
    const { db } = await sharedDb();
    const [pk] = await db.admin<{ cols: string[] }[]>`
      select array_agg(a.attname order by k.ord) as cols
        from pg_constraint c
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'app.stock_on_hand'::regclass and c.contype = 'p'`;
    // The old system computed the figure by walking every movement of the material, every time, and the
    // walk was pinned to one index. Here the figure is a row, MERGEd in the posting transaction, and the
    // nightly job rebuilds and compares it (acceptance test 2) instead of the read path recomputing it.
    expect(pk!.cols).toEqual(["company_id", "item_id", "warehouse_id", "lot_id"]);
  });

  it("the chronological key is an INDEX and its columns are explicit and total (spec:1225)", async () => {
    const { db } = await sharedDb();
    const [idx] = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = 'app' and indexname = 'inventory_movement_chrono_idx'`;
    for (const column of [
      "company_id",
      "item_id",
      "warehouse_id",
      "effective_date",
      "posting_seq",
      "line_no",
      "movement_no",
    ]) {
      expect(idx!.indexdef, column).toContain(column);
    }
  });

  it("no shipped source file pins a query plan the way the legacy procedures did", () => {
    const offenders = sourceFiles()
      .filter((f) => !TEST_TREE.test(f.path) && PINNED_PLAN.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

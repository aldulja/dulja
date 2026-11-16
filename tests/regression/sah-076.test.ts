import { describe, expect, it } from "vitest";
import { costingContext } from "./support/costing";
import { repoFile } from "../support/regression";
import { CATALOGUE_7B, readEnvelope } from "../invariants/support/reports";

const ctx = costingContext("076"); // ← this file's own SAH number

describe("SAH-076 Duplicate and near-duplicate costing procedures — 3B", () => {
  // first proven by spec:841, spec:1228
  it("costingEngine is the only export any consumer imports, and there is exactly one of it", async () => {
    const files = await ctx.sourceFiles(["packages", "apps"]);
    const definitions = files.filter((f) => /export const costingEngine\b/.test(f.text));
    expect(definitions.map((f) => f.path)).toEqual(["packages/domain/src/costing/engine.ts"]);
    const consumers = files.filter(
      (f) => /\bcostingEngine\b/.test(f.text) && f.path !== definitions[0]!.path,
    );
    expect(consumers.length).toBeGreaterThan(0);
  });
});

/** Every string VALUE of a parsed JSON document — labels, headers, options — never its keys. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("SAH-076 Duplicate and near-duplicate costing procedures — 7B", () => {
  // The legacy system had several procedures computing "the" cost, and they disagreed. The report catalogue is
  // where a rewrite is most tempted to add another: a valuation, a profit and an ageing report could each carry
  // their own arithmetic. None does — three definitions, three registered sources, no aggregate of their own.
  it("no definition in the 7b pack reads cost_consumption, and the three cost reports name one source each", () => {
    const sources = new Map(
      CATALOGUE_7B.map((c) => [c, readEnvelope(c).definition.dataset.source]),
    );
    expect(sources.get("inventory.valuation")).toBe("stock_valuation");
    expect(sources.get("inventory.stock_ageing")).toBe("cost_layer");
    expect(sources.get("inventory.profit_by_item")).toBe("item_profitability");
    expect([...sources.values()]).not.toContain("cost_consumption");
  });

  // Test 27's clause applied to seed data: no SQL text crosses into a definition. Read over every STRING VALUE
  // of each file (labels, headers, options), for SQL's shapes — a select list with its from, a where or join
  // clause, a statement terminator or a comment. Not a bare English "from": "Valid from" is a column label, and a
  // check that banned it would be policing prose rather than SQL.
  it("no file in the 7b pack carries SQL text in any value", () => {
    for (const code of CATALOGUE_7B) {
      const values = strings(JSON.parse(repoFile(`packages/db/seed/my/reports/7b/${code}.json`)));
      for (const value of values) {
        expect(value, code).not.toMatch(/\bselect\b[\s\S]*\bfrom\b|\bwhere\b|\bjoin\b|;|--/i);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { fullRegression } from "../support/api";
import { sourceFiles } from "../support/source";

/** The legacy fix for missing indexes was a pinned plan (`PLAN JOIN (…)`, `+ INDEX (…)`); Dulja's fix is the
 *  index itself, and no plan directive anywhere. Both halves are asserted. */
describe("LEGACY-068 23 hardcoded query plans, two pinning implicitly-generated index names — 0B (source)", () => {
  it("no source file pins an optimiser plan or names an index in a query", () => {
    const offenders = sourceFiles()
      .flatMap((f) => f.lines.map((line, i) => ({ file: f.path, line: i + 1, text: line })))
      .filter(
        (l) =>
          /\bPLAN\s+(JOIN|SORT|MERGE)\b/i.test(l.text) ||
          /\/\*\+\s*index/i.test(l.text) ||
          /\bset\s+enable_(seqscan|indexscan|hashjoin|mergejoin)\b/i.test(l.text),
      );
    expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([]);
  });
});

fullRegression(
  "LEGACY-068",
  "23 hardcoded query plans, two pinning implicitly-generated index names",
  {
    "the index the ledger reports need exists, so no plan needs pinning": async ({
      api,
      expect: assertion,
    }) => {
      const idx = await api.db.admin<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'app' and tablename = 'ledger_entry' order by indexname`;
      assertion(idx.map((i) => i.indexname)).toContain("ledger_entry_account_date_idx");
    },

    "the planner is free: the same statement is planned by Postgres, with no directive in the SQL text":
      async ({ api, a, expect: assertion }) => {
        const plan = await api.db.admin<{ "QUERY PLAN": string }[]>`
      explain select id from app.ledger_entry where company_id = ${a.company} and effective_date >= '2026-01-01'`;
        assertion(plan.length).toBeGreaterThan(0);
        assertion(plan.map((p) => p["QUERY PLAN"]).join("\n")).not.toMatch(/PLAN\s+JOIN/i);
      },
  },
);

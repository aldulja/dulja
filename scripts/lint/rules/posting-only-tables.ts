import type { LintRule, LintViolation } from "../types";

/**
 * contracts §3.7.5, owned by 1A. The mechanical half of spec:97 "never write to a ledger or movement table
 * outside the posting service". Reads are unrestricted — a report selects freely.
 *
 * The async projections `party_ageing`, `item_profitability` and `stock_valuation` are deliberately NOT here:
 * they are rebuilt by their pg-boss jobs, not by the posting service.
 */
const PROTECTED = [
  "app.ledger_entry",
  "app.ledger_entry_dimension",
  "app.inventory_movement",
  "app.cost_layer",
  "app.cost_consumption",
  // 0115 (code review 2): the replay's per-issue booking record, written with the consumptions it describes.
  "app.cost_booking",
  "app.account_balance",
  "app.stock_on_hand",
  "app.tax_transaction",
  // 8C (migration 0092): the YTD projection, MERGE'd at postDocument step 12 (spec:98, spec:1978, ADR 0077).
  "app.employee_ytd",
];

/** The two production homes. Nothing else that ships may write one of the tables above. */
const ALLOWED_PREFIXES = [
  "packages/db/src/posting/",
  "packages/db/src/costing/",
  // This rule's own source names the tables, and a future fixture here may name them in a DML string.
  "scripts/lint/rules/",
];

/**
 * Any test tree. The plan for this rule listed `packages/db/test/` alone; that is one workspace's tests, and
 * the rule as written would have failed the build on `apps/worker/test/ledger-integrity-check.test.ts`, whose
 * whole subject is a ledger the posting service could not have written. A test that proves the integrity
 * checker detects a corrupt ledger has to be able to write one, and no test tree ships, so the allowance is
 * every `test/` or `tests/` directory rather than a list that grows by one entry per slice.
 */
const TEST_TREE = /(^|\/)tests?\//;

/** `insert into app.x`, `update app.x`, `delete from app.x`, `merge into app.x` — the four DML verbs. */
const DML = /\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+(app\.[a-z_]+)/gi;

export const rule: LintRule = {
  name: "posting-only-tables",
  run(files) {
    const violations: LintViolation[] = [];
    for (const file of files) {
      if (ALLOWED_PREFIXES.some((prefix) => file.path.startsWith(prefix))) continue;
      if (TEST_TREE.test(file.path)) continue;
      file.lines.forEach((line, index) => {
        for (const match of line.matchAll(DML)) {
          const table = match[1]!.toLowerCase();
          if (!PROTECTED.includes(table)) continue;
          // The owner-approved representation migration backfills only these derived rows. Ledger and
          // movement writes remain forbidden, including in this migration; other migrations get no waiver.
          if (
            file.path === "packages/db/migrations/0118_preserve_exact_cost_layer_value.sql" &&
            ((table === "app.cost_booking" && /^insert\s+into\s/i.test(match[0])) ||
              (["app.cost_layer", "app.cost_consumption"].includes(table) &&
                /^update\s/i.test(match[0])))
          )
            continue;
          violations.push({
            file: file.path,
            line: index + 1,
            rule: this.name,
            detail: `${table} may be written only by packages/db/src/posting/ or packages/db/src/costing/ (spec:97, contracts §3.7.5)`,
          });
        }
      });
    }
    return violations;
  },
};

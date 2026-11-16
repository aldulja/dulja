import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/posting-only-tables";
import type { SourceFile } from "../../scripts/lint/types";

const file = (path: string, text: string): SourceFile => ({ path, text, lines: text.split("\n") });

describe("posting-only-tables — contracts §3.7.5, the mechanical half of spec:97", () => {
  it("flags a write to a ledger, movement or projection table outside the posting and costing homes", () => {
    const bad = file(
      "apps/api/src/routes/accounting/documents.ts",
      [
        "await tx`insert into app.ledger_entry (tenant_id) values (1)`;",
        "await tx`merge into app.account_balance b using (select 1) s on true`;",
        "await tx`delete from app.stock_on_hand where item_id = ${id}`;",
      ].join("\n"),
    );
    expect(rule.run([bad]).map((violation) => violation.line)).toEqual([1, 2, 3]);
    expect(rule.run([bad])[0]!.detail).toContain("app.ledger_entry");
  });

  it("allows the posting service, the costing engine, every test tree and its own fixtures", () => {
    for (const path of [
      "packages/db/src/posting/post.ts",
      "packages/db/src/costing/apply.ts",
      "packages/db/test/posting/post.test.ts",
      // A test that proves the integrity checker finds a corrupt ledger has to be able to write one.
      "apps/worker/test/ledger-integrity-check.test.ts",
      "tests/regression/sah-002.test.ts",
      "scripts/lint/rules/posting-only-tables.test.ts",
    ]) {
      expect(
        rule.run([file(path, "await tx`insert into app.ledger_entry (tenant_id) values (1)`;")]),
      ).toEqual([]);
    }
  });

  it("guards app.cost_booking as it guards cost_layer and cost_consumption (migration 0115)", () => {
    // The replay's restart state: what the ledger carries for each issue's cost. Written only by the costing
    // engine, on the transactions that invalidate or recompute that issue's consumptions (code review 2).
    const write = "await tx`update app.cost_booking set pending = null where id = ${id}`;";
    const outside = rule.run([file("apps/worker/src/jobs/cost-replay.ts", write)]);
    expect(outside.map((violation) => violation.line)).toEqual([1]);
    expect(outside[0]!.detail).toContain("app.cost_booking");
    expect(rule.run([file("packages/db/src/costing/replay.ts", write)])).toEqual([]);
  });

  it("allows a read of the same tables anywhere — reports select freely", () => {
    const report = file(
      "apps/api/src/routes/accounting/ledger.ts",
      "await tx`select * from app.ledger_entry where id = ${id}`;",
    );
    expect(rule.run([report])).toEqual([]);
  });

  it("does not flag the async projections, which their own jobs rebuild (contracts §3.7.5)", () => {
    const job = file(
      "apps/worker/src/jobs/rebuild.ts",
      "await tx`insert into app.party_ageing (tenant_id) values (1)`;",
    );
    expect(rule.run([job])).toEqual([]);
  });
});

it("limits migration 0118's approved backfill to the three derived costing tables", () => {
  const writes = [
    "update app.cost_layer set value = 1;",
    "update app.cost_consumption set invalidated_at = now();",
    "insert into app.cost_booking (pending) values ('recost');",
    "update app.inventory_movement set value = 1;",
    "update app.ledger_entry set base_debit = 1;",
    "delete from app.cost_layer;",
    "delete from app.cost_consumption;",
    "delete from app.cost_booking;",
  ].join("\n");
  const allowed = "packages/db/migrations/0118_preserve_exact_cost_layer_value.sql";
  expect(rule.run([file(allowed, writes)]).map((v) => v.line)).toEqual([4, 5, 6, 7, 8]);
  expect(rule.run([file("packages/db/migrations/0119_other.sql", writes)])).toHaveLength(8);
});

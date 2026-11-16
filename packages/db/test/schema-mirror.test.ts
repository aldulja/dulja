import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { startDb, type Db } from "./harness";

describe("Drizzle read mirrors", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  });
  afterAll(async () => {
    await db.stop();
  });
  // No count in this title, deliberately: it said "thirteen" while the assertion below pinned 17,
  // because mirrors were added by later slices and the prose was not. The count belongs in the
  // assertion, which fails when it drifts; a number in a test name drifts silently.
  it("every Drizzle read mirror names real app columns", async () => {
    const actual = await db.admin<
      { table_name: string; column_name: string }[]
    >`select table_name, column_name from information_schema.columns where table_schema = 'app'`;
    const real = new Set(actual.map((row) => `${row.table_name}.${row.column_name}`));
    const mirrored = (Object.values(schema) as unknown[]).filter(
      (table): table is PgTable =>
        typeof table === "object" && table !== null && Symbol.for("drizzle:Name") in table,
    );
    // 39 = 28 at Phase 2's head + 3A's eleven (item, unit_of_measure, unit_conversion, warehouse, lot,
    // variant, price_list, price_list_line, promotion, inventory_movement, stock_on_hand).
    // It read 23 until 3A: Phase 2 added party, document_type, document_event, attachment and
    // print_template without moving it, so the number was already wrong by five before this phase touched
    // it. Nothing reported that, because this suite is Testcontainer-backed and has never run — which is
    // the point of the comment above about a count drifting silently.
    // 42 = 39 at 3A's head + 3B's three (cost_layer, cost_consumption, stock_valuation — migration 0034).
    // 43 = 42 at 3B's head + 3C's document_link (migration 0037). The open-quantity VIEW of the same
    // migration does NOT move this number: Drizzle marks a view with `drizzle:ViewBaseConfig`, never
    // `drizzle:Name`, so the filter above never sees it — and `getTableConfig` would throw on one.
    // 44 = 43 at 3C Task 1's head + 3C Task 7's landed_cost_allocation (migration 0038).
    // 45 = 44 at Phase 3's head + 4A Task 1's payment_term (migration 0044).
    // 47 = 45 + 4B Task 6's bank_statement and bank_statement_line (migration 0049).
    // 48 = 47 + 4A Task 9's allocation (migration 0046).
    // 50 = 48 + 4B Task 1's party_ageing and item_profitability (migration 0048).
    // 51 = 50 + 4B Task 7's bank_match (migration 0050).
    // 52 = 51 + the Phase 4 code-review pass's cost_booking (migration 0115).
    // Phase 5 adds four tax mirrors and the e-invoice transmission mirror.
    // Phase 6A adds three sync mirrors and the formerly missing terminal mirror.
    // Phase 6C adds the employee master in 0064 cashier projection in 0065 and branch limits in 0066 and attendance in 0067.
    // 68 = 65 + 6A's terminal_request_guard (0060, PR 12 review E1) + 6D's shift and till_event (0070), the
    // last two mirrored since 6D but exported only from src/index.ts until now, so this walk never saw them.
    // 69 = 68 + 6D's till_banking_link (0071, ⚠️ OD-10 answered yes on 2026-11-04).
    // 70 = 69 + 7A's report_definition (0074).
    // 72 = 70 + 7A's saved_view and report_run (0075).
    // 73 = 72 + 7C's export_job (0078).
    // 74 = 73 + 8A's employee_sensitive (0081).
    // 75 = 74 + 8A's employee_statutory_profile (0082).
    // 78 = 75 + 8A's pay_component, pay_component_scheme and compensation_line (0083).
    // 80 = 78 + 8A's statutory_scheme and statutory_rate_table (0084).
    // 81 = 80 + 8A's company_hr_setting (0085).
    // 83 = 81 + 8B's payroll_run and payroll_line (0087).
    // 84 = 83 + 8C's statutory_schedule (0091).
    // 86 = 84 + 8C's employee_ytd and employee_ytd_opening (0092).
    // 90 = 86 + 8D's leave_type, leave_entitlement, leave_record and public_holiday (0096, ⚠️ OD-13 answered build).
    // 91 = 90 + 9B's import_batch (0102, contracts round 20 C7).
    // 92 = 91 + 9B's import_run (0103, contracts round 20 C17).
    expect(mirrored).toHaveLength(92);
    const missing: string[] = [];
    for (const table of mirrored) {
      const cfg = getTableConfig(table);
      expect(cfg.schema, cfg.name).toBe("app");
      for (const column of cfg.columns)
        if (!real.has(`${cfg.name}.${column.name}`)) missing.push(`${cfg.name}.${column.name}`);
    }
    expect(missing).toEqual([]);
  });
});

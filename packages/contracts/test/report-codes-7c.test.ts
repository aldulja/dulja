import { describe, expect, it } from "vitest";
import { ReportCodeSchema } from "../src/accounting/reports";

describe("ReportCodeSchema after 7C — contracts §4.16.3, amendment A15", () => {
  const members = ReportCodeSchema.options as readonly string[];

  it("holds every 7C code that is not owner-gated", () => {
    for (const code of [
      "accounting.ageing",
      "accounting.party_statement",
      "accounting.allocation_register",
      "accounting.unreconciled_items",
      "accounting.branch_profit_and_loss",
      "accounting.tax_return_view",
      "pos.z_report",
      "pos.sales_by_cashier",
      "pos.sales_by_branch",
      "pos.needs_attention",
    ]) {
      expect(members, code).toContain(code);
    }
    // ⚠️ OD-09 = not built: the post-dated cheque register is dropped with its table (A16 item 1).
    expect(members).not.toContain("accounting.pdc_register");
  });

  it("holds every predecessor code and asserts no total count (amendment A15)", () => {
    for (const code of [
      "accounting.trial_balance",
      "accounting.ledger",
      "accounting.general_ledger",
      "inventory.stock_on_hand",
      "inventory.valuation",
      "inventory.sales_by_item",
    ]) {
      expect(members, code).toContain(code);
    }
    expect(new Set(members).size).toBe(members.length); // no duplicate — the only structural claim made
  });

  it("every member matches §4.16.1's two-segment grammar", () => {
    for (const code of members) {
      expect(code, code).toMatch(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/);
    }
  });
});

import type { Change } from "@dulja/sync";
import type { TillCashier } from "../../src/main/authority";
const LIMITS = {
  maxLineDiscountPct: "0.100000",
  maxTicketDiscountPct: "0.050000",
  maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500",
  requireCustomerOver: null,
  maxCashInDrawer: null,
};
export const SELLER: TillCashier = {
  principalId: "p-1",
  employeeId: "e-1",
  branchId: "br-1",
  codes: ["pos.ticket.sell", "pos.ticket.return", "pos.shift.own"],
  limits: LIMITS,
  snapshotRevision: "1",
};

// One item at 3.3300 with a 10 % inclusive tax code, so a 1-unit sale grosses 3.3300 and rounds to 3.3500.
export const CATALOGUE: Change[] = [
  {
    stream: "item",
    op: "upsert",
    id: "item-A",
    revision: 10n,
    row: {
      id: "item-A",
      code: "SKU-A",
      barcode: "9001",
      name_en: "Rice",
      name_ar: "أرز",
      kind: "product",
      base_unit_id: "unit-ea",
      track_lots: false,
      tax_code_id: "tax-std",
    },
  },
  {
    stream: "price_list",
    op: "upsert",
    id: "pl",
    revision: 11n,
    row: {
      id: "pl",
      code: "RETAIL",
      currency: "MYR",
      customer_kind: null, // the till sells at the walk-in trade level (ADR 0057, POS-02)
      branch_id: null,
      valid_from: null,
      valid_to: null,
    },
  },
  {
    stream: "price_list_line",
    op: "upsert",
    id: "pll",
    revision: 12n,
    row: {
      id: "pll",
      price_list_id: "pl",
      item_id: "item-A",
      unit_id: null,
      min_quantity: "0.000000",
      unit_price: "3.3300",
    },
  },
  {
    stream: "tax_code",
    op: "upsert",
    id: "tax-std",
    revision: 13n,
    row: {
      id: "tax-std",
      code: "SYNTH-OUT-STD",
      rate: "0.10000000",
      kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO",
      output_account_id: "acct-2300",
      input_account_id: null,
      effective_from: "2026-01-01",
      effective_to: null,
    },
  },
  {
    stream: "branch_pos_policy",
    op: "upsert",
    id: "bpp",
    revision: 14n,
    row: {
      id: "bpp",
      branch_id: "br-1",
      max_line_discount_pct: "0.100000",
      max_ticket_discount_pct: "0.050000",
      max_void_amount: "200.0000",
      max_price_override_pct: "0.020000",
      blind_return_allowed: false,
      max_blind_return_amount: "0.0000",
      max_cash_in_drawer: null,
      require_customer_over: null,
      rounding_increment: "0.0500",
      paid_out_allowed: false,
      max_paid_out_amount: "0.0000",
    },
  },
];

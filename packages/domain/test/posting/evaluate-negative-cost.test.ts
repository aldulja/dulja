import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "../../src/index";
import type { PostingPolicy } from "../../src/posting";
import {
  evaluatePolicy,
  type DocumentSnapshot,
  type LineSnapshot,
} from "../../src/posting/evaluate";

const MYR = currency("MYR");

/** A DELIVERY_ORDER-shaped policy: both legs at line.cost with FIXED sides (3D's real file). */
const COST_ONLY = {
  version: 1,
  documentType: "DELIVERY_ORDER",
  direction: "outbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1250" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: { effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" },
  tax: { applies: false },
  numbering: { series: "DO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
  approval: { required: false, approve: null, post: "inventory.transfer.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
} as unknown as PostingPolicy;

function line(over: Partial<LineSnapshot>): LineSnapshot {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    lineNo: 1,
    kind: "item",
    description: null,
    accountId: null,
    itemId: "item-1",
    quantity: Quantity.of("5.000000"),
    unitPrice: Money.of("9.0000", MYR),
    discount: Money.zero(MYR),
    amount: Money.of("45.0000", MYR),
    taxCodeId: null,
    taxAmount: Money.zero(MYR),
    totalInclTax: Money.of("45.0000", MYR),
    debit: Money.zero(MYR),
    credit: Money.zero(MYR),
    cost: Money.of("15.0000", MYR),
    warehouseId: "wh-1",
    toWarehouseId: null,
    lotId: null,
    unitId: "unit-1",
    unitQuantity: null,
    countedQuantity: null,
    expectedQuantity: null,
    tenderMethod: null,
    customFields: {},
    dimensions: {},
    payroll: null,
    ...over,
  };
}

function snapshot(lines: LineSnapshot[]): DocumentSnapshot {
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: "DELIVERY_ORDER",
      status: "issued",
      series: "DO",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-10",
      partyId: "party-1",
      currency: MYR,
      exchangeRate: {
        from: MYR,
        to: MYR,
        rate: "1.00000000",
        effectiveFrom: "2026-01-01",
        source: "unit",
      },
      branchId: "branch-1",
      attributedTo: null,
      clientRef: null,
      warehouseId: "wh-1",
      toWarehouseId: null,
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: {},
    },
    lines,
    company: {
      id: "co-1",
      baseCurrency: MYR,
      fxRoundingAccountId: "acc-5920",
      costingMethod: "avco",
    },
    party: {
      id: "party-1",
      kind: "customer",
      receivableAccountId: "acc-1200",
      payableAccountId: "acc-2100",
      creditLimit: null,
    },
    refs: {
      accountsByCode: { "1250": "acc-1250" },
      items: {
        "item-1": {
          id: "item-1",
          code: "IT-1",
          kind: "product",
          baseUnitId: "unit-1",
          trackLots: false,
          revenueAccountId: "acc-4000",
          inventoryAccountId: "acc-1300",
          cogsAccountId: "acc-5000",
          expenseAccountId: null,
        },
      },
      taxCodes: {},
      components: {},
      schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  } as unknown as DocumentSnapshot;
}

describe("line.cost on a negative-quantity line — ADR 0045, contracts §4.4.2", () => {
  it("a POSITIVE quantity keeps the policy's sides: debit 1250, credit inventory", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({})]));
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      ["acc-1250", "debit", "15.0000"],
      ["acc-1300", "credit", "15.0000"],
    ]);
  });

  it("a NEGATIVE quantity flips both sides and keeps the magnitude — the corridor is RELIEVED", () => {
    const plan = evaluatePolicy(
      COST_ONLY,
      snapshot([line({ quantity: Quantity.of("-5.000000") })]),
    );
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      ["acc-1250", "credit", "15.0000"],
      ["acc-1300", "debit", "15.0000"],
    ]);
  });

  it("PlannedLedgerLine.amount is STILL never negative — A9 holds (§4.4.2)", () => {
    const plan = evaluatePolicy(
      COST_ONLY,
      snapshot([line({ quantity: Quantity.of("-5.000000") })]),
    );
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
  });

  it("a ZERO quantity is untouched: the cost keeps its sign and the line is dropped as a zero only if the cost is zero", () => {
    const plan = evaluatePolicy(COST_ONLY, snapshot([line({ quantity: Quantity.of("0.000000") })]));
    expect(plan.ledgerLines.map((l) => l.side)).toEqual(["debit", "credit"]);
  });

  it("a NULL quantity — an account or text line — is untouched", () => {
    // The same two legs under `effect: "none"` (the 4A invoice shape). Under COST_ONLY's `issue`, 3A's
    // planMovements refuses a product line with no quantity before any ledger line is read, which is a
    // movement rule and not the reading this case is about.
    const none = { ...COST_ONLY, inventory: { effect: "none" } } as unknown as PostingPolicy;
    const plan = evaluatePolicy(none, snapshot([line({ quantity: null })]));
    expect(plan.ledgerLines.map((l) => l.side)).toEqual(["debit", "credit"]);
  });

  it("a null cost still emits at Money.zero with the fill tag, on the policy's own side (A5, A3D-5)", () => {
    const plan = evaluatePolicy(
      COST_ONLY,
      snapshot([line({ cost: null, quantity: Quantity.of("-5.000000") })]),
    );
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString(), l.fill])).toEqual([
      ["debit", "0.0000", "cost"],
      ["credit", "0.0000", "cost"],
    ]);
    expect(plan.warnings).toHaveLength(1); // one warning per SOURCE line, not per rule (A5)
  });

  it("line.variance_value follows the same rule (3D's STOCK_COUNT and TRANSFER_RECEIPT shapes)", () => {
    const variance = {
      ...COST_ONLY,
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { code: "1250" },
          amount: "line.variance_value",
          when: { "line.kind": "item" },
        },
      ],
    } as unknown as PostingPolicy;
    const plan = evaluatePolicy(variance, snapshot([line({ quantity: Quantity.of("-2.000000") })]));
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString()])).toEqual([
      ["credit", "15.0000"],
    ]);
  });
});

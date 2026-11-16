import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "../../src/index";
import {
  evaluatePolicy,
  parsePolicy,
  type DocumentSnapshot,
  type LineSnapshot,
} from "../../src/posting/evaluate";

const MYR = currency("MYR");
const UNIT = {
  from: MYR,
  to: MYR,
  rate: "1.00000000",
  effectiveFrom: "2026-01-01",
  source: "unit",
} as const;

const RECEIPT_POLICY = parsePolicy({
  version: 1,
  documentType: "TRANSFER_RECEIPT",
  direction: "internal",
  requires: ["warehouse", "to_warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1310" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1310" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "1310" },
      amount: "line.variance_value",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
  ],
  inventory: {
    effect: "transfer",
    warehouse: "header.warehouse",
    to_warehouse: "header.to_warehouse",
    costing: "consume_layers",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "TRR", assignAt: "issue" },
  // see "the reversal interaction" in Task 8
  reversal: { allowed: false, producesType: null },
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
});

function receiptLine(counted: string, expected: string): LineSnapshot {
  return {
    id: "line-1",
    lineNo: 1,
    kind: "item",
    description: null,
    accountId: null,
    itemId: "item-1",
    quantity: Quantity.of(counted).subtract(Quantity.of(expected)),
    unitPrice: null,
    discount: Money.zero(MYR),
    amount: Money.zero(MYR),
    taxCodeId: null,
    taxAmount: Money.zero(MYR),
    totalInclTax: Money.zero(MYR),
    debit: Money.zero(MYR),
    credit: Money.zero(MYR),
    cost: null,
    warehouseId: null,
    toWarehouseId: null,
    lotId: "lot-1",
    unitId: "unit-1",
    unitQuantity: null,
    countedQuantity: Quantity.of(counted),
    expectedQuantity: Quantity.of(expected),
    tenderMethod: null,
    customFields: {},
    dimensions: {},
    payroll: null,
  };
}

function receiptSnapshot(source: LineSnapshot): DocumentSnapshot {
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: "TRANSFER_RECEIPT",
      status: "issued",
      series: "TRR",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-20",
      partyId: null,
      currency: MYR,
      exchangeRate: UNIT,
      branchId: "branch-b",
      attributedTo: null,
      clientRef: null,
      warehouseId: "wh-transit",
      toWarehouseId: "wh-b",
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: {},
    },
    lines: [source],
    company: {
      id: "co-1",
      baseCurrency: MYR,
      fxRoundingAccountId: "acct-5920",
      costingMethod: "avco",
    },
    party: null,
    refs: {
      accountsByCode: { "1310": "acct-1310", "5110": "acct-5110" },
      items: {
        "item-1": {
          id: "item-1",
          code: "SKU1",
          kind: "product",
          baseUnitId: "unit-1",
          trackLots: true,
          revenueAccountId: "acct-4000",
          inventoryAccountId: "acct-1300",
          cogsAccountId: "acct-5000",
          expenseAccountId: "acct-5900",
        },
      },
      taxCodes: {},
      components: {},
      schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  };
}

describe("evaluatePolicy — the transfer effect (ADR 0043; §4.4.2 as amended by 3D)", () => {
  it("an EXACT receipt emits issue(expected) at the source and receipt(counted) at the destination", () => {
    const plan = evaluatePolicy(
      RECEIPT_POLICY,
      receiptSnapshot(receiptLine("10.000000", "10.000000")),
    );
    expect(
      plan.movements.map((m) => [m.movementNo, m.effect, m.warehouseId, m.quantity.toString()]),
    ).toEqual([
      [1, "issue", "wh-transit", "10.000000"],
      [2, "receipt", "wh-b", "10.000000"],
    ]);
    // Amendment A4: the issue leg carries the policy's `costing`; the destination leg always creates.
    expect(plan.movements.map((m) => m.costing)).toEqual(["consume_layers", "create_layer"]);
    // Zero variance: the two variance legs match neither sign, so only the two `cost` legs are planned.
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit", "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
    ]);
  });

  it("a SHORTFALL emits the two quantities unequally and adds the two negative-sign variance legs", () => {
    const plan = evaluatePolicy(
      RECEIPT_POLICY,
      receiptSnapshot(receiptLine("8.000000", "10.000000")),
    );
    expect(plan.movements.map((m) => [m.effect, m.warehouseId, m.quantity.toString()])).toEqual([
      ["issue", "wh-transit", "10.000000"],
      ["receipt", "wh-b", "8.000000"],
    ]);
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit", "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
      ["debit", "acct-5110", "variance_value"],
      ["credit", "acct-1310", "variance_value"],
    ]);
  });

  it("an OVER-RECEIPT selects the positive-sign legs, which reverse the variance direction", () => {
    const plan = evaluatePolicy(
      RECEIPT_POLICY,
      receiptSnapshot(receiptLine("11.000000", "10.000000")),
    );
    expect(plan.movements.map((m) => m.quantity.toString())).toEqual(["10.000000", "11.000000"]);
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit", "acct-1300", "cost"],
      ["credit", "acct-1310", "cost"],
      ["credit", "acct-5110", "variance_value"],
      ["debit", "acct-1310", "variance_value"],
    ]);
  });

  it("a line with no count columns transfers `quantity` on both legs (the TRANSFER dispatch shape)", () => {
    const l = receiptLine("10.000000", "10.000000");
    const plan = evaluatePolicy(
      RECEIPT_POLICY,
      receiptSnapshot({
        ...l,
        quantity: Quantity.of("6.000000"),
        countedQuantity: null,
        expectedQuantity: null,
      }),
    );
    expect(plan.movements.map((m) => m.quantity.toString())).toEqual(["6.000000", "6.000000"]);
  });
});

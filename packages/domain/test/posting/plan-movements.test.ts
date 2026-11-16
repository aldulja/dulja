import { describe, expect, it } from "vitest";
import {
  currency,
  evaluatePolicy,
  Money,
  planMovements,
  PolicyEvaluationError,
  Quantity,
  type DocumentSnapshot,
  type ItemRef,
  type LineSnapshot,
  type PostingPolicy,
} from "../../src";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);

const product: ItemRef = {
  id: "item-p",
  code: "RICE-5KG",
  kind: "product",
  baseUnitId: "unit-pcs",
  trackLots: false,
  revenueAccountId: "acc-4000",
  inventoryAccountId: "acc-1300",
  cogsAccountId: "acc-5000",
  expenseAccountId: null,
};
const tracked: ItemRef = { ...product, id: "item-t", code: "MILK-1L", trackLots: true };
const service: ItemRef = {
  ...product,
  id: "item-s",
  code: "FREIGHT",
  kind: "service",
  trackLots: false,
};

function line(over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot {
  return {
    id: `l-${over.lineNo}`,
    kind: "item",
    description: null,
    accountId: null,
    itemId: product.id,
    quantity: Quantity.of("10.000000"),
    unitPrice: m("5.0000"),
    discount: m("0.0000"),
    amount: m("50.0000"),
    taxCodeId: null,
    taxAmount: m("0.0000"),
    totalInclTax: m("50.0000"),
    debit: m("0.0000"),
    credit: m("0.0000"),
    cost: null,
    warehouseId: null,
    toWarehouseId: null,
    lotId: null,
    unitId: null,
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

function snapshot(
  lines: LineSnapshot[],
  header: Partial<DocumentSnapshot["header"]> = {},
): DocumentSnapshot {
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: "STOCK_ISSUE_TEST",
      status: "issued",
      series: "SIT",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-15",
      partyId: null,
      currency: MYR,
      exchangeRate: {
        from: MYR,
        to: MYR,
        rate: "1.00000000",
        effectiveFrom: "2026-01-01",
        source: "unit",
      },
      branchId: "br-hq",
      attributedTo: null,
      clientRef: null,
      warehouseId: "wh-main",
      toWarehouseId: null,
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: {},
      ...header,
    },
    lines,
    company: {
      id: "co-1",
      baseCurrency: MYR,
      fxRoundingAccountId: "acc-5920",
      costingMethod: "avco",
    },
    party: null,
    refs: {
      accountsByCode: {},
      taxCodes: {},
      components: {},
      schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
      items: { [product.id]: product, [tracked.id]: tracked, [service.id]: service },
    },
  };
}

function policy(inventory: PostingPolicy["inventory"]): PostingPolicy {
  return {
    version: 1,
    documentType: "STOCK_ISSUE_TEST",
    direction: "internal",
    requires: [],
    lines: [],
    inventory,
    tax: { applies: false },
    numbering: { series: "SIT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "STOCK_ISSUE_TEST" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  } as PostingPolicy;
}

describe("planMovements — ADR 0035, contracts §4.4.2", () => {
  it("plans nothing when the policy moves no stock", () => {
    expect(planMovements(policy({ effect: "none" }), snapshot([line({ lineNo: 1 })]))).toEqual([]);
  });

  it("an issue emits one movement per product line, numbered from 1 in emission order", () => {
    const plan = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 }), line({ lineNo: 2, quantity: Quantity.of("4.000000") })]),
    );
    expect(plan).toEqual([
      {
        lineNo: 1,
        movementNo: 1,
        itemId: product.id,
        warehouseId: "wh-main",
        lotId: null,
        quantity: Quantity.of("10.000000"),
        effect: "issue",
        value: null,
        costing: "consume_layers",
      },
      {
        lineNo: 2,
        movementNo: 2,
        itemId: product.id,
        warehouseId: "wh-main",
        lotId: null,
        quantity: Quantity.of("4.000000"),
        effect: "issue",
        value: null,
        costing: "consume_layers",
      },
    ]);
  });

  it("a negative line quantity flips the effect and keeps the quantity a MAGNITUDE (amendment A9)", () => {
    const [mv] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-10.000000") })]),
    );
    expect(mv!.effect).toBe("receipt");
    expect(mv!.quantity.toString()).toBe("10.000000");
    expect(mv!.quantity.isNegative()).toBe(false);
    // Rule 9: costing follows the EMITTED effect. The policy declared consume_layers, but this movement is
    // a receipt, and §4.7.1's engine produces `newLayer` for a receipt — a receipt carrying consume_layers
    // would be a self-contradictory plan frozen into the array 3B, 3D, 6A and 9B all read.
    expect(mv!.costing).toBe("create_layer");
  });

  it("costing 'zero' is an instruction, not a direction: it survives every flip and both transfer legs", () => {
    // §4.7.1: "a value-less issue with no open layers costs at zero only when costing = 'zero'" — the FOC
    // marker (spec:1055) 3B reads. Rule 9 derives costing from the emitted effect for every other label and
    // leaves this one alone; overriding it would delete exactly the signal it exists to carry.
    const [foc] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "zero" }),
      snapshot([line({ lineNo: 1 })]),
    );
    expect(foc!.costing).toBe("zero");
    const [reversedFoc] = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "zero" }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-3.000000") })]),
    );
    expect([reversedFoc!.effect, reversedFoc!.costing]).toEqual(["receipt", "zero"]);
    const legs = planMovements(
      policy({
        effect: "transfer",
        warehouse: "header.warehouse",
        to_warehouse: "header.to_warehouse",
        costing: "zero",
      }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }),
    );
    expect(legs.map((mv) => [mv.effect, mv.costing])).toEqual([
      ["issue", "zero"],
      ["receipt", "zero"],
    ]);
  });

  it("a line warehouse overrides the header's; header.warehouse ignores the line's", () => {
    const perLine = planMovements(
      policy({ effect: "issue", warehouse: "line.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, warehouseId: "wh-branch" }), line({ lineNo: 2 })]),
    );
    expect(perLine.map((mv) => mv.warehouseId)).toEqual(["wh-branch", "wh-main"]);
    const perHeader = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, warehouseId: "wh-branch" })]),
    );
    expect(perHeader[0]!.warehouseId).toBe("wh-main");
  });

  it("a transfer emits two movements per line: warehouse leg first, always", () => {
    const plan = planMovements(
      policy({
        effect: "transfer",
        warehouse: "header.warehouse",
        to_warehouse: "header.to_warehouse",
        costing: "consume_layers",
      }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }),
    );
    expect(plan).toEqual([
      {
        lineNo: 1,
        movementNo: 1,
        itemId: product.id,
        warehouseId: "wh-main",
        lotId: null,
        quantity: Quantity.of("10.000000"),
        effect: "issue",
        value: null,
        costing: "consume_layers",
      },
      {
        lineNo: 1,
        movementNo: 2,
        itemId: product.id,
        warehouseId: "wh-transit",
        lotId: null,
        quantity: Quantity.of("10.000000"),
        effect: "receipt",
        value: null,
        costing: "create_layer",
      },
    ]);
  });

  it("a reversed transfer swaps the legs' effects and keeps the leg ORDER and the numbering", () => {
    const plan = planMovements(
      policy({
        effect: "transfer",
        warehouse: "header.warehouse",
        to_warehouse: "header.to_warehouse",
        costing: "consume_layers",
      }),
      snapshot([line({ lineNo: 1, quantity: Quantity.of("-10.000000") })], {
        toWarehouseId: "wh-transit",
      }),
    );
    expect(plan.map((mv) => [mv.movementNo, mv.warehouseId, mv.effect, mv.costing])).toEqual([
      [1, "wh-main", "receipt", "create_layer"],
      [2, "wh-transit", "issue", "consume_layers"],
    ]);
  });

  it("line.to_warehouse falls back to the header at 3A, because no line column exists (assumption 3)", () => {
    const plan = planMovements(
      policy({
        effect: "transfer",
        warehouse: "header.warehouse",
        to_warehouse: "line.to_warehouse",
        costing: "consume_layers",
      }),
      snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-transit" }),
    );
    expect(plan[1]!.warehouseId).toBe("wh-transit");
  });

  it("a service or asset line plans nothing and warns nothing (assumption 6)", () => {
    const plan = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, itemId: service.id }), line({ lineNo: 2 })]),
    );
    expect(plan.map((mv) => mv.lineNo)).toEqual([2]);
  });

  it("a zero quantity plans nothing — inventory_movement has check (quantity <> 0)", () => {
    expect(
      planMovements(
        policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
        snapshot([line({ lineNo: 1, quantity: Quantity.of("0.000000") })]),
      ),
    ).toEqual([]);
  });

  it("a product line with no quantity under a stock-moving effect is refused", () => {
    expect(() =>
      planMovements(
        policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
        snapshot([line({ lineNo: 1, quantity: null })]),
      ),
    ).toThrow(/line 1: quantity is required/);
  });

  it("a transfer whose two warehouses resolve to the same row is refused", () => {
    expect(() =>
      planMovements(
        policy({
          effect: "transfer",
          warehouse: "header.warehouse",
          to_warehouse: "header.to_warehouse",
          costing: "consume_layers",
        }),
        snapshot([line({ lineNo: 1 })], { toWarehouseId: "wh-main" }),
      ),
    ).toThrow(/a transfer needs two/);
  });

  it("a RECEIPT of a lot-tracked item must name its batch; an ISSUE need not", () => {
    expect(() =>
      planMovements(
        policy({ effect: "receipt", warehouse: "header.warehouse", costing: "create_layer" }),
        snapshot([line({ lineNo: 1, itemId: tracked.id })]),
      ),
    ).toThrow(/lot is required/);
    const issued = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1, itemId: tracked.id })]),
    );
    expect(issued[0]!.lotId).toBeNull(); // applyMovements resolves the NONE sentinel
  });

  it("a REVERSED receipt of a tracked item does not trip the lot gate", () => {
    const plan = planMovements(
      policy({ effect: "receipt", warehouse: "header.warehouse", costing: "create_layer" }),
      snapshot([
        line({
          lineNo: 1,
          itemId: tracked.id,
          quantity: Quantity.of("-6.000000"),
          lotId: "lot-1",
        }),
      ]),
    );
    expect(plan[0]!.effect).toBe("issue");
    expect(plan[0]!.lotId).toBe("lot-1");
    expect(plan[0]!.costing).toBe("consume_layers"); // rule 9 again, from the other direction
  });

  it("a stock-moving effect with costing 'none' is an invalid policy, not a movement", () => {
    expect(() =>
      planMovements(
        policy({ effect: "issue", warehouse: "header.warehouse", costing: "none" }),
        snapshot([line({ lineNo: 1 })]),
      ),
    ).toThrow(PolicyEvaluationError);
    expect(() =>
      planMovements(
        policy({ effect: "issue", warehouse: "header.warehouse", costing: "none" }),
        snapshot([line({ lineNo: 1 })]),
      ),
    ).toThrow(/ERR_POLICY_INVALID/);
  });

  it("evaluatePolicy now returns the movements instead of an empty array", () => {
    const plan = evaluatePolicy(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })]),
    );
    expect(plan.movements).toHaveLength(1);
    expect(plan.ledgerLines).toEqual([]); // this policy declares no `lines` rules
  });

  it("allowNegative is carried by the schema and read by nothing here (assumption 4)", () => {
    const permissive = planMovements(
      policy({
        effect: "issue",
        warehouse: "header.warehouse",
        costing: "consume_layers",
        allowNegative: true,
      }),
      snapshot([line({ lineNo: 1 })]),
    );
    const strict = planMovements(
      policy({ effect: "issue", warehouse: "header.warehouse", costing: "consume_layers" }),
      snapshot([line({ lineNo: 1 })]),
    );
    expect(permissive).toEqual(strict);
  });
});

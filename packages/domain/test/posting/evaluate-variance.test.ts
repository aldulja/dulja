import { describe, expect, it } from "vitest";
import { currency, Money, Quantity } from "../../src/index";
import {
  evaluatePolicy,
  lineMeetsARule,
  lineMeetsAVarianceRule,
  parsePolicy,
  quantitySignChosen,
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

/** A STOCK_COUNT-shaped policy: one movement per line, four ledger legs keyed on the variance sign. */
const COUNT_POLICY = parsePolicy({
  version: 1,
  documentType: "STOCK_COUNT",
  direction: "internal",
  requires: ["warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
  ],
  inventory: {
    effect: "receipt",
    warehouse: "line.warehouse",
    costing: "create_layer",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "SC", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_COUNT" },
  approval: {
    required: true,
    approve: "inventory.adjustment.approve",
    post: "inventory.adjustment.approve",
    create: "inventory.count.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
});

function countedLine(no: number, counted: string, expected: string): LineSnapshot {
  const q = Quantity.of(counted).subtract(Quantity.of(expected));
  return {
    id: `line-${no}`,
    lineNo: no,
    kind: "item",
    description: null,
    accountId: null,
    itemId: "item-1",
    quantity: q,
    unitPrice: null,
    discount: Money.zero(MYR),
    amount: Money.zero(MYR),
    taxCodeId: null,
    taxAmount: Money.zero(MYR),
    totalInclTax: Money.zero(MYR),
    debit: Money.zero(MYR),
    credit: Money.zero(MYR),
    cost: null,
    warehouseId: "wh-1",
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

function snapshot(lines: LineSnapshot[]): DocumentSnapshot {
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: "STOCK_COUNT",
      status: "issued",
      series: "SC",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-15",
      partyId: null,
      currency: MYR,
      exchangeRate: UNIT,
      branchId: "branch-hq",
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
      fxRoundingAccountId: "acct-5920",
      costingMethod: "avco",
    },
    party: null,
    refs: {
      accountsByCode: { "5110": "acct-5110" },
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

describe("evaluatePolicy — variance lines (ADR 0042; §4.4.2 as amended by 3D)", () => {
  it("a SURPLUS keeps the declared effect, plans a magnitude movement and tags both legs `cost`", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([countedLine(1, "12.000000", "10.000000")]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("receipt");
    expect(plan.movements[0]!.costing).toBe("create_layer");
    expect(plan.movements[0]!.quantity.toString()).toBe("2.000000");
    expect(plan.movements[0]!.warehouseId).toBe("wh-1");
    expect(plan.movements[0]!.value).toBeNull();
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId, l.fill])).toEqual([
      ["debit", "acct-1300", "cost"],
      ["credit", "acct-5110", "cost"],
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
  });

  it("a SHORTFALL flips effect AND costing, still plans a magnitude, and selects the other two legs", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([countedLine(1, "7.000000", "10.000000")]));
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("issue");
    expect(plan.movements[0]!.costing).toBe("consume_layers");
    expect(plan.movements[0]!.quantity.toString()).toBe("3.000000");
    expect(plan.ledgerLines.map((l) => [l.side, l.accountId])).toEqual([
      ["credit", "acct-1300"],
      ["debit", "acct-5110"],
    ]);
  });

  it("a MATCHING line plans no movement and no ledger line at all (spec:1052 'only the variance')", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([countedLine(1, "10.000000", "10.000000")]));
    expect(plan.movements).toEqual([]);
    expect(plan.ledgerLines).toEqual([]);
  });

  it("a null quantity plans nothing either — `check (quantity <> 0)` has no null branch", () => {
    const l = countedLine(1, "10.000000", "10.000000");
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([{ ...l, quantity: null }]));
    expect(plan.movements).toEqual([]);
    expect(plan.ledgerLines).toEqual([]);
  });

  it("an UNCOUNTED sheet line — expected snapshotted, counted still null — plans nothing (recordCounts)", () => {
    const l = countedLine(1, "10.000000", "10.000000");
    const plan = evaluatePolicy(
      COUNT_POLICY,
      snapshot([
        { ...l, quantity: null, countedQuantity: null },
        countedLine(2, "4.000000", "6.000000"),
      ]),
    );
    expect(plan.movements.map((m) => m.lineNo)).toEqual([2]);
    expect(plan.ledgerLines.every((ledger) => ledger.sourceLineNo === 2)).toBe(true);
  });

  it("a line with NEITHER count column and no quantity is still refused, as 3A wrote it", () => {
    const l = countedLine(1, "10.000000", "10.000000");
    expect(() =>
      evaluatePolicy(
        COUNT_POLICY,
        snapshot([{ ...l, quantity: null, countedQuantity: null, expectedQuantity: null }]),
      ),
    ).toThrow(/line 1: quantity is required by STOCK_COUNT's inventory.effect "receipt"/);
  });

  it("three lines, one with a variance: exactly one movement and two ledger legs, movementNo 1", () => {
    const plan = evaluatePolicy(
      COUNT_POLICY,
      snapshot([
        countedLine(1, "10.000000", "10.000000"),
        countedLine(2, "4.000000", "6.000000"),
        countedLine(3, "8.000000", "8.000000"),
      ]),
    );
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.lineNo).toBe(2);
    expect(plan.movements[0]!.movementNo).toBe(1);
    expect(plan.ledgerLines).toHaveLength(2);
    expect(plan.ledgerLines.every((l) => l.sourceLineNo === 2)).toBe(true);
  });

  it("the null-cost warning is one per SOURCE LINE, not one per rule (amendment A5)", () => {
    const plan = evaluatePolicy(COUNT_POLICY, snapshot([countedLine(1, "12.000000", "10.000000")]));
    expect(plan.warnings.filter((w) => w.startsWith("line 1:"))).toHaveLength(1);
  });
});

// Code review 2 (Phase 4), M1-X — `postDocument` step 6d admits a negative-quantity line on a stock policy
// outside a reversal only when the policy chose its direction from the sign, which this predicate answers.
describe("quantitySignChosen — whether every rule a line meets selects on line.quantity_sign", () => {
  const shortfall = countedLine(1, "8.000000", "10.000000"); // variance −2

  it("STOCK_COUNT's per-sign pairs chose the direction: true", () => {
    expect(quantitySignChosen(COUNT_POLICY, shortfall, snapshot([shortfall]))).toBe(true);
  });

  it("a rule the line meets without selecting on the sign (DELIVERY_ORDER's shape): false", () => {
    const delivery = parsePolicy({
      ...COUNT_POLICY,
      documentType: "DELIVERY_ORDER",
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
    });
    expect(quantitySignChosen(delivery, shortfall, snapshot([shortfall]))).toBe(false);
  });

  it("a rule with no `when` meets every line and selects on nothing: false", () => {
    const bare = parsePolicy({
      ...COUNT_POLICY,
      lines: [
        { for: "each_line", side: "debit", account: { code: "5110" }, amount: "line.cost" },
        { for: "each_line", side: "credit", account: { code: "5110" }, amount: "line.cost" },
      ],
    });
    expect(quantitySignChosen(bare, shortfall, snapshot([shortfall]))).toBe(false);
  });

  const accountRules = [
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ] as const;

  // This case expected `true` until the verification of M1-X: a line that meets NO rule was admitted
  // vacuously, and `planMovements` — which moves a line by its item, not its kind — still flipped its
  // movement with no ledger behind it. Meeting no rule is not choosing a sign.
  it("a line that meets no rule at all (only account-line rules, on an item line): false", () => {
    const accountOnly = parsePolicy({ ...COUNT_POLICY, lines: [...accountRules] });
    expect(quantitySignChosen(accountOnly, shortfall, snapshot([shortfall]))).toBe(false);
  });

  it("a rule whose `when` the line does not meet is not asked, beside rules that chose the sign: true", () => {
    const mixed = parsePolicy({
      ...COUNT_POLICY,
      lines: [...COUNT_POLICY.lines, ...accountRules],
    });
    expect(quantitySignChosen(mixed, shortfall, snapshot([shortfall]))).toBe(true);
  });
});

// Code review 3 (Phase 4), R4 — `postDocument` step 6e refuses a line that moves stock when no each_line rule
// of its policy meets it, whatever its sign; this predicate is that half of `quantitySignChosen`.
describe("lineMeetsARule — whether any each_line rule meets a line", () => {
  const surplus = countedLine(1, "12.000000", "10.000000"); // variance +2
  const accountRules = [
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ] as const;

  it("a rule the line meets, whether or not it selects on the sign: true", () => {
    expect(lineMeetsARule(COUNT_POLICY, surplus, snapshot([surplus]))).toBe(true);
  });

  it("only account-line rules, asked of an item line: false", () => {
    const accountOnly = parsePolicy({ ...COUNT_POLICY, lines: [...accountRules] });
    expect(lineMeetsARule(accountOnly, surplus, snapshot([surplus]))).toBe(false);
  });

  it("a rule with no `when` meets every line: true", () => {
    const bare = parsePolicy({
      ...COUNT_POLICY,
      lines: [
        { for: "each_line", side: "debit", account: { code: "5110" }, amount: "line.cost" },
        { for: "each_line", side: "credit", account: { code: "5110" }, amount: "line.cost" },
      ],
    });
    expect(lineMeetsARule(bare, surplus, snapshot([surplus]))).toBe(true);
  });

  it("a line whose sign matches no per-sign rule — a zero variance — meets none: false", () => {
    const matched = countedLine(1, "10.000000", "10.000000");
    expect(lineMeetsARule(COUNT_POLICY, matched, snapshot([matched]))).toBe(false);
  });
});

// Code review 3 (Phase 4), the verification of R3 — `postDocument` step 6e refuses a counted transfer line whose
// legs differ unless a rule it meets posts `line.variance_value`, the only reference §4.7.2's fill gives the
// difference between the two legs.
const itemRule = (side: "debit" | "credit", account: object, amount: string, sign?: string) => ({
  for: "each_line",
  side,
  account,
  amount,
  when:
    sign === undefined
      ? { "line.kind": "item" }
      : { "line.kind": "item", "line.quantity_sign": sign },
});

/** A TRANSFER_RECEIPT-shaped policy (two legs per line) over `lines`. */
const receiptLike = (lines: readonly object[]) =>
  parsePolicy({
    ...COUNT_POLICY,
    documentType: "TRANSFER_RECEIPT",
    requires: ["warehouse", "to_warehouse"],
    lines,
    inventory: {
      effect: "transfer",
      warehouse: "line.warehouse",
      to_warehouse: "header.to_warehouse",
      costing: "consume_layers",
      allowNegative: false,
    },
    reversal: { allowed: false, producesType: null },
  });

describe("lineMeetsAVarianceRule — whether a rule the line meets posts line.variance_value", () => {
  const arrived = [
    itemRule("debit", { from: "item.inventory_account" }, "line.cost"),
    itemRule("credit", { code: "1310" }, "line.cost"),
  ];
  const WITH_VARIANCE = receiptLike([
    ...arrived,
    itemRule("debit", { code: "5110" }, "line.variance_value", "negative"),
    itemRule("credit", { code: "1310" }, "line.variance_value", "negative"),
    itemRule("debit", { code: "1310" }, "line.variance_value", "positive"),
    itemRule("credit", { code: "5110" }, "line.variance_value", "positive"),
  ]);
  const ARRIVED_ONLY = receiptLike(arrived);
  const short = countedLine(1, "8.000000", "10.000000");
  const over = countedLine(1, "12.000000", "10.000000");

  it("TRANSFER_RECEIPT's variance pairs, asked of a short and an over arrival: true", () => {
    expect(lineMeetsAVarianceRule(WITH_VARIANCE, short, snapshot([short]))).toBe(true);
    expect(lineMeetsAVarianceRule(WITH_VARIANCE, over, snapshot([over]))).toBe(true);
  });

  it("rules that name line.cost alone — the arrived pair, or STOCK_COUNT's four: false", () => {
    expect(lineMeetsAVarianceRule(ARRIVED_ONLY, short, snapshot([short]))).toBe(false);
    expect(lineMeetsAVarianceRule(COUNT_POLICY, over, snapshot([over]))).toBe(false);
  });

  it("an exact arrival meets neither per-sign variance pair: false, and step 6e does not ask it", () => {
    const exact = countedLine(1, "10.000000", "10.000000");
    expect(lineMeetsAVarianceRule(WITH_VARIANCE, exact, snapshot([exact]))).toBe(false);
  });
});

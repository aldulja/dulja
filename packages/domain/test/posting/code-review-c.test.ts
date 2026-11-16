import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currency, Money, Quantity, type CurrencyCode } from "../../src/index";
import {
  balanceInBase,
  evaluatePolicy,
  parsePolicy,
  type DocumentSnapshot,
  type LineSnapshot,
  type PostingPlan,
  type PostingPolicy,
} from "../../src/posting";

const MYR = currency("MYR");
const USD = currency("USD");

function line(over: Partial<LineSnapshot>): LineSnapshot {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    lineNo: 1,
    kind: "item",
    description: null,
    accountId: null,
    itemId: "item-1",
    quantity: Quantity.of("1.000000"),
    unitPrice: Money.of("1.0000", MYR),
    discount: Money.zero(MYR),
    amount: Money.of("1.0000", MYR),
    taxCodeId: null,
    taxAmount: Money.zero(MYR),
    totalInclTax: Money.of("1.0000", MYR),
    debit: Money.zero(MYR),
    credit: Money.zero(MYR),
    cost: null,
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

function snapshot(
  lines: LineSnapshot[],
  over: { currency?: CurrencyCode; rate?: string; documentTypeCode?: string } = {},
): DocumentSnapshot {
  const docCurrency: CurrencyCode = over.currency ?? MYR;
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: over.documentTypeCode ?? "TEST",
      status: "issued",
      series: "T",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-10",
      partyId: null,
      currency: docCurrency,
      exchangeRate: {
        from: docCurrency,
        to: MYR,
        rate: over.rate ?? "1.00000000",
        effectiveFrom: "2026-01-01",
        source: docCurrency === MYR ? "unit" : "test",
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
    party: null,
    refs: {
      accountsByCode: { "1200": "acc-1200", "4000": "acc-4000", "5110": "acc-5110" },
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

const fxLines = (plan: PostingPlan) =>
  plan.ledgerLines
    .filter((l) => l.role === "fx_rounding")
    .map((l) => [l.accountId, l.side, l.amount.toString(), l.amount.currency]);

const sides = (plan: PostingPlan) =>
  plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()]);

/** What `applyMovements` does to a tagged line (§4.7.2): the costing engine's magnitude replaces the
 *  stand-in zero on BOTH `amount` and `base`, and the side is never altered. */
function fillCosts(plan: PostingPlan, cost: string): PostingPlan {
  return {
    ...plan,
    ledgerLines: plan.ledgerLines.map((l) =>
      l.fill === undefined ? l : { ...l, amount: Money.of(cost, MYR), base: Money.of(cost, MYR) },
    ),
  };
}

/**
 * Finding C2. A foreign-currency type whose policy lines do not pair line for line — revenue credited per
 * line, the receivable debited once from the document total — leaves a base rounding residue, and step 6
 * absorbs it with a base-currency `fx_rounding` line. Its cost legs are base too, and paired. Step 9a
 * (`postDocument`) runs `balanceInBase` again on the FILLED plan: the per-currency check then saw the MYR
 * group as the paired cost legs plus that one `fx_rounding` line, which has no partner, and refused the
 * posting with ERR_LEDGER_UNBALANCED.
 */
describe("C2 — balanceInBase re-derives an earlier fx_rounding line instead of checking it", () => {
  const UNPAIRED = {
    version: 1,
    documentType: "USD_ISSUE_TEST",
    direction: "outbound",
    requires: [],
    lines: [
      {
        for: "document",
        side: "debit",
        account: { code: "1200" },
        amount: "document.total_excl_tax",
      },
      {
        for: "each_line",
        side: "credit",
        account: { code: "4000" },
        amount: "line.amount",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "debit",
        account: { from: "item.cogs_account" },
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
    numbering: { series: "UIT", assignAt: "issue" },
    reversal: { allowed: false, producesType: null },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: [] },
  } as unknown as PostingPolicy;

  // Two lines of USD 1.0000 at 4.12345678: each converts to 4.1235, the document total of 2.0000 to 8.2469,
  // so the per-line conversion leaves a base residue of −0.0001.
  const usdLine = (lineNo: number) =>
    line({
      id: `00000000-0000-0000-0000-00000000000${lineNo}`,
      lineNo,
      unitPrice: Money.of("1.0000", USD),
      amount: Money.of("1.0000", USD),
      discount: Money.zero(USD),
      taxAmount: Money.zero(USD),
      totalInclTax: Money.of("1.0000", USD),
      debit: Money.zero(USD),
      credit: Money.zero(USD),
    });
  const usd = snapshot([usdLine(1), usdLine(2)], { currency: USD, rate: "4.12345678" });
  const step6 = () => balanceInBase(evaluatePolicy(UNPAIRED, usd), "acc-5920", MYR);

  it("step 6 absorbs the residue with ONE base-currency fx_rounding line (the premise)", () => {
    expect(fxLines(step6())).toEqual([["acc-5920", "debit", "0.0001", "MYR"]]);
  });

  it("step 9a's re-balance of the filled plan posts, with exactly one fx_rounding line of the same figure", () => {
    const filled = fillCosts(step6(), "3.0000");
    const rebalanced = balanceInBase(filled, "acc-5920", MYR);
    expect(fxLines(rebalanced)).toEqual([["acc-5920", "debit", "0.0001", "MYR"]]);
    // …and the plan balances in base, to the last minor unit.
    const total = (side: "debit" | "credit") =>
      rebalanced.ledgerLines
        .filter((l) => l.side === side)
        .reduce<Money>((sum, l) => sum.add(l.base), Money.zero(MYR))
        .toString();
    expect(total("debit")).toBe(total("credit"));
  });

  it("the re-derived line never collides with a surviving line's number", () => {
    const rebalanced = balanceInBase(fillCosts(step6(), "3.0000"), "acc-5920", MYR);
    const numbers = rebalanced.ledgerLines.map((l) => l.lineNo);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("re-balancing is idempotent: a balanced plan run through again is the same plan", () => {
    const once = balanceInBase(fillCosts(step6(), "3.0000"), "acc-5920", MYR);
    expect(balanceInBase(once, "acc-5920", MYR)).toEqual(once);
  });

  it("an unbalanced FILLED plan is still refused — the earlier line is re-derived, never trusted", () => {
    const filled = fillCosts(step6(), "3.0000");
    // An ill-formed policy's fill: one cost leg filled with a different magnitude than its partner.
    const skewed: PostingPlan = {
      ...filled,
      ledgerLines: filled.ledgerLines.map((l, i) =>
        i === filled.ledgerLines.findIndex((x) => x.fill !== undefined)
          ? { ...l, amount: Money.of("3.5000", MYR), base: Money.of("3.5000", MYR) }
          : l,
      ),
    };
    expect(() => balanceInBase(skewed, "acc-5920", MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
  });
});

/**
 * Finding C3. ADR 0045 negates a known cost on a negative-quantity line, and A9 then swaps the rule's side.
 * STOCK_COUNT already picks its direction with `line.quantity_sign` rules, so a reversal's mirror line —
 * negative quantity, the original's cost copied positive — matched the `negative` rules (credit inventory,
 * debit 5110) and then had its cost negated, which swapped them back to debit inventory / credit 5110 while
 * the movement issues the stock. The seed file is read, not restated, so the case follows the real policy.
 */
describe("C3 — a rule that selects on line.quantity_sign has already chosen the direction", () => {
  const STOCK_COUNT = parsePolicy(
    (
      JSON.parse(
        readFileSync(
          fileURLToPath(
            new URL("../../../db/seed/my/document-types/STOCK_COUNT.json", import.meta.url),
          ),
          "utf8",
        ),
      ) as { policy: unknown }
    ).policy,
  );
  const counted = snapshot([], { documentTypeCode: "STOCK_COUNT" });
  const count = (over: Partial<LineSnapshot>) =>
    evaluatePolicy(STOCK_COUNT, { ...counted, lines: [line(over)] });

  it("the reversal of a count SURPLUS credits inventory and debits 5110, matching the issue it plans", () => {
    // The mirror of a surplus line: quantity −3 (reverse.ts negates it), cost 12.0000 copied unnegated.
    const plan = count({ quantity: Quantity.of("-3.000000"), cost: Money.of("12.0000", MYR) });
    expect(sides(plan)).toEqual([
      ["acc-1300", "credit", "12.0000"],
      ["acc-5110", "debit", "12.0000"],
    ]);
    expect(plan.movements.map((m) => [m.effect, m.quantity.toString()])).toEqual([
      ["issue", "3.000000"],
    ]);
  });

  it("the reversal of a count DEFICIT debits inventory and credits 5110, matching the receipt it plans", () => {
    const plan = count({ quantity: Quantity.of("3.000000"), cost: Money.of("12.0000", MYR) });
    expect(sides(plan)).toEqual([
      ["acc-1300", "debit", "12.0000"],
      ["acc-5110", "credit", "12.0000"],
    ]);
    expect(plan.movements.map((m) => m.effect)).toEqual(["receipt"]);
  });

  it("at post, with the cost not yet computed, both directions keep the policy's own sides (A5)", () => {
    expect(sides(count({ quantity: Quantity.of("-3.000000") }))).toEqual([
      ["acc-1300", "credit", "0.0000"],
      ["acc-5110", "debit", "0.0000"],
    ]);
    expect(sides(count({ quantity: Quantity.of("3.000000") }))).toEqual([
      ["acc-1300", "debit", "0.0000"],
      ["acc-5110", "credit", "0.0000"],
    ]);
  });

  it("a rule that does NOT select on the sign still negates the cost of a negative line (ADR 0045)", () => {
    const fixedSides = {
      ...STOCK_COUNT,
      lines: STOCK_COUNT.lines
        .filter((r) => r.when?.["line.quantity_sign"] === "positive")
        .map((r) => ({ ...r, when: { "line.kind": "item" } })),
    } as PostingPolicy;
    const plan = evaluatePolicy(fixedSides, {
      ...counted,
      lines: [line({ quantity: Quantity.of("-3.000000"), cost: Money.of("12.0000", MYR) })],
    });
    expect(sides(plan)).toEqual([
      ["acc-1300", "credit", "12.0000"],
      ["acc-5110", "debit", "12.0000"],
    ]);
  });
});

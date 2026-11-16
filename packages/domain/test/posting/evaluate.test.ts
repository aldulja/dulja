import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { currency, Money, UNIT_RATE, type CurrencyCode } from "../../src";
import {
  balanceInBase,
  evaluatePolicy,
  parsePolicy,
  validateRequires,
  type DocumentSnapshot,
  type LineSnapshot,
  type PolicyEvaluationError,
} from "../../src/posting";

const MYR = currency("MYR");
const USD = currency("USD");
const POLICY = parsePolicy(
  (
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("./journal-envelope.fixture.json", import.meta.url)),
        "utf8",
      ),
    ) as { policy: unknown }
  ).policy,
);

const line = (over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot => ({
  id: `line-${over.lineNo}`,
  kind: "account",
  description: null,
  accountId: "acct-cash",
  itemId: null,
  quantity: null,
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
});

const snapshot = (
  lines: LineSnapshot[],
  over: Partial<DocumentSnapshot["header"]> = {},
): DocumentSnapshot => ({
  header: {
    id: "doc-1",
    companyId: "co-1",
    documentTypeCode: "JOURNAL",
    status: "draft",
    series: "JV",
    fiscalPeriodId: "per-1",
    number: null,
    effectiveDate: "2026-01-15",
    partyId: null,
    currency: MYR,
    exchangeRate: UNIT_RATE(MYR),
    branchId: "branch-hq",
    attributedTo: null,
    clientRef: null,
    warehouseId: null,
    toWarehouseId: null,
    taxInclusive: false,
    reversesDocumentId: null,
    customFields: {},
    ...over,
  },
  lines,
  company: {
    id: "co-1",
    baseCurrency: MYR,
    fxRoundingAccountId: "acct-fx",
    costingMethod: "avco",
  },
  party: null,
  refs: {
    accountsByCode: {},
    items: {},
    taxCodes: {},
    components: {},
    schemes: {},
    dimensionTypesByCode: { BRANCH: "dt-branch" },
  },
});

describe("evaluatePolicy — the JOURNAL subset (contracts §4.4.2)", () => {
  it("emits one ledger line per non-zero side, tagged BRANCH from the header", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, accountId: "acct-cash", debit: Money.of("100.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("100.0000", MYR) }),
      ]),
    );
    expect(plan.ledgerLines).toEqual([
      {
        lineNo: 1,
        accountId: "acct-cash",
        side: "debit",
        amount: Money.of("100.0000", MYR),
        base: Money.of("100.0000", MYR),
        dimensions: { BRANCH: "branch-hq" },
        sourceLineNo: 1,
        role: "policy",
      },
      {
        lineNo: 2,
        accountId: "acct-sales",
        side: "credit",
        amount: Money.of("100.0000", MYR),
        base: Money.of("100.0000", MYR),
        dimensions: { BRANCH: "branch-hq" },
        sourceLineNo: 2,
        role: "policy",
      },
    ]);
    expect(plan.movements).toEqual([]);
    expect(plan.taxLines).toEqual([]);
  });

  it("drops a zero-amount planned line rather than writing a 0/0 ledger row (§4.3.2 step 6)", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, debit: Money.of("50.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("50.0000", MYR) }),
        line({ lineNo: 3, accountId: "acct-note", description: "narration only" }),
      ]),
    );
    expect(plan.ledgerLines.map((planned) => planned.sourceLineNo)).toEqual([1, 2]);
  });

  it("keeps a line's own dimensions and adds BRANCH, which always wins", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({
          lineNo: 1,
          debit: Money.of("1.0000", MYR),
          dimensions: { COSTCENTRE: "cc-1", BRANCH: "branch-forged" },
        }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("1.0000", MYR) }),
      ]),
    );
    expect(plan.ledgerLines[0]!.dimensions).toEqual({
      COSTCENTRE: "cc-1",
      BRANCH: "branch-hq",
    });
  });

  it("normalises the sign: a negative resolved amount flips the side and keeps the magnitude (§4.4.2 A9)", () => {
    // Unreachable through `loadSnapshot` at the JOURNAL subset — migration 0011 constrains
    // `document_line.debit >= 0` and `credit >= 0` — so the snapshot is built by hand. The assertion is that
    // `evaluatePolicy` itself owns the rule, because 2A widens `amountRef` with `line.amount` / `line.cost`
    // and extends this same `for` switch, and `app.ledger_entry`'s `check (debit >= 0)` accepts nothing else.
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, debit: Money.of("-40.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("-40.0000", MYR) }),
      ]),
    );
    expect(
      plan.ledgerLines.map((planned) => [
        planned.side,
        planned.amount.toString(),
        planned.base.toString(),
      ]),
    ).toEqual([
      ["credit", "40.0000", "40.0000"], // the debit rule emitted a credit
      ["debit", "40.0000", "40.0000"], // the credit rule emitted a debit
    ]);
    expect(plan.ledgerLines.every((planned) => !planned.amount.isNegative())).toBe(true);
  });

  it("converts to base with round(value × rate, 4) HALF_AWAY_FROM_ZERO (spec:1816)", () => {
    const rate = {
      from: USD,
      to: MYR,
      rate: "4.68350000",
      effectiveFrom: "2026-01-01",
      source: "BNM 2026-01-01",
    };
    const plan = evaluatePolicy(
      POLICY,
      snapshot(
        [
          line({
            lineNo: 1,
            debit: Money.of("33.3350", USD),
            amount: Money.zero(USD),
            discount: Money.zero(USD),
            credit: Money.zero(USD),
            taxAmount: Money.zero(USD),
            totalInclTax: Money.zero(USD),
          }),
          line({
            lineNo: 2,
            accountId: "acct-sales",
            credit: Money.of("33.3350", USD),
            amount: Money.zero(USD),
            discount: Money.zero(USD),
            debit: Money.zero(USD),
            taxAmount: Money.zero(USD),
            totalInclTax: Money.zero(USD),
          }),
        ],
        { currency: USD, exchangeRate: rate },
      ),
    );
    // 33.3350 × 4.68350000 = 156.1244725, HALF_AWAY_FROM_ZERO at scale 4
    expect(plan.ledgerLines[0]!.base.toString()).toBe("156.1245");
  });

  it("refuses a policy that names an account code the company cannot resolve", () => {
    const withCode = parsePolicy({
      ...(POLICY as unknown as Record<string, unknown>),
      lines: [{ for: "each_line", side: "debit", account: { code: "9999" }, amount: "line.debit" }],
    });
    expect(() =>
      evaluatePolicy(withCode, snapshot([line({ lineNo: 1, debit: Money.of("1.0000", MYR) })])),
    ).toThrow(/ERR_POLICY_REQUIRES_MISSING/);
  });

  it("refuses a required dimension type no line carries", () => {
    const withDim = parsePolicy({
      ...(POLICY as unknown as Record<string, unknown>),
      dimensions: { required: ["COSTCENTRE"] },
    });
    let caught: unknown;
    try {
      evaluatePolicy(
        withDim,
        snapshot([
          line({ lineNo: 1, debit: Money.of("1.0000", MYR) }),
          line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("1.0000", MYR) }),
        ]),
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as PolicyEvaluationError).code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect((caught as PolicyEvaluationError).detail).toContain("COSTCENTRE");
  });
});

describe("validateRequires — contracts §4.3.2 step 4", () => {
  it("names every missing field and nothing else", () => {
    const policy = parsePolicy({
      ...(POLICY as unknown as Record<string, unknown>),
      requires: ["party", "client_ref"],
    });
    expect(validateRequires(policy, snapshot([]))).toEqual({ missing: ["party", "client_ref"] });
    expect(validateRequires(policy, snapshot([], { partyId: "p-1", clientRef: "c-1" }))).toEqual({
      missing: [],
    });
  });
});

describe("balanceInBase — the FX-rounding line (spec:1868)", () => {
  const rate = {
    from: USD,
    to: MYR,
    rate: "4.68350000",
    effectiveFrom: "2026-01-01",
    source: "BNM 2026-01-01",
  };
  const residueLines = () => [
    line({
      lineNo: 1,
      debit: Money.of("0.0003", USD),
      amount: Money.zero(USD),
      credit: Money.zero(USD),
      discount: Money.zero(USD),
      taxAmount: Money.zero(USD),
      totalInclTax: Money.zero(USD),
    }),
    line({
      lineNo: 2,
      accountId: "acct-b",
      credit: Money.of("0.0001", USD),
      amount: Money.zero(USD),
      debit: Money.zero(USD),
      discount: Money.zero(USD),
      taxAmount: Money.zero(USD),
      totalInclTax: Money.zero(USD),
    }),
    line({
      lineNo: 3,
      accountId: "acct-c",
      credit: Money.of("0.0001", USD),
      amount: Money.zero(USD),
      debit: Money.zero(USD),
      discount: Money.zero(USD),
      taxAmount: Money.zero(USD),
      totalInclTax: Money.zero(USD),
    }),
    line({
      lineNo: 4,
      accountId: "acct-d",
      credit: Money.of("0.0001", USD),
      amount: Money.zero(USD),
      debit: Money.zero(USD),
      discount: Money.zero(USD),
      taxAmount: Money.zero(USD),
      totalInclTax: Money.zero(USD),
    }),
  ];

  it("returns the plan untouched when base already balances", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, debit: Money.of("10.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("10.0000", MYR) }),
      ]),
    );
    expect(balanceInBase(plan, "acct-fx", MYR)).toBe(plan);
  });

  /**
   * The fixture below is chosen because it actually LEAVES a residue, which most three-line splits do not.
   * At 4.68350000 the obvious 0.3335 = 0.1667 + 0.1668 converts to 1.5619 = 0.7807 + 0.7812 — exactly
   * balanced, `balanceInBase` returns the plan untouched, and every assertion here would fail on a correct
   * implementation. These numbers do leave one:
   *   debit  0.0003 × 4.68350000 = 0.00140505 → 0.0014
   *   credit 0.0001 × 4.68350000 = 0.00046835 → 0.0005, three of them → 0.0015
   *   residue = 0.0014 − 0.0015 = −0.0001, inside the 0.0001 × 4 tolerance, so exactly one fx_rounding
   *   DEBIT line of 0.0001 MYR is appended (residue is negative → the side is "debit").
   */
  it("appends one fx_rounding line for a rounding residue and the plan then balances in base", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot(residueLines(), { currency: USD, exchangeRate: rate }),
    );
    expect(plan.ledgerLines).toHaveLength(4);
    const balanced = balanceInBase(plan, "acct-fx", MYR);
    expect(balanced.ledgerLines).toHaveLength(5);
    const fx = balanced.ledgerLines.at(-1)!;
    expect(fx.role).toBe("fx_rounding");
    expect(fx.accountId).toBe("acct-fx");
    expect(fx.side).toBe("debit");
    expect(fx.amount.currency).toBe(MYR);
    expect(fx.amount.toString()).toBe("0.0001");
    expect(fx.amount.equals(fx.base)).toBe(true);
    const debit = balanced.ledgerLines
      .filter((planned) => planned.side === "debit")
      .reduce((total, planned) => total.add(planned.base), Money.zero<CurrencyCode>(MYR));
    const credit = balanced.ledgerLines
      .filter((planned) => planned.side === "credit")
      .reduce((total, planned) => total.add(planned.base), Money.zero<CurrencyCode>(MYR));
    expect(debit.equals(credit)).toBe(true);
  });

  it("throws ERR_LEDGER_UNBALANCED when the residue is real, not rounding", () => {
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, debit: Money.of("100.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("90.0000", MYR) }),
      ]),
    );
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
  });

  it("refuses a same-currency journal that is out by one sen — a residue the old 0.01 × lines bound let through", () => {
    // At rate 1 no rounding can occur, so ANY residue is a wrong document. 100.0000 / 99.9900 differs by
    // 0.0100, inside the former tolerance of 0.02 for two lines; it must never post with an fx_rounding line.
    const plan = evaluatePolicy(
      POLICY,
      snapshot([
        line({ lineNo: 1, debit: Money.of("100.0000", MYR) }),
        line({ lineNo: 2, accountId: "acct-sales", credit: Money.of("99.9900", MYR) }),
      ]),
    );
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(/do not balance/);
  });

  it("refuses a foreign-currency journal that is out in its OWN currency even when the base residue is tiny", () => {
    // 0.0003 USD debit against 0.0002 USD credit: base residue is ≈ 0.0005 MYR, inside any rounding bound,
    // but the document itself does not balance and the first check refuses it before the base is looked at.
    const plan = evaluatePolicy(
      POLICY,
      snapshot(
        [
          line({
            lineNo: 1,
            debit: Money.of("0.0003", USD),
            amount: Money.zero(USD),
            credit: Money.zero(USD),
            discount: Money.zero(USD),
            taxAmount: Money.zero(USD),
            totalInclTax: Money.zero(USD),
          }),
          line({
            lineNo: 2,
            accountId: "acct-b",
            credit: Money.of("0.0002", USD),
            amount: Money.zero(USD),
            debit: Money.zero(USD),
            discount: Money.zero(USD),
            taxAmount: Money.zero(USD),
            totalInclTax: Money.zero(USD),
          }),
        ],
        { currency: USD, exchangeRate: rate },
      ),
    );
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(/do not balance/);
  });

  it("throws ERR_LEDGER_UNBALANCED when the company has no fx_rounding account", () => {
    // Same residue-leaving fixture as the fx_rounding test above — a fixture that balances exactly would
    // return early from balanceInBase and never reach the fxRoundingAccountId check at all.
    const plan = evaluatePolicy(
      POLICY,
      snapshot(residueLines(), { currency: USD, exchangeRate: rate }),
    );
    expect(() => balanceInBase(plan, null, MYR)).toThrow(/ERR_LEDGER_UNBALANCED/);
  });
});

/** The JOURNAL envelope's policy object, as a plain bag the cases below spread and override. */
const JOURNAL_SHAPED = POLICY as unknown as Record<string, unknown>;

/** `snapshot` with the two chart codes a cost policy names resolved — the helper above takes header
 *  overrides only, and `resolveAccount` reads a literal code out of `refs.accountsByCode`. */
const costSnapshot = (
  lines: LineSnapshot[],
  over: Partial<DocumentSnapshot["header"]> = {},
): DocumentSnapshot => {
  const s = snapshot(lines, over);
  return {
    ...s,
    refs: { ...s.refs, accountsByCode: { "5000": "acct-cogs", "1300": "acct-inventory" } },
  };
};

const USD_AT_468 = {
  from: USD,
  to: MYR,
  rate: "4.68000000",
  effectiveFrom: "2026-01-01",
  source: "BNM 2026-01-01",
};

const COST_POLICY = parsePolicy({
  ...JOURNAL_SHAPED,
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "5000" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "1300" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
});

/** A USD item line at 100.0000 whose cost, if any, is already a MYR figure. */
const usdItemLine = (cost: Money | null): LineSnapshot =>
  line({
    lineNo: 1,
    kind: "item",
    itemId: "item-1",
    amount: Money.of("100.0000", USD),
    discount: Money.zero(USD),
    taxAmount: Money.zero(USD),
    totalInclTax: Money.of("100.0000", USD),
    debit: Money.zero(USD),
    credit: Money.zero(USD),
    cost,
  });

describe('a cost amount reference is tagged role: "cost" and never converted (amendment A4)', () => {
  it("tags the line and copies the amount into base rather than calling toBase", () => {
    // A USD document at 4.68 whose line already carries a MYR cost.
    const plan = evaluatePolicy(
      COST_POLICY,
      costSnapshot([usdItemLine(Money.of("468.0000", MYR))], {
        currency: USD,
        exchangeRate: USD_AT_468,
      }),
    );
    expect(
      plan.ledgerLines.map((l) => [
        l.role,
        l.side,
        l.amount.toString(),
        l.amount.currency,
        l.base.toString(),
      ]),
    ).toEqual([
      ["cost", "debit", "468.0000", "MYR", "468.0000"],
      ["cost", "credit", "468.0000", "MYR", "468.0000"],
    ]);
  });

  it("a null cost still emits at zero, in BASE currency, and still warns once per source line (A5 unchanged)", () => {
    const plan = evaluatePolicy(
      COST_POLICY,
      costSnapshot([usdItemLine(null)], { currency: USD, exchangeRate: USD_AT_468 }),
    );
    expect(plan.ledgerLines).toHaveLength(2);
    expect(
      plan.ledgerLines.every(
        (l) => l.role === "cost" && l.amount.isZero() && l.amount.currency === MYR,
      ),
    ).toBe(true);
    expect(plan.warnings).toEqual([
      "line 1: cost is not yet computed; the costing engine fills it at post",
    ]);
  });

  it('a non-cost reference is untouched — still role: "policy", still converted at the header rate', () => {
    const policy = parsePolicy({
      ...JOURNAL_SHAPED,
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { code: "5000" },
          amount: "line.amount",
          when: { "line.kind": "item" },
        },
      ],
    });
    const [ledgerLine] = evaluatePolicy(
      policy,
      costSnapshot([usdItemLine(null)], { currency: USD, exchangeRate: USD_AT_468 }),
    ).ledgerLines;
    expect([
      ledgerLine!.role,
      ledgerLine!.amount.currency,
      ledgerLine!.amount.toString(),
      ledgerLine!.base.toString(),
    ]).toEqual(["policy", USD, "100.0000", "468.0000"]);
  });
});

describe("balanceInBase — a foreign-currency plan with cost legs balances per currency (4A Task 6)", () => {
  /** SALES_INVOICE's shape: AR against revenue at the document's amount, COGS against 1250 at the copied cost. */
  const INVOICE_POLICY = parsePolicy({
    ...JOURNAL_SHAPED,
    lines: [
      {
        for: "each_line",
        side: "debit",
        account: { code: "1200" },
        amount: "line.total_incl_tax",
        when: { "line.kind": "item" },
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
        account: { code: "5000" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { code: "1250" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
    ],
  });
  const invoiceSnapshot = (lines: LineSnapshot[]): DocumentSnapshot => {
    const s = snapshot(lines, { currency: USD, exchangeRate: USD_AT_468 });
    return {
      ...s,
      refs: {
        ...s.refs,
        accountsByCode: {
          "1200": "acct-ar",
          "4000": "acct-revenue",
          "5000": "acct-cogs",
          "1250": "acct-gdni",
        },
      },
    };
  };

  it("posts USD legs converted at the rate and MYR cost legs at rate 1, with no residue and no mismatch", () => {
    // Before the per-currency check this raised ERR_MONEY_CURRENCY_MISMATCH out of Money.add: the plan's
    // first line is USD and the cost lines are MYR (amendment A4), and one reduce summed all four.
    const plan = evaluatePolicy(
      INVOICE_POLICY,
      invoiceSnapshot([usdItemLine(Money.of("300.0000", MYR))]),
    );
    const balanced = balanceInBase(plan, "acct-fx", MYR);
    expect(balanced).toBe(plan); // 468.0000 + 300.0000 on each side: nothing to absorb
    expect(
      balanced.ledgerLines.map((l) => [
        l.accountId,
        l.side,
        l.amount.currency,
        l.amount.toString(),
        l.base.toString(),
      ]),
    ).toEqual([
      ["acct-ar", "debit", USD, "100.0000", "468.0000"],
      ["acct-revenue", "credit", USD, "100.0000", "468.0000"],
      ["acct-cogs", "debit", MYR, "300.0000", "300.0000"],
      ["acct-gdni", "credit", MYR, "300.0000", "300.0000"],
    ]);
  });

  it("still refuses a plan that is out in the DOCUMENT currency, naming that currency", () => {
    const plan = evaluatePolicy(
      INVOICE_POLICY,
      invoiceSnapshot([
        { ...usdItemLine(Money.of("300.0000", MYR)), totalInclTax: Money.of("100.0100", USD) },
      ]),
    );
    expect(() => balanceInBase(plan, "acct-fx", MYR)).toThrow(
      /ERR_LEDGER_UNBALANCED: debits 100\.0100 and credits 100\.0000 USD do not balance/,
    );
  });

  it("refuses a plan whose BASE cost group is out, even when the document-currency group balances", () => {
    const plan = evaluatePolicy(
      INVOICE_POLICY,
      invoiceSnapshot([usdItemLine(Money.of("300.0000", MYR))]),
    );
    const skewed = {
      ...plan,
      ledgerLines: plan.ledgerLines.map((l) =>
        l.accountId === "acct-gdni" ? { ...l, amount: Money.of("299.9900", MYR) } : l,
      ),
    };
    expect(() => balanceInBase(skewed, "acct-fx", MYR)).toThrow(
      /ERR_LEDGER_UNBALANCED: debits 300\.0000 and credits 299\.9900 MYR do not balance/,
    );
  });
});

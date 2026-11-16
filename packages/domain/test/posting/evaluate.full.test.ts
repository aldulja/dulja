import { describe, expect, it } from "vitest";
import { currency, Money, Quantity, UNIT_RATE } from "../../src";
import {
  evaluatePolicy,
  parsePolicy,
  validateRequires,
  type DocumentSnapshot,
  type ItemRef,
  type LineSnapshot,
  type PayComponentRef,
  type PostingPolicy,
  type SchemeRef,
  type TaxCodeRef,
} from "../../src/posting";

/** A SALES_INVOICE-shaped policy with the members under test overridden. Module-scoped: it captures nothing. */
const policy = (over: Record<string, unknown> = {}): PostingPolicy =>
  parsePolicy({
    version: 1,
    documentType: "SALES_INVOICE",
    direction: "outbound",
    requires: [],
    lines: [],
    inventory: { effect: "none" },
    tax: { applies: false },
    numbering: { series: "INV", assignAt: "issue" },
    reversal: { allowed: true, producesType: "SALES_CREDIT_NOTE" },
    approval: { required: false, approve: null, post: "accounting.journal.post" },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    ...over,
  });

/** 2A Task 6 — the evaluator over every member ADR 0026's schema admits. Kept beside 1A's JOURNAL-subset
 *  file rather than inside it so the two files' fixture helpers do not shadow each other. */
describe("evaluatePolicy over the whole schema — contracts §4.4.2, ADR 0026", () => {
  const MYR = currency("MYR");
  const m = (v: string): Money => Money.of(v, MYR);
  const ids = {
    company: "00000000-0000-7000-8000-000000000001",
    branch: "00000000-0000-7000-8000-000000000002",
    recv: "00000000-0000-7000-8000-000000000003",
    pay: "00000000-0000-7000-8000-000000000004",
    revenue: "00000000-0000-7000-8000-000000000005",
    inventory: "00000000-0000-7000-8000-000000000006",
    cogs: "00000000-0000-7000-8000-000000000007",
    output: "00000000-0000-7000-8000-000000000008",
    fx: "00000000-0000-7000-8000-000000000009",
    item: "00000000-0000-7000-8000-00000000000a",
    tax: "00000000-0000-7000-8000-00000000000b",
    suspense: "00000000-0000-7000-8000-00000000000c",
    project: "00000000-0000-7000-8000-00000000000d",
    employeeDim: "00000000-0000-7000-8000-00000000000e",
    zeroTax: "00000000-0000-7000-8000-00000000000f",
  };

  const line = (over: Partial<LineSnapshot> = {}): LineSnapshot => ({
    id: `l${over.lineNo ?? 1}`,
    lineNo: over.lineNo ?? 1,
    kind: "item",
    description: null,
    accountId: null,
    itemId: ids.item,
    quantity: Quantity.of("2.000000"),
    unitPrice: m("50.0000"),
    discount: m("0.0000"),
    amount: m("100.0000"),
    taxCodeId: ids.tax,
    taxAmount: m("6.0000"),
    totalInclTax: m("106.0000"),
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
  });

  const snapshot = (over: Partial<DocumentSnapshot> = {}): DocumentSnapshot => ({
    header: {
      id: "d1",
      companyId: ids.company,
      documentTypeCode: "SALES_INVOICE",
      status: "issued",
      series: "INV",
      fiscalPeriodId: "p1",
      number: 1n,
      effectiveDate: "2026-01-15",
      partyId: "party-1",
      currency: MYR,
      exchangeRate: UNIT_RATE(MYR),
      branchId: ids.branch,
      attributedTo: null,
      clientRef: null,
      warehouseId: null,
      toWarehouseId: null,
      taxInclusive: false,
      reversesDocumentId: null,
      customFields: {},
    },
    lines: [line()],
    company: {
      id: ids.company,
      baseCurrency: MYR,
      fxRoundingAccountId: ids.fx,
      costingMethod: "avco",
    },
    party: {
      id: "party-1",
      kind: "customer",
      receivableAccountId: ids.recv,
      payableAccountId: ids.pay,
      creditLimit: null,
    },
    refs: {
      accountsByCode: { "3900": ids.suspense },
      items: {
        [ids.item]: {
          id: ids.item,
          code: "ITM",
          kind: "product",
          baseUnitId: "u1",
          trackLots: false,
          revenueAccountId: ids.revenue,
          inventoryAccountId: ids.inventory,
          cogsAccountId: ids.cogs,
          expenseAccountId: null,
        } satisfies ItemRef,
      },
      taxCodes: {
        [ids.tax]: {
          id: ids.tax,
          code: "SST6",
          rate: "0.06000000",
          kind: "output",
          roundingMode: "HALF_AWAY_FROM_ZERO",
          outputAccountId: ids.output,
          inputAccountId: null,
        } satisfies TaxCodeRef,
      },
      components: {},
      schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch", PROJECT: "dt-project", EMPLOYEE: "dt-employee" },
    },
    ...over,
  });

  it("resolves every account reference the schema admits", () => {
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "line.total_incl_tax",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "item.revenue_account" },
            amount: "line.total_excl_tax",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "party.payable_account" },
            amount: "line.tax_amount",
          },
          { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.discount" },
        ],
      }),
      snapshot({ lines: [line({ discount: m("5.0000") })] }),
    );
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.recv, "debit", "106.0000"],
      [ids.revenue, "credit", "100.0000"],
      [ids.pay, "credit", "6.0000"],
      [ids.suspense, "debit", "5.0000"],
    ]);
  });

  it("`line.amount` and `line.total_excl_tax` are the same field (contracts §4.3.4: amount is excl. tax)", () => {
    const both = evaluatePolicy(
      policy({
        lines: [
          { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" },
          {
            for: "each_line",
            side: "debit",
            account: { code: "3900" },
            amount: "line.total_excl_tax",
          },
        ],
      }),
      snapshot(),
    );
    expect(both.ledgerLines.map((l) => l.amount.toString())).toEqual(["100.0000", "100.0000"]);
  });

  it("a negative resolved amount flips the side and plans a positive magnitude (amendment A9)", () => {
    // A reversal document carries NEGATED magnitudes on its lines (Task 8). The same two rules that produced
    // debit/credit on the original must produce the mirror here with no second rule set — and never a
    // negative `debit`, which app.ledger_entry's `check (debit >= 0)` refuses outright (plan0A:2012).
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "line.amount",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "item.revenue_account" },
            amount: "line.total_incl_tax",
          },
        ],
      }),
      snapshot({ lines: [line({ amount: m("-25.0000"), totalInclTax: m("-26.5000") })] }),
    );
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.recv, "credit", "25.0000"],
      [ids.revenue, "debit", "26.5000"],
    ]);
    expect(plan.ledgerLines[0]!.base.toString()).toBe("25.0000"); // base is derived from the normalised amount

    // The same normalisation on the each_tax path — a credit note's tax group is negative too.
    const taxPlan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
        ],
      }),
      snapshot({ lines: [line({ amount: m("-25.0000"), taxAmount: m("-1.5000") })] }),
    );
    expect(taxPlan.ledgerLines.map((l) => [l.side, l.amount.toString()])).toEqual([
      ["debit", "1.5000"],
    ]);
    expect(taxPlan.taxLines[0]!.amount.toString()).toBe("-1.5000"); // taxLines keep the SIGNED magnitude (A9)
  });

  it("`for: each_tax` groups by tax code, emits one ledger line per group and fills plan.taxLines", () => {
    const plan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
        ],
      }),
      snapshot({
        lines: [
          line({ lineNo: 1 }),
          line({ lineNo: 2, amount: m("200.0000"), taxAmount: m("12.0000") }),
        ],
      }),
    );
    expect(plan.ledgerLines).toHaveLength(1);
    expect(plan.ledgerLines[0]).toMatchObject({
      accountId: ids.output,
      side: "credit",
      sourceLineNo: null,
    });
    expect(plan.ledgerLines[0]!.amount.toString()).toBe("18.0000");
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ taxCodeId: ids.tax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("300.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("18.0000");
  });

  it("a tax group evaluating to zero plans no ledger line and resolves no account", () => {
    // The zero-drop runs BEFORE `resolveAccount`, and that order is load-bearing. A zero-rated, exempt or
    // out-of-scope tax code has no output and no input account — correctly, because a zero-rated supply has
    // no tax account — so an evaluator that resolved first would refuse an ordinary zero-rated sale with
    // ERR_POLICY_REQUIRES_MISSING naming an account that is right to be absent. The `PlannedTaxLine` is
    // pushed either way: it carries the base a zero-rated return box is computed from, and dropping it would
    // make a zero-rated supply invisible to the return. This case pins both halves; do not reorder the body.
    const s = snapshot({ lines: [line({ taxCodeId: ids.zeroTax, taxAmount: m("0.0000") })] });
    s.refs.taxCodes[ids.zeroTax] = {
      id: ids.zeroTax,
      code: "ZR",
      rate: "0.00000000",
      kind: "zero",
      roundingMode: "HALF_AWAY_FROM_ZERO",
      outputAccountId: null,
      inputAccountId: null,
    } satisfies TaxCodeRef;
    const plan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
        ],
      }),
      s,
    );
    expect(plan.ledgerLines).toEqual([]);
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ taxCodeId: ids.zeroTax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("100.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("0.0000");
  });

  // MON-04 (2026-11-15 full review). The zero drop above must not also skip the side check: a zero-rated INPUT
  // code on a sale has no output account either, and dropped unchecked its fact was written and boxed as a
  // purchase. A code whose kind declares the other side is refused as its non-zero twin always was.
  it("a zero-amount group whose code declares the other side is refused, not dropped", () => {
    const s = snapshot({ lines: [line({ taxCodeId: ids.zeroTax, taxAmount: m("0.0000") })] });
    s.refs.taxCodes[ids.zeroTax] = {
      id: ids.zeroTax,
      code: "IZ",
      rate: "0.00000000",
      kind: "input",
      roundingMode: "HALF_AWAY_FROM_ZERO",
      outputAccountId: null,
      inputAccountId: ids.suspense,
    } satisfies TaxCodeRef;
    expect(() =>
      evaluatePolicy(
        policy({
          tax: { applies: true, inclusive: false },
          lines: [
            {
              for: "each_tax",
              side: "credit",
              account: { from: "tax_code.output_account" },
              amount: "tax.amount",
            },
          ],
        }),
        s,
      ),
    ).toThrow(/ERR_POLICY_REQUIRES_MISSING.*IZ.*input.*output/);
  });

  it("`tax.inclusive: 'header.tax_inclusive'` reads the header flag", () => {
    const plan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: "header.tax_inclusive" },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
        ],
      }),
      snapshot({ header: { ...snapshot().header, taxInclusive: true } }),
    );
    expect(plan.taxLines[0]!.inclusive).toBe(true);
  });

  // PR 11 review, round 3. `plan.taxLines` is what step 11 writes to app.tax_transaction, whose unique key is
  // (document_id, line_no, tax_code_id), and the return sums it. It is a fact about the DOCUMENT's taxed
  // lines, not about the policy's rules: one group per code over every line some `each_tax` rule matches,
  // each line counted once. Pushed per RULE, a reverse-charge pair planned the same group twice (409 at post)
  // and two overlapping `when` filters planned one code from two first lines (both rows inserted, the return
  // counted the tax twice). The LEDGER legs stay one set per rule — the pair needs both.
  it("a reverse-charge pair of `each_tax` rules plans both ledger legs and ONE tax line per code", () => {
    const s = snapshot({
      lines: [
        line({ lineNo: 1 }),
        line({ lineNo: 2, amount: m("200.0000"), taxAmount: m("12.0000") }),
      ],
    });
    s.refs.taxCodes[ids.tax] = { ...s.refs.taxCodes[ids.tax]!, inputAccountId: ids.suspense };
    const plan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "debit",
            account: { from: "tax_code.input_account" },
            amount: "tax.amount",
          },
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
        ],
      }),
      s,
    );
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.suspense, "debit", "18.0000"],
      [ids.output, "credit", "18.0000"],
    ]);
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ lineNo: 1, taxCodeId: ids.tax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("300.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("18.0000");
  });

  it("overlapping `each_tax` filters count each line once, and a line no rule matches is not a tax line", () => {
    // Rule A matches the item line (2) alone; rule B, with no `when`, both lines; rule C's `tender` filter
    // matches neither. Line 1 is the group's first line because B matched it — the union is over the lines
    // the rules MATCH, in document order, as a single rule's taxLines always were.
    const s = snapshot({
      lines: [
        line({ lineNo: 1, kind: "account", itemId: null, accountId: ids.revenue }),
        line({ lineNo: 2, amount: m("200.0000"), taxAmount: m("12.0000") }),
      ],
    });
    const plan = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
            when: { "line.kind": "item" },
          },
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
          },
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
            when: { "line.kind": "tender" },
          },
        ],
      }),
      s,
    );
    // The ledger is the policy's, one set per rule, exactly as before: A's 12 and B's 18.
    expect(plan.ledgerLines.map((l) => [l.accountId, l.side, l.amount.toString()])).toEqual([
      [ids.output, "credit", "12.0000"],
      [ids.output, "credit", "18.0000"],
    ]);
    expect(plan.taxLines).toHaveLength(1);
    expect(plan.taxLines[0]).toMatchObject({ lineNo: 1, taxCodeId: ids.tax, inclusive: false });
    expect(plan.taxLines[0]!.base.toString()).toBe("300.0000");
    expect(plan.taxLines[0]!.amount.toString()).toBe("18.0000");

    // Rule C alone: its filter matches no line, so no tax line is planned for the codes the lines carry.
    const none = evaluatePolicy(
      policy({
        tax: { applies: true, inclusive: false },
        lines: [
          {
            for: "each_tax",
            side: "credit",
            account: { from: "tax_code.output_account" },
            amount: "tax.amount",
            when: { "line.kind": "tender" },
          },
        ],
      }),
      s,
    );
    expect(none.taxLines).toEqual([]);
  });

  it("a policy with no `each_tax` rule plans no tax line, whatever codes its lines carry", () => {
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "line.amount",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "item.revenue_account" },
            amount: "line.amount",
          },
        ],
      }),
      snapshot(),
    );
    expect(plan.ledgerLines).toHaveLength(2);
    expect(plan.taxLines).toEqual([]);
  });

  it("`for: document` emits exactly one line from the document totals", () => {
    // Only the three document-scoped account references may appear on a `for: document` rule — the two party
    // links and the FX-rounding account — plus a literal `{ code }`. An `item.*` or `tax_code.*` ref here is
    // ERR_POLICY_INVALID, which the very next case asserts: with `line === null` there is no item and no tax
    // code to resolve against, so the guard is the correct behaviour and not a limitation to work around.
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "document",
            side: "debit",
            account: { from: "party.receivable_account" },
            amount: "document.total_incl_tax",
          },
          {
            for: "document",
            side: "credit",
            account: { from: "party.payable_account" },
            amount: "document.total_excl_tax",
          },
          {
            for: "document",
            side: "credit",
            account: { code: "3900" },
            amount: "document.tax_total",
          },
        ],
      }),
      snapshot({ lines: [line({ lineNo: 1 }), line({ lineNo: 2 })] }),
    );
    expect(plan.ledgerLines.map((l) => [l.side, l.amount.toString(), l.sourceLineNo])).toEqual([
      ["debit", "212.0000", null],
      ["credit", "200.0000", null],
      ["credit", "12.0000", null],
    ]);
  });

  it("a `for: document` rule that names a line-scoped account or amount is ERR_POLICY_INVALID", () => {
    for (const rule of [
      {
        for: "document",
        side: "debit",
        account: { from: "line.account" },
        amount: "document.total_incl_tax",
      },
      { for: "document", side: "debit", account: { code: "3900" }, amount: "line.amount" },
    ] as const) {
      expect(() => evaluatePolicy(policy({ lines: [rule] }), snapshot())).toThrow(
        /ERR_POLICY_INVALID/,
      );
    }
  });

  it("`when` is a conjunction — every declared equality must hold", () => {
    const rule = {
      for: "each_line",
      side: "debit",
      account: { code: "3900" },
      amount: "line.amount",
      when: { "line.kind": "item", "item.kind": "product" },
    };
    expect(evaluatePolicy(policy({ lines: [rule] }), snapshot()).ledgerLines).toHaveLength(1);
    const service = snapshot();
    service.refs.items[ids.item] = { ...service.refs.items[ids.item]!, kind: "service" };
    expect(evaluatePolicy(policy({ lines: [rule] }), service).ledgerLines).toHaveLength(0);
  });

  it("filters on tender method, quantity sign, component kind, share and document kind", () => {
    const only = (
      when: Record<string, string>,
      over: Partial<LineSnapshot>,
      header: Record<string, unknown> = {},
    ) =>
      evaluatePolicy(
        policy({
          lines: [
            {
              for: "each_line",
              side: "debit",
              account: { code: "3900" },
              amount: "line.amount",
              when,
            },
          ],
        }),
        snapshot({ lines: [line(over)], header: { ...snapshot().header, ...header } }),
      ).ledgerLines.length;
    expect(only({ "line.tender_method": "cash" }, { kind: "tender", tenderMethod: "cash" })).toBe(
      1,
    );
    expect(only({ "line.tender_method": "card" }, { kind: "tender", tenderMethod: "cash" })).toBe(
      0,
    );
    expect(only({ "line.quantity_sign": "negative" }, { quantity: Quantity.of("-1.000000") })).toBe(
      1,
    );
    expect(only({ "line.quantity_sign": "negative" }, { quantity: Quantity.of("1.000000") })).toBe(
      0,
    );
    expect(only({ "line.quantity_sign": "positive" }, { quantity: null })).toBe(0);
    expect(
      only({ "document.kind": "supplementary" }, {}, { customFields: { kind: "supplementary" } }),
    ).toBe(1);
    expect(
      only({ "document.kind": "regular" }, {}, { customFields: { kind: "supplementary" } }),
    ).toBe(0);
  });

  it("resolves component and scheme accounts and filters on the employer share (spec:2101)", () => {
    const s = snapshot({
      header: { ...snapshot().header, documentTypeCode: "PAYROLL" },
      lines: [
        line({
          kind: "payroll",
          itemId: null,
          taxCodeId: null,
          amount: m("80.0000"),
          payroll: {
            employeeId: "e1",
            employeeDimensionValueId: ids.employeeDim,
            componentId: "c1",
            schemeId: "s1",
            share: "employer",
          },
        }),
      ],
    });
    s.refs.components = {
      c1: {
        id: "c1",
        code: "BASIC",
        kind: "earning",
        expenseAccountId: ids.cogs,
        payableAccountId: null,
      } satisfies PayComponentRef,
    };
    s.refs.schemes = {
      s1: {
        id: "s1",
        code: "SYNTH",
        payableAccountId: ids.pay,
        expenseAccountId: ids.revenue,
      } satisfies SchemeRef,
    };
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "line.scheme.expense_account" },
            amount: "line.amount",
            when: { "line.share": "employer" },
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "line.scheme.payable_account" },
            amount: "line.amount",
          },
          {
            for: "each_line",
            side: "debit",
            account: { from: "line.component.expense_account" },
            amount: "line.amount",
            when: { "line.component.kind": "earning" },
          },
        ],
      }),
      s,
    );
    expect(plan.ledgerLines.map((l) => l.accountId)).toEqual([ids.revenue, ids.pay, ids.cogs]);
  });

  it("BRANCH is added from the header by default and a line's own value never overrides it", () => {
    const plan = evaluatePolicy(
      policy({
        lines: [
          { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" },
        ],
      }),
      snapshot({
        lines: [line({ dimensions: { BRANCH: "someone-elses-branch", PROJECT: ids.project } })],
      }),
    );
    expect(plan.ledgerLines[0]!.dimensions).toEqual({ BRANCH: ids.branch, PROJECT: ids.project });
  });

  it("`dimensions.from` omitting document.branch produces a line with no BRANCH, which `required` then refuses (F-9, spec:1066)", () => {
    const p = policy({
      lines: [
        {
          for: "each_line",
          side: "debit",
          account: { code: "3900" },
          amount: "line.amount",
          dimensions: { from: ["line.dimensions"] },
        },
      ],
      dimensions: { required: ["BRANCH"] },
    });
    expect(() => evaluatePolicy(p, snapshot())).toThrow(/ERR_POLICY_REQUIRES_MISSING.*BRANCH/s);
  });

  it("`line.employee` adds the EMPLOYEE dimension from the payroll ref (spec:2101)", () => {
    const s = snapshot({
      lines: [
        line({
          kind: "payroll",
          payroll: {
            employeeId: "e1",
            employeeDimensionValueId: ids.employeeDim,
            componentId: null,
            schemeId: null,
            share: null,
          },
        }),
      ],
    });
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { code: "3900" },
            amount: "line.amount",
            dimensions: { from: ["line.dimensions", "document.branch", "line.employee"] },
          },
        ],
        dimensions: { required: ["BRANCH", "EMPLOYEE"] },
      }),
      s,
    );
    expect(plan.ledgerLines[0]!.dimensions).toEqual({
      BRANCH: ids.branch,
      EMPLOYEE: ids.employeeDim,
    });
  });

  it("a required dimension type the company does not define is refused by name", () => {
    const s = snapshot();
    delete s.refs.dimensionTypesByCode.PROJECT;
    expect(() =>
      evaluatePolicy(
        policy({
          lines: [
            { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.amount" },
          ],
          dimensions: { required: ["PROJECT"] },
        }),
        s,
      ),
    ).toThrow(/ERR_POLICY_REQUIRES_MISSING.*PROJECT/s);
  });

  it("a null cost keeps its planned line at zero — the costing engine fills it at step 9 (amendment A5)", () => {
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "item.cogs_account" },
            amount: "line.cost",
          },
          {
            for: "each_line",
            side: "credit",
            account: { from: "item.inventory_account" },
            amount: "line.cost",
          },
          { for: "each_line", side: "debit", account: { code: "3900" }, amount: "line.discount" },
        ],
      }),
      snapshot(),
    );
    expect(plan.ledgerLines.map((l) => [l.accountId, l.amount.toString()])).toEqual([
      [ids.cogs, "0.0000"],
      [ids.inventory, "0.0000"],
    ]);
    expect(plan.warnings).toEqual([
      "line 1: cost is not yet computed; the costing engine fills it at post",
    ]);
  });

  it("a cost that is genuinely zero is dropped like any other zero amount", () => {
    const plan = evaluatePolicy(
      policy({
        lines: [
          {
            for: "each_line",
            side: "debit",
            account: { from: "item.cogs_account" },
            amount: "line.cost",
          },
        ],
      }),
      snapshot({ lines: [line({ cost: m("0.0000") })] }),
    );
    expect(plan.ledgerLines).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("an unresolvable reference names itself and the line", () => {
    const noParty = snapshot({ party: null });
    expect(() =>
      evaluatePolicy(
        policy({
          lines: [
            {
              for: "each_line",
              side: "debit",
              account: { from: "party.receivable_account" },
              amount: "line.amount",
            },
          ],
        }),
        noParty,
      ),
    ).toThrow(/ERR_POLICY_REQUIRES_MISSING.*party\.receivable_account/s);
    const noItem = snapshot({ lines: [line({ itemId: null })] });
    expect(() =>
      evaluatePolicy(
        policy({
          lines: [
            {
              for: "each_line",
              side: "debit",
              account: { from: "item.revenue_account" },
              amount: "line.amount",
            },
          ],
        }),
        noItem,
      ),
    ).toThrow(/ERR_POLICY_REQUIRES_MISSING.*item\.revenue_account/s);
  });

  it("validateRequires reports every missing header field by its schema name", () => {
    const p = policy({ requires: ["party", "warehouse", "client_ref"] });
    expect(
      validateRequires(
        p,
        snapshot({ party: null, header: { ...snapshot().header, partyId: null } }),
      ).missing,
    ).toEqual(["party", "warehouse", "client_ref"]);
    expect(validateRequires(policy({ requires: ["party"] }), snapshot()).missing).toEqual([]);
  });
});

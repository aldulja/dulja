// packages/db/test/sync/pos-ticket-policy.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  currency,
  evaluatePolicy,
  Money,
  parsePolicy,
  Quantity,
  UNIT_RATE,
  validateDocumentTypeSeed,
  validatePolicy,
} from "@dulja/domain";
import type { DocumentSnapshot, ItemRef, LineSnapshot, TaxCodeRef } from "@dulja/domain";
import { startDb, type Db } from "../harness";
import { PACK_ROOT } from "../ar-ap/_support";

const envelope = JSON.parse(
  readFileSync(join(PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8"),
) as Record<string, unknown>;

describe("POS_TICKET (§4.14, §4.6.5) — configuration, not code", () => {
  let db: Db;
  /** The permission catalogue as rows of `app.permission`, never an import of `PERMISSIONS`: §3.1's
   *  dependency rule pins `packages/db` (its tests included) to `@dulja/domain`, and 3B and 6D's seed-pack
   *  suites read the catalogue the same way. `app.permission` is global, so `db.admin` reads it. */
  let catalogue: string[];
  beforeAll(async () => {
    db = await startDb();
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (row) => row.code,
    );
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the envelope and the policy both validate, and every permission code is in the catalogue (F-21)", () => {
    expect(validateDocumentTypeSeed(envelope).ok).toBe(true);
    const report = validatePolicy(envelope.policy, catalogue);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the envelope's module is `pos` and its series is `POS` (§4.14, §4.3.6's suffix supplies the terminal)", () => {
    expect(envelope.code).toBe("POS_TICKET");
    expect(envelope.module).toBe("pos");
    expect((envelope.policy as { numbering: { series: string } }).numbering.series).toBe("POS");
    expect((envelope.policy as { approval: { post: string } }).approval.post).toBe("pos.sync.push");
  });

  it("the four tender rules resolve the four §4.6.5 accounts BY CODE, and no fifth method exists", () => {
    const lines = (
      envelope.policy as {
        lines: { side: string; when?: Record<string, string>; account: Record<string, string> }[];
      }
    ).lines;
    const tenders = lines.filter((l) => l.when?.["line.kind"] === "tender");
    expect(tenders).toHaveLength(4);
    expect(tenders.map((l) => [l.when!["line.tender_method"], l.account.code]).toSorted()).toEqual([
      ["card", "1120"],
      ["cash", "1110"],
      ["store_credit", "2200"],
      ["transfer", "1100"],
    ]);
    expect(tenders.every((l) => l.side === "debit")).toBe(true); // money IN is a debit, all four of them
  });

  it("a SALE plans revenue credit, COGS debit, inventory credit and a cash debit — every side from the policy", () => {
    const policy = parsePolicy(envelope.policy);
    const plan = evaluatePolicy(policy, saleSnapshot());
    const byAccount = plan.ledgerLines
      .map((l) => `${l.accountId}:${l.side}:${l.amount.toString()}`)
      .toSorted();
    // ⚠️ The figures are 5A's SYNTHETIC `SYN-OUT-STD` rate, `0.11000000` (phase-5a:53 — "an eleven-percent
    // figure chosen so it cannot be mistaken for a published one"). An earlier draft of this plan wrote 6%
    // and a gross of 106.0000: that is Malaysia's ACTUAL current standard rate, which hazard 1 forbids
    // anywhere in this repository, and it also disagrees with the only rate `taxFixture` seeds — so the case
    // was both a hazard breach and a failing assertion. `saleSnapshot()` below takes the rate from the same
    // literal 5A ships and no figure in this slice is chosen by this plan.
    expect(byAccount).toEqual([
      "acct-1110:debit:111.0000", // the cash tender — the tax-inclusive total the customer pays
      "acct-1300:credit:60.0000", // inventory relieved at cost
      "acct-2300:credit:11.0000", // output tax, extracted from the inclusive total
      "acct-4000:credit:100.0000", // revenue, excl. tax
      "acct-5000:debit:60.0000", // COGS
    ]);
    expect(
      plan.ledgerLines.every((l) => !l.amount.isNegative()),
      "A9: an amount is never negative",
    ).toBe(true);
    expect(plan.movements).toHaveLength(1);
    expect(plan.movements[0]!.effect).toBe("issue");
  });

  it("a RETURN plans the SAME accounts with every side flipped, from ONE policy (A9, 3A's effect rule)", () => {
    const policy = parsePolicy(envelope.policy);
    const plan = evaluatePolicy(policy, returnSnapshot());
    const byAccount = plan.ledgerLines
      .map((l) => `${l.accountId}:${l.side}:${l.amount.toString()}`)
      .toSorted();
    // The SAME five accounts and the SAME five magnitudes as the sale above, with every side flipped, from
    // ONE policy — which is the whole assertion. Same synthetic 0.11 rate (phase-5a:53).
    expect(byAccount).toEqual([
      "acct-1110:credit:111.0000",
      "acct-1300:debit:60.0000",
      "acct-2300:debit:11.0000",
      "acct-4000:debit:100.0000",
      "acct-5000:credit:60.0000",
    ]);
    expect(plan.ledgerLines.every((l) => !l.amount.isNegative())).toBe(true);
    // 3A's rule: a policy declaring `issue` over a NEGATIVE quantity emits `receipt` at the magnitude.
    expect(plan.movements[0]!.effect).toBe("receipt");
    expect(plan.movements[0]!.quantity.isNegative()).toBe(false);
  });
});

// ── the two builders (6A Task 10 Step 1): §4.4.2's DocumentSnapshot, member for member ─────────────────

/** 5A's SYNTHETIC standard-rated output rate (phase-5a:53). It is a literal here because this test drives
 *  `evaluatePolicy` as a pure function with no database — there is no seeded `tax_code` to read it from — and
 *  it is the SAME literal 5A ships, never a figure this plan chose. Eleven percent is deliberately not a
 *  published Malaysian rate (hazard 1, OD-15). */
const SYNTH_RATE = "0.11000000";
const MYR = currency("MYR");
const m = (v: string): Money => Money.of(v, MYR);
const q = (v: string): Quantity => Quantity.of(v);
const ZERO = m("0.0000");

/** 2A's `line()` helper (phase-2a:1355–1362), with `tenderMethod` filled: EVERY member of §4.4.2's
 *  `LineSnapshot` is present, so `evaluatePolicy` never reads an `undefined` and TypeScript never widens. */
const line = (over: Partial<LineSnapshot> & { lineNo: number }): LineSnapshot => ({
  id: `l-${over.lineNo}`, // `lineNo` itself arrives with `...over`, which is required to carry it
  kind: "item",
  description: null,
  accountId: null,
  itemId: null,
  quantity: null,
  unitPrice: null,
  discount: ZERO,
  amount: ZERO,
  taxCodeId: null,
  taxAmount: ZERO,
  totalInclTax: ZERO,
  debit: ZERO,
  credit: ZERO,
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

function saleSnapshot(): DocumentSnapshot {
  const qty = q("2.000000");
  const net = m("100.0000"); // 2 × 50.0000, excl. tax
  const tax = m("11.0000"); // net × SYNTH_RATE
  const gross = net.add(tax); // 111.0000 — what the customer pays and tenders
  return {
    header: {
      id: "doc-1",
      companyId: "co-1",
      documentTypeCode: "POS_TICKET",
      status: "issued",
      series: "POS",
      fiscalPeriodId: "fp-1",
      number: 1n,
      effectiveDate: "2026-01-15",
      partyId: null,
      currency: MYR,
      exchangeRate: UNIT_RATE(MYR),
      branchId: "br-1",
      attributedTo: "cashier-1",
      clientRef: "00000000-0000-7000-8000-000000000001",
      warehouseId: "wh-1",
      toWarehouseId: null,
      taxInclusive: true,
      reversesDocumentId: null,
      customFields: {},
    },
    company: {
      id: "co-1",
      baseCurrency: MYR,
      fxRoundingAccountId: "acct-5920",
      costingMethod: "fifo",
    },
    party: null,
    lines: [
      line({
        lineNo: 1,
        kind: "item",
        itemId: "item-1",
        quantity: qty,
        unitPrice: m("50.0000"),
        discount: ZERO,
        amount: net,
        taxCodeId: "tc-1",
        taxAmount: tax,
        totalInclTax: gross,
        cost: m("60.0000"),
        warehouseId: "wh-1",
      }),
      line({
        lineNo: 2,
        kind: "tender",
        amount: gross,
        totalInclTax: gross,
        tenderMethod: "cash",
        customFields: { method: "cash", reference: null },
      }),
    ],
    refs: {
      accountsByCode: {
        "1110": "acct-1110",
        "1120": "acct-1120",
        "1100": "acct-1100",
        "2200": "acct-2200",
      },
      items: {
        "item-1": {
          id: "item-1",
          code: "SKU-A",
          kind: "product",
          baseUnitId: "u-1",
          trackLots: false,
          revenueAccountId: "acct-4000",
          inventoryAccountId: "acct-1300",
          cogsAccountId: "acct-5000",
          expenseAccountId: null,
        } satisfies ItemRef,
      },
      taxCodes: {
        "tc-1": {
          id: "tc-1",
          code: "SYN-OUT-STD",
          rate: SYNTH_RATE,
          kind: "output",
          roundingMode: "HALF_AWAY_FROM_ZERO",
          outputAccountId: "acct-2300",
          inputAccountId: null,
        } satisfies TaxCodeRef,
      },
      components: {},
      schemes: {},
      dimensionTypesByCode: { BRANCH: "dt-branch" },
    },
  };
}

/** The sale with `quantity`, `amount`, `taxAmount`, `totalInclTax` and the TENDER's `amount` negated, and
 *  `cost` left POSITIVE. §4.4.2's A9 and 3A's rule are what make that enough: `planMovements` emits `receipt`
 *  at that quantity's magnitude (`Quantity` has `negate` and no `abs`) from a policy declaring `issue`, and
 *  `evaluatePolicy` emits the opposite `side` at `amount.abs()` (`Money` does have it). Nothing in this
 *  builder chooses a direction, and nothing here does string arithmetic on a decimal. */
function returnSnapshot(): DocumentSnapshot {
  const s = saleSnapshot();
  return {
    ...s,
    lines: s.lines.map((l) =>
      l.kind === "item"
        ? {
            ...l,
            quantity: l.quantity!.negate(),
            amount: l.amount.negate(),
            taxAmount: l.taxAmount.negate(),
            totalInclTax: l.totalInclTax.negate(),
          }
        : { ...l, amount: l.amount.negate(), totalInclTax: l.totalInclTax.negate() },
    ),
  };
}

import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { creditNoteFrom } from "../../src/ar-ap/credit-note";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import {
  salesByItem,
  type SalesByItemParams,
  type SalesByItemRow,
} from "../../src/reports/sales-by-item";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedCurrency,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { loadTypesFromPack } from "../ar-ap/_support";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";

/**
 * 4A Task 11 — `inventory.sales_by_item` gains `revenue` and `margin` under 3D's code (§4.16.1's "one code,
 * three shipments"; contracts §4.16.3 amendment 13). 3D's own suite, `inventory-reports.test.ts`, is re-run
 * unchanged beside this one: `deliveredQuantity` and `cost` are 3D's and this file only adds to them.
 *
 * Every case owns its own date WINDOW, so each tie-out reads the ledger over exactly the documents that case
 * posted, and no case's figure depends on which cases ran before it. The item, the party and the one goods
 * receipt that puts forty units at 3.0000 on the shelf are shared.
 */

let db: Db;
let s: Seed;
let invType: string;
let cnType: string;
let doType: string;
let partyId: string;
let itemId: string;
let serviceId: string;
let warehouseId: string;
const MYR = currency("MYR");
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "sales-by-item-revenue");
  await ensureOpenPeriods(db, s, 2026);
  // `4000` and `5920` are seedTenantV2's; `seedAccount` is idempotent on (company_id, code). 4A seeds no
  // account (Global Constraint 14): these are 0C's, 3C's and 3D's, created here for a bare test tenant.
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  const types = await loadTypesFromPack(db, s, [
    "SALES_INVOICE",
    "SALES_CREDIT_NOTE",
    "DELIVERY_ORDER",
    "GOODS_RECEIPT",
  ]);
  invType = types.salesInvoiceType!;
  cnType = types.salesCreditNoteType!;
  doType = types.deliveryOrderType!;
  // `seedTenant` grants s.human nothing (§4.1), and R2 evaluates each policy's approval.post inside the
  // posting transaction: the receipt's, the delivery's, the invoice's and the credit note's.
  await grantCodes(db, s, {
    codes: ["inventory.receipt.post", "inventory.transfer.post", "accounting.sales.post"],
  });
  await seedCurrency(db, s, { code: "USD" });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-SBI" });
  const vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-SBI" });
  ({ itemId } = await seedItem(db, s, { code: "IT-SBI", kind: "product", trackLots: false }));
  ({ itemId: serviceId } = await seedItem(db, s, {
    code: "SV-SBI",
    kind: "service",
    trackLots: false,
  }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-SBI" });
  // Forty units at 3.0000 in ONE receipt, so every delivery below costs 3.0000 a unit.
  const grn = await draftTypedDocument(db, s, {
    documentTypeId: types.goodsReceiptType!,
    series: "GRN",
    effectiveDate: "2026-01-02",
    partyId: vendorId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        quantity: "40.000000",
        unitPrice: "3.0000",
        amount: "120.0000",
      },
    ],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId: grn.documentId, jobs: recordingJobs() }),
  );
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/**
 * Posts a DELIVERY_ORDER of `qty` at 9.0000 through the REAL posting service (the only writer of the line's
 * cost, §4.7.2). `amount` is a PARAMETER, never `Number(qty) * 9`: no `number` ever holds a monetary value
 * (Global Constraint 4), in a test as anywhere.
 */
async function deliver(
  qty: string,
  amount: string,
  effectiveDate: string,
  opts: { currency?: string; exchangeRate?: string } = {},
): Promise<string> {
  const { documentId } = await draftTypedDocument(db, s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate,
    partyId,
    warehouseId,
    ...opts,
    lines: [{ kind: "item", itemId, warehouseId, quantity: qty, unitPrice: "9.0000", amount }],
  });
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId, jobs: recordingJobs() }),
  );
  return documentId;
}

/** Converts a posted delivery into a SALES_INVOICE (4A Task 6) and, unless `stopAt` says otherwise, posts it. */
async function invoiceOf(
  deliveryId: string,
  effectiveDate: string,
  stopAt: "draft" | "issued" | "posted" = "posted",
): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctxOf(s), {
      companyId: s.company,
      sourceDocumentId: deliveryId,
      targetDocumentTypeId: invType,
      targetSeries: "INV",
      effectiveDate,
      lines: [],
    });
    if (stopAt !== "draft") await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
    if (stopAt === "posted") await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    return r.documentId;
  });
}

async function report(
  fromDate: string,
  toDate: string,
  extra: Partial<Pick<SalesByItemParams, "branchId" | "cursor" | "limit">> = {},
): Promise<SalesByItemRow[]> {
  return withTenant(db.rw, s.tenant, s.human, (tx) =>
    salesByItem(tx, { companyId: s.company, fromDate, toDate, limit: 50, ...extra }),
  );
}

async function rowOf(fromDate: string, toDate: string, item = itemId) {
  return (await report(fromDate, toDate)).find((r) => r.itemId === item);
}

/** One account's CREDIT − DEBIT in base over a window of effective dates, for this company, at scale 4. */
async function creditNet(code: string, fromDate: string, toDate: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_credit - e.base_debit), 0)::numeric(19,4)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}
       and e.effective_date between ${fromDate}::date and ${toDate}::date`;
  return row!.net;
}

const negate = (v: string) => Money.of(v, MYR).negate().toString();
const minus = (a: string, b: string) => Money.of(a, MYR).subtract(Money.of(b, MYR)).toString();

describe("inventory.sales_by_item gains revenue and margin — §4.16.1's one code, three shipments", () => {
  it("3D's two members are unchanged, and the two new ones appear beside them", async () => {
    const d = await deliver("5.000000", "45.0000", "2026-01-05");
    await invoiceOf(d, "2026-01-06");
    const r = (await rowOf("2026-01-05", "2026-01-06"))!;
    expect(Object.keys(r).toSorted()).toEqual([
      "cost",
      "deliveredQuantity",
      "itemCode",
      "itemId",
      "itemNameEn",
      "margin",
      "revenue",
    ]);
    expect(r.deliveredQuantity).toBe("5.000000");
    expect(r.cost).toBe("15.0000"); // 5 × 3.0000, from cost_consumption — 3D's source, untouched
    expect(r.revenue).toBe("45.0000"); // 5 × 9.0000, from the invoice's document_line.amount
    expect(r.margin).toBe("30.0000");
  });

  it("the margin ties to the ledger: revenue is the credit to 4000, cost the debit to 5000", async () => {
    // Delivery and invoice share the window, so the cost 3D cuts on the delivery is the COGS the invoice
    // posted from the copied cost (§4.7.2) — the aligned case.
    const r = (await rowOf("2026-01-05", "2026-01-06"))!;
    expect(r.revenue).toBe(await creditNet("4000", "2026-01-05", "2026-01-06"));
    expect(r.cost).toBe(negate(await creditNet("5000", "2026-01-05", "2026-01-06")));
    expect(r.margin).toBe(minus(r.revenue, r.cost));
  });

  it("the params and the row are exactly 3D's plus two members (§4.16.3 amendment 13)", () => {
    // A compile-time guard: `bun run typecheck` fails if either shape drifts, which is what "3D's tie-out
    // is re-run unchanged" needs — a changed SalesByItemParams would change what 3D's suite is calling.
    expectTypeOf<keyof SalesByItemParams>().toEqualTypeOf<
      "companyId" | "fromDate" | "toDate" | "itemId" | "branchId" | "cursor" | "limit"
    >();
    expectTypeOf<keyof SalesByItemRow>().toEqualTypeOf<
      "itemId" | "itemCode" | "itemNameEn" | "deliveredQuantity" | "cost" | "revenue" | "margin"
    >();
  });

  it("a PARTIAL credit note subtracts by arithmetic, with no sign logic in the query (Task 8's negated amounts)", async () => {
    const d = await deliver("4.000000", "36.0000", "2026-01-07");
    const invoice = await invoiceOf(d, "2026-01-08");
    const before = (await rowOf("2026-01-07", "2026-01-09"))!;
    expect(before.revenue).toBe("36.0000");
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoice} order by line_no`;
    const cnId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const cn = await creditNoteFrom(tx, ctxOf(s), {
        companyId: s.company,
        settledDocumentId: invoice,
        targetDocumentTypeId: cnType,
        targetSeries: "CN",
        effectiveDate: "2026-01-09",
        reason: "one unit rejected",
        lines: [{ settledLineId: line!.id, quantity: "1.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: cn.documentId });
      await postDocument(tx, ctxOf(s), { documentId: cn.documentId });
      return cn.documentId;
    });
    // The case is what it says: the note carries reverses_document_id, and the invoice it points at is
    // still POSTED. 3D's delivery-side filter (`reverses_document_id is null`) applied here would drop it.
    const heads = await db.admin<{ id: string; status: string; reverses: string | null }[]>`
      select id, status::text as status, reverses_document_id as reverses
        from app.document where id in (${invoice}, ${cnId}) order by id`;
    expect(heads.find((h) => h.id === cnId)).toMatchObject({ status: "posted", reverses: invoice });
    expect(heads.find((h) => h.id === invoice)).toMatchObject({ status: "posted" });

    const after = (await rowOf("2026-01-07", "2026-01-09"))!;
    expect(minus(before.revenue, after.revenue)).toBe("9.0000");
    expect(after.revenue).toBe("27.0000");
    expect(after.revenue).toBe(await creditNet("4000", "2026-01-07", "2026-01-09"));
    // The note moves no stock and no delivery, so 3D's two columns do not move.
    expect(after.deliveredQuantity).toBe("4.000000");
    expect(after.cost).toBe("12.0000");
    expect(after.margin).toBe("15.0000");
  });

  it("a FULL reversal counts BOTH documents, so the pair nets to zero and a split range still ties to 4000", async () => {
    const d = await deliver("2.000000", "18.0000", "2026-01-10");
    const invoice = await invoiceOf(d, "2026-01-11");
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId: invoice,
        effectiveDate: "2026-01-12",
        reason: "customer cancelled",
      }),
    );
    const heads = await db.admin<{ id: string; status: string; reverses: string | null }[]>`
      select id, status::text as status, reverses_document_id as reverses
        from app.document where id in (${invoice}, ${reversalDocumentId})`;
    expect(heads.find((h) => h.id === invoice)).toMatchObject({ status: "reversed" });
    expect(heads.find((h) => h.id === reversalDocumentId)).toMatchObject({
      status: "posted",
      reverses: invoice,
    });

    // Both inside the range: the invoice's 18.0000 and the mirror's −18.0000 net to nothing, and the row
    // is the delivery's cost alone. Counting only `status = 'posted'` would report −18.0000 here (the
    // mirror without the invoice it mirrors); dropping every document with a reverses_document_id would
    // report +18.0000 (the invoice without its mirror).
    const whole = (await rowOf("2026-01-10", "2026-01-12"))!;
    expect(whole.revenue).toBe("0.0000");
    expect(whole.revenue).toBe(await creditNet("4000", "2026-01-10", "2026-01-12"));
    expect(whole.cost).toBe("6.0000");
    expect(whole.margin).toBe("-6.0000");

    // A range that splits the pair reports what the ledger reports on each side of the split.
    const invoiceDay = (await rowOf("2026-01-11", "2026-01-11"))!;
    expect(invoiceDay.revenue).toBe("18.0000");
    expect(invoiceDay.revenue).toBe(await creditNet("4000", "2026-01-11", "2026-01-11"));
    const reversalDay = (await rowOf("2026-01-12", "2026-01-12"))!;
    expect(reversalDay.revenue).toBe("-18.0000");
    expect(reversalDay.revenue).toBe(await creditNet("4000", "2026-01-12", "2026-01-12"));
    expect(reversalDay.deliveredQuantity).toBe("0.000000");
  });

  it("goods delivered but NOT invoiced show cost with no revenue, and the gap IS the 1250 movement", async () => {
    await deliver("2.000000", "18.0000", "2026-01-20");
    const r = (await rowOf("2026-01-20", "2026-01-20"))!;
    expect(r.deliveredQuantity).toBe("2.000000");
    expect(r.cost).toBe("6.0000");
    expect(r.revenue).toBe("0.0000");
    expect(r.margin).toBe("-6.0000");
    // The report's honesty, checkable against the ledger: the cost with no revenue is what 1250 holds.
    expect(negate(await creditNet("1250", "2026-01-20", "2026-01-20"))).toBe("6.0000");
  });

  it("goods invoiced in the range but delivered BEFORE it still report their revenue, at zero quantity and cost", async () => {
    // The revenue aggregate is FULL-joined to 3D's delivery aggregate: joined onto the movements alone, an
    // item with an invoice and no delivery in the range would vanish from the report with its revenue.
    const d = await deliver("3.000000", "27.0000", "2026-01-21");
    await invoiceOf(d, "2026-01-22");
    const r = (await rowOf("2026-01-22", "2026-01-22"))!;
    expect(r).toMatchObject({
      itemCode: "IT-SBI",
      deliveredQuantity: "0.000000",
      cost: "0.0000",
      revenue: "27.0000",
      margin: "27.0000",
    });
    expect(r.revenue).toBe(await creditNet("4000", "2026-01-22", "2026-01-22"));
  });

  it("a foreign-currency invoice reports round(amount × ITS OWN rate, 4) in base — the ledger's own figure", async () => {
    // 18.0000 USD × 4.68351234 = 84.30322212, which rounds to 84.3032: a figure that is neither the document
    // amount (the rate-1 answer LEGACY-014's legacy report printed) nor an unrounded product.
    const d = await deliver("2.000000", "18.0000", "2026-01-25", {
      currency: "USD",
      exchangeRate: "4.68351234",
    });
    const invoice = await invoiceOf(d, "2026-01-26");
    const [head] = await db.admin<{ currency: string; rate: string }[]>`
      select currency::text as currency, exchange_rate::text as rate
        from app.document where id = ${invoice}`;
    expect(head).toEqual({ currency: "USD", rate: "4.68351234" });
    const r = (await rowOf("2026-01-26", "2026-01-26"))!;
    expect(r.revenue).toBe("84.3032");
    expect(r.revenue).toBe(await creditNet("4000", "2026-01-26", "2026-01-26"));
  });

  it("a draft or issued invoice is not revenue — only a posted one is", async () => {
    const drafted = await deliver("1.000000", "9.0000", "2026-01-27");
    await invoiceOf(drafted, "2026-01-28", "draft");
    const issued = await deliver("1.000000", "9.0000", "2026-01-27");
    await invoiceOf(issued, "2026-01-28", "issued");
    expect(await rowOf("2026-01-28", "2026-01-28")).toBeUndefined();
    expect(await creditNet("4000", "2026-01-28", "2026-01-28")).toBe("0.0000");
  });

  it("a service item has a revenue row of its own, with no delivery and no cost", async () => {
    await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-29",
      lines: [
        {
          kind: "item",
          itemId: serviceId,
          quantity: "1.000000",
          unitPrice: "50.0000",
          amount: "50.0000",
        },
      ],
    });
    const r = (await rowOf("2026-01-29", "2026-01-29", serviceId))!;
    expect(r).toMatchObject({
      itemCode: "SV-SBI",
      deliveredQuantity: "0.000000",
      cost: "0.0000",
      revenue: "50.0000",
      margin: "50.0000",
    });
  });

  it("the branch and item filters bound the revenue side as they bound 3D's", async () => {
    const other = await seedBranch(db, s, { code: "BR-SBI", nameEn: "Other branch" });
    expect(await report("2026-01-05", "2026-01-06", { branchId: other })).toEqual([]);
    const hq = await report("2026-01-05", "2026-01-06", { branchId: s.hq });
    expect(hq.map((r) => [r.itemCode, r.revenue])).toEqual([["IT-SBI", "45.0000"]]);
    const byItem = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-01-31",
        itemId: serviceId,
        limit: 50,
      }),
    );
    expect(byItem.map((r) => r.itemCode)).toEqual(["SV-SBI"]);
  });

  it("pages by item code across revenue-only and delivered items, and the cursor round-trips", async () => {
    const page1 = await report("2026-01-01", "2026-01-31", { limit: 1 });
    expect(page1.map((r) => r.itemCode)).toEqual(["IT-SBI"]);
    const page2 = await report("2026-01-01", "2026-01-31", {
      limit: 1,
      cursor: { itemCode: page1[0]!.itemCode },
    });
    expect(page2.map((r) => r.itemCode)).toEqual(["SV-SBI"]);
    const page3 = await report("2026-01-01", "2026-01-31", {
      limit: 1,
      cursor: { itemCode: page2[0]!.itemCode },
    });
    expect(page3).toEqual([]);
  });

  it("over the whole month, Σ revenue is the 4000 movement to the cent, through notes, reversals and FX", async () => {
    const rows = await report("2026-01-01", "2026-01-31");
    const total = rows.reduce((sum, r) => sum.add(Money.of(r.revenue, MYR)), Money.zero(MYR));
    expect(total.toString()).toBe(await creditNet("4000", "2026-01-01", "2026-01-31"));
    for (const r of rows) expect(r.margin).toBe(minus(r.revenue, r.cost));
  });

  it("every figure is a 4-dp or 6-dp STRING — a `number` in any of them is a no-number-money violation", async () => {
    for (const r of await report("2026-01-01", "2026-01-31")) {
      expect(r.deliveredQuantity).toMatch(/^-?\d+\.\d{6}$/);
      for (const v of [r.cost, r.revenue, r.margin]) expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }
  });
});

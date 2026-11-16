import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice, type ConvertToInvoiceInput } from "../../src/ar-ap/invoice";
import { listLinks, openQuantity } from "../../src/documents/link";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { issueDocument, postDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedPaymentTerm,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";
import { loadTypesFromPack, plus4 } from "./_support";
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let invType: string;
let doType: string;
let grnType: string;
let soType: string;
let partyId: string;
let vendorId: string;
let termId: string;
let itemId: string;
let warehouseId: string;
let receiptId: string;
const ctxOf = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** Balance of an account in base, signed debit − credit, at scale 4 — `0.0000`, not `0`, on an empty account. */
async function net(code: string): Promise<string> {
  const [row] = await db.admin<{ net: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as net
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where a.company_id = ${s.company} and a.code = ${code}`;
  return row!.net;
}

/** The ledger rows one document posted, by account code: the amount in its own currency and in base. */
async function legs(documentId: string) {
  return db.admin<
    {
      code: string;
      currency: string;
      debit: string;
      credit: string;
      baseDebit: string;
      baseCredit: string;
    }[]
  >`
    select a.code, e.currency::text as currency, e.debit::text as debit, e.credit::text as credit,
           e.base_debit::text as "baseDebit", e.base_credit::text as "baseCredit"
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId}
     order by a.code, e.line_no`;
}

/** Converts, issues and posts in ONE transaction, the way a caller that wants the posted invoice does. */
async function invoice(
  input: Omit<ConvertToInvoiceInput, "companyId" | "targetDocumentTypeId" | "targetSeries">,
) {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctxOf(s), {
      companyId: s.company,
      targetDocumentTypeId: invType,
      targetSeries: "INV",
      ...input,
    });
    await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
    await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    return r;
  });
}

/** Converts and leaves the invoice a DRAFT. */
function draftInvoice(
  input: Omit<ConvertToInvoiceInput, "companyId" | "targetDocumentTypeId" | "targetSeries">,
) {
  return withTenant(db.rw, s.tenant, s.human, (tx) =>
    convertToInvoice(tx, ctxOf(s), {
      companyId: s.company,
      targetDocumentTypeId: invType,
      targetSeries: "INV",
      ...input,
    }),
  );
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "invoice-conversion");
  // `seedTenant` gives 2026-01 open and 2026-02/03 closed and locked; every date below is in January, and
  // the reopen is for the costing engine's forward look, which reads the whole year.
  await ensureOpenPeriods(db, s, 2026);
  // `4000` is seedTenantV2's and `5920` too (its fx rounding account); `seedAccount` is idempotent on
  // (company_id, code), so neither is listed. `2150` is the GOODS_RECEIPT's credit leg: the one receipt
  // below is how stock exists here, and 4A seeds no account (Global Constraint 14).
  for (const [code, nameEn, type] of [
    ["1200", "Trade receivables", "asset"],
    ["1250", "Goods delivered not invoiced", "asset"],
    ["1300", "Inventory control", "asset"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5000", "Cost of goods sold", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  // The types come from the PACK, through 1A's loader — the conversion is proven against the seeded files.
  const types = await loadTypesFromPack(db, s, [
    "SALES_INVOICE",
    "DELIVERY_ORDER",
    "GOODS_RECEIPT",
    "SALES_ORDER",
  ]);
  invType = types.salesInvoiceType!;
  doType = types.deliveryOrderType!;
  grnType = types.goodsReceiptType!;
  soType = types.salesOrderType!;
  // `seedTenant` grants s.human nothing (§4.1) and R2 evaluates each policy's approval.post inside the
  // posting transaction: the receipt's, the delivery's and the invoice's.
  await grantCodes(db, s, {
    codes: ["inventory.receipt.post", "inventory.transfer.post", "accounting.sales.post"],
  });
  termId = await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  partyId = await seedParty(db, s, { kind: "customer", code: "CUST-CONV" });
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.party set payment_term_id = ${termId} where id = ${partyId}`,
  );
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-CONV" });
  ({ itemId } = await seedItem(db, s, { code: "IT-CONV", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-CONV" });
  // FORTY units at 3.0000 each, in ONE receipt, so the item has one layer and every issue below costs at
  // 3.0000 a unit until the 3.333333 delivery. Forty and not ten: `assert_stock_available` (3A) refuses an
  // issue that takes the warehouse negative, and a short receipt would fail a late case with
  // ERR_STOCK_INSUFFICIENT that reads like a conversion bug.
  const grn = await draftTypedDocument(db, s, {
    documentTypeId: grnType,
    series: "GRN",
    effectiveDate: "2026-01-05",
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
  receiptId = grn.documentId;
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId: receiptId, jobs: recordingJobs() }),
  );
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/**
 * Drafts and posts a DELIVERY_ORDER of `qty` at 9.0000 a unit through the REAL posting service, which is the
 * only writer of the line's `cost` (§4.7.2). `amount` is a parameter, never `Number(qty) * 9`: no `number`
 * ever holds a monetary value (§3.7.5), in a test as anywhere.
 */
async function deliver(
  qty: string,
  amount: string,
  effectiveDate: string,
  opts: { currency?: string; exchangeRate?: string; rateSource?: string } = {},
) {
  const { rateSource, ...header } = opts;
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate,
    partyId,
    warehouseId,
    ...header,
    lines: [{ kind: "item", itemId, warehouseId, quantity: qty, unitPrice: "9.0000", amount }],
  });
  await withTenant(db.rw, s.tenant, s.human, async (tx) => {
    // The provenance an API-drafted foreign-currency document carries (draftTypedDocument writes none). It
    // is written on the DRAFT: once posted the header is frozen (migration 0117).
    if (rateSource !== undefined) {
      await tx`update app.document set rate_source = ${rateSource} where id = ${documentId}`;
    }
    await postDocument(tx, ctxOf(s), { documentId, jobs: recordingJobs() });
  });
  return { documentId, lineIds };
}

async function lineOf(documentId: string) {
  const [row] = await db.admin<
    {
      cost: string | null;
      amount: string;
      total: string;
      quantity: string;
      unitPrice: string | null;
    }[]
  >`
    select cost::text as cost, amount::text as amount, total_incl_tax::text as total,
           quantity::text as quantity, unit_price::text as "unitPrice"
      from app.document_line where document_id = ${documentId} order by line_no limit 1`;
  return row!;
}

describe("DELIVERY_ORDER → SALES_INVOICE — spec:1051, §4.15's 1250 row", () => {
  it("a full conversion posts the invoice and drives 1250 to EXACTLY where it started", async () => {
    const before = await net("1250");
    const dO = await deliver("4.000000", "36.0000", "2026-01-10");
    expect(await net("1250")).toBe(plus4(before, "12.0000")); // 4 × 3.0000 cost

    const inv = await invoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-11",
      lines: [],
    });
    expect(await net("1250")).toBe(before); // the corridor is back where it started
    expect(inv.linkIds).toHaveLength(1);
    // The copied line: the cost the delivery wrote (§4.7.2 amendment 5), the price, and the derived total.
    expect(await lineOf(inv.documentId)).toEqual({
      cost: "12.0000",
      amount: "36.0000",
      total: "36.0000",
      quantity: "4.000000",
      unitPrice: "9.0000",
    });
    expect(await legs(inv.documentId)).toEqual([
      {
        code: "1200",
        currency: "MYR",
        debit: "36.0000",
        credit: "0.0000",
        baseDebit: "36.0000",
        baseCredit: "0.0000",
      },
      {
        code: "1250",
        currency: "MYR",
        debit: "0.0000",
        credit: "12.0000",
        baseDebit: "0.0000",
        baseCredit: "12.0000",
      },
      {
        code: "4000",
        currency: "MYR",
        debit: "0.0000",
        credit: "36.0000",
        baseDebit: "0.0000",
        baseCredit: "36.0000",
      },
      {
        code: "5000",
        currency: "MYR",
        debit: "12.0000",
        credit: "0.0000",
        baseDebit: "12.0000",
        baseCredit: "0.0000",
      },
    ]);
  });

  it("the draft pins the party's payment term and the rate's provenance at draft (LEGACY-013, LEGACY-012)", async () => {
    const dO = await deliver("1.000000", "9.0000", "2026-01-11");
    const inv = await draftInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-11",
      lines: [],
    });
    const [head] = await db.admin<
      {
        status: string;
        termId: string | null;
        rateSource: string | null;
        rate: string;
        currency: string;
      }[]
    >`
      select status::text as status, payment_term_id as "termId", rate_source as "rateSource",
             exchange_rate::text as rate, currency::text as currency
        from app.document where id = ${inv.documentId}`;
    // A base-currency delivery carries no provenance (the API writes none for the identity pair), and the
    // invoice gets the label the identity pair has everywhere else — never a posted base figure with none.
    expect(head).toEqual({
      status: "draft",
      termId,
      rateSource: "unit",
      rate: "1.00000000",
      currency: "MYR",
    });
  });

  it("the link is `converts_to`, from the delivery to the invoice", async () => {
    const dO = await deliver("2.000000", "18.0000", "2026-01-12");
    const inv = await draftInvoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-12",
      lines: [],
    });
    const links = await withTenant(db.rw, s.tenant, s.human, (tx) => listLinks(tx, inv.documentId));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceDocumentId: dO.documentId,
      sourceLineId: dO.lineIds[0],
      targetDocumentId: inv.documentId,
      targetLineId: inv.lineIds[0],
      linkKind: "converts_to",
      quantity: "2.000000",
    });
  });

  it("a PARTIAL conversion pro-rates the cost, and the closing conversion takes the RESIDUE so 1250 hits zero", async () => {
    const before = await net("1250");
    // THE ONE CASE THAT DISCRIMINATES THE RESIDUE BRANCH, and its quantity is chosen, not convenient. The
    // item's layer is at 3.0000, so an issue of 3.333333 units costs round(3.0000 × 3.333333, 4) =
    // round(9.999999, 4) = 10.0000 — a delivered cost that three equal thirds cannot reproduce, because
    // 3 × round(10.0000 × 1/3, 4) = 3 × 3.3333 = 9.9999. An INTEGER delivery quantity could not produce a
    // residue at all, and a case built that way passes with the branch and without it.
    // The delivery line's posted cost is READ, never re-written.
    const dO = await deliver("3.333333", "30.0000", "2026-01-13");
    expect((await lineOf(dO.documentId)).cost).toBe("10.0000");
    expect(await net("1250")).toBe(plus4(before, "10.0000"));

    const convert = async (quantity: string, effectiveDate: string): Promise<string> => {
      const r = await invoice({
        sourceDocumentId: dO.documentId,
        effectiveDate,
        lines: [{ sourceLineId: dO.lineIds[0]!, quantity }],
      });
      return (await lineOf(r.documentId)).cost!;
    };

    // Three conversions of one third each. The first two are the pro-rata; the third COMPLETES the source
    // line, so it takes 10.0000 − 3.3333 − 3.3333 = 3.3334 where the pro-rata would give 3.3333 again.
    expect(await convert("1.111111", "2026-01-14")).toBe("3.3333");
    expect(await convert("1.111111", "2026-01-15")).toBe("3.3333");
    expect(await convert("1.111111", "2026-01-15")).toBe("3.3334"); // the residue, and it differs
    // Against a pro-rata-only implementation this reads `before + 0.0001` and the case is red.
    expect(await net("1250")).toBe(before);
  });

  it("converting more than the open quantity is refused by 3C's guard", async () => {
    const dO = await deliver("1.000000", "9.0000", "2026-01-16");
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-16",
        lines: [{ sourceLineId: dO.lineIds[0]!, quantity: "5.000000" }],
      }),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("the open quantity is a PROJECTION of the links, and it reaches zero — LEGACY-017", async () => {
    const dO = await deliver("2.000000", "18.0000", "2026-01-17");
    await draftInvoice({ sourceDocumentId: dO.documentId, effectiveDate: "2026-01-17", lines: [] });
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, dO.documentId),
    );
    expect(open.map((o) => [o.orderedQuantity, o.linkedQuantity, o.openQuantity])).toEqual([
      ["2.000000", "2.000000", "0.000000"],
    ]);
    // …and a second full conversion of a fully converted delivery has nothing left to draft.
    await expect(
      draftInvoice({ sourceDocumentId: dO.documentId, effectiveDate: "2026-01-17", lines: [] }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* has no open line/);
  });

  it("an UNPOSTED delivery cannot be converted — there is nothing in the corridor to relieve", async () => {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-01-18",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "9.0000",
          amount: "9.0000",
        },
      ],
    });
    await expect(
      draftInvoice({ sourceDocumentId: documentId, effectiveDate: "2026-01-18", lines: [] }),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: source document .* is not posted/);
  });

  it("a FOREIGN-CURRENCY delivery: AR and revenue convert at the copied rate, the cost legs relieve 1250 in BASE", async () => {
    // `document_line.cost` is BASE currency (3B amendment A4) and a cost-derived leg is written at rate 1,
    // so the copied cost must not be converted a second time at the invoice's rate. 2 × 9.0000 USD at
    // 4.6835 is 84.3030 MYR of revenue; the cost of the same two units is whatever the delivery wrote.
    await seedCurrency(db, s, { code: "USD" });
    const before = await net("1250");
    const dO = await deliver("2.000000", "18.0000", "2026-01-19", {
      currency: "USD",
      exchangeRate: "4.68350000",
      rateSource: `manual:${s.human}`,
    });
    const delivered = (await lineOf(dO.documentId)).cost!;
    expect(await net("1250")).toBe(plus4(before, delivered));

    const inv = await invoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-20",
      lines: [],
    });
    expect(await net("1250")).toBe(before);
    const [head] = await db.admin<{ currency: string; rate: string; rateSource: string | null }[]>`
      select currency::text as currency, exchange_rate::text as rate, rate_source as "rateSource"
        from app.document where id = ${inv.documentId}`;
    expect(head).toEqual({ currency: "USD", rate: "4.68350000", rateSource: `manual:${s.human}` });
    expect(await legs(inv.documentId)).toEqual([
      {
        code: "1200",
        currency: "USD",
        debit: "18.0000",
        credit: "0.0000",
        baseDebit: "84.3030",
        baseCredit: "0.0000",
      },
      {
        code: "1250",
        currency: "MYR",
        debit: "0.0000",
        credit: delivered,
        baseDebit: "0.0000",
        baseCredit: delivered,
      },
      {
        code: "4000",
        currency: "USD",
        debit: "0.0000",
        credit: "18.0000",
        baseDebit: "0.0000",
        baseCredit: "84.3030",
      },
      {
        code: "5000",
        currency: "MYR",
        debit: delivered,
        credit: "0.0000",
        baseDebit: delivered,
        baseCredit: "0.0000",
      },
    ]);
  });

  it("a delivery drafted FROM A SALES ORDER carries the price and no amount, and the invoice prices it", async () => {
    // 3D's convertOrderToDelivery writes amount 0 on every delivery line — a delivery recognises no revenue —
    // and copies the order's unit_price "so 4A's invoice can read it" (3d:2664). Copying that zero would post
    // an invoice with no revenue and no receivable.
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-21",
      partyId,
      lines: [
        { kind: "item", itemId, quantity: "5.000000", unitPrice: "9.0000", amount: "45.0000" },
      ],
    });
    const dO = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await issueDocument(tx, ctxOf(s), { documentId: order.documentId });
      const d = await convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-21",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "2.000000" }],
      });
      await postDocument(tx, ctxOf(s), { documentId: d.documentId, jobs: recordingJobs() });
      return d;
    });
    expect((await lineOf(dO.documentId)).amount).toBe("0.0000");
    const before4000 = await net("4000");
    const inv = await invoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-22",
      lines: [],
    });
    expect((await lineOf(inv.documentId)).amount).toBe("18.0000"); // 2 × 9.0000
    expect(await net("4000")).toBe(plus4(before4000, "-18.0000")); // revenue is a credit
  });

  it("only a posted STOCK MOVEMENT in the target's direction converts — never an invoice, never a receipt", async () => {
    // A posted SALES_INVOICE moves no stock and filled no corridor: converting it would relieve 1250 a second
    // time for the same goods. A GOODS_RECEIPT is a stock movement the OTHER way: its line cost is a receipt
    // value, and a sales invoice built on it would relieve 1250 for goods that never left.
    const dO = await deliver("1.000000", "9.0000", "2026-01-23");
    const first = await invoice({
      sourceDocumentId: dO.documentId,
      effectiveDate: "2026-01-23",
      lines: [],
    });
    await expect(
      draftInvoice({ sourceDocumentId: first.documentId, effectiveDate: "2026-01-23", lines: [] }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is not a stock movement/);
    await expect(
      draftInvoice({ sourceDocumentId: receiptId, effectiveDate: "2026-01-23", lines: [] }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is not a stock movement/);
  });

  it("the source and the target type are bound to the CALLER's company, never to the tenant (AGENTS.md)", async () => {
    // RLS bounds the tenant and nothing else: a delivery of company A reached with company B's authority,
    // or company B's invoice type drafted onto company A's delivery, would each pass every tenant-scoped FK.
    const dO = await deliver("1.000000", "9.0000", "2026-01-24");
    const other = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [company] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'CONV-B', 'Conversion second company', 'MYR') returning id`;
      const [type] = await tx<{ id: string }[]>`
        insert into app.document_type (tenant_id, company_id, code, name_en, module)
        values (${s.tenant}, ${company!.id}, 'SALES_INVOICE', 'Sales Invoice', 'accounting') returning id`;
      return { companyId: company!.id, typeId: type!.id };
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convertToInvoice(tx, ctxOf(s), {
          companyId: other.companyId,
          sourceDocumentId: dO.documentId,
          targetDocumentTypeId: other.typeId,
          targetSeries: "INV",
          effectiveDate: "2026-01-24",
          lines: [],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: source document .* is not a document of company/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convertToInvoice(tx, ctxOf(s), {
          companyId: s.company,
          sourceDocumentId: dO.documentId,
          targetDocumentTypeId: other.typeId,
          targetSeries: "INV",
          effectiveDate: "2026-01-24",
          lines: [],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document type .* is not a live type of company/);
  });

  it("a line asked twice, a line that is not the source's and a non-positive quantity are refused", async () => {
    const dO = await deliver("2.000000", "18.0000", "2026-01-25");
    const line = dO.lineIds[0]!;
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-25",
        lines: [
          { sourceLineId: line, quantity: "1.000000" },
          { sourceLineId: line, quantity: "1.000000" },
        ],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* is asked for twice/);
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-25",
        lines: [{ sourceLineId: s.docType, quantity: "1.000000" }],
      }),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line .* is not a quantity-bearing line of the source/,
    );
    await expect(
      draftInvoice({
        sourceDocumentId: dO.documentId,
        effectiveDate: "2026-01-25",
        lines: [{ sourceLineId: line, quantity: "0.000000" }],
      }),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* quantity must be positive/);
  });
});

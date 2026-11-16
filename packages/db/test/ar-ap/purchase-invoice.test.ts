import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice, type ConvertToInvoiceInput } from "../../src/ar-ap/invoice";
import { allocateLandedCostForDocument } from "../../src/costing/landed-cost";
import { issueDocument, postDocument } from "../../src/posting";
import { readPackFile } from "../../src/seed";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedCurrency,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type DraftLine,
  type Seed,
} from "../index";
import { PACK_ROOT, accountByCode, loadTypesFromPack, plus4 } from "./_support";
import {
  ensureOpenPeriods,
  recordingJobs,
} from "../../../../tests/invariants/support/post-inventory";
import { postArDocument } from "../../../../tests/invariants/support/post-ar";

let db: Db;
let s: Seed;
let pinvType: string;
let grnType: string;
let shipmentType: string;
let vendorId: string;
let itemId: string;
let warehouseId: string;
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

/**
 * Drafts a stock receipt from the vendor and posts it through the REAL posting service, which credits `2150`
 * at `line.amount` and is the only writer of the line's `cost` (§4.7.2). 3B's `postInventoryDocument` is not
 * used: it takes no party, and both 3C receipt types `require` one.
 */
async function receive(
  lines: readonly DraftLine[],
  effectiveDate: string,
  opts: {
    documentTypeId?: string;
    series?: string;
    currency?: string;
    exchangeRate?: string;
    beforePost?: (documentId: string, lineIds: string[]) => Promise<unknown>;
  } = {},
) {
  const { documentTypeId = grnType, series = "GRN", beforePost, ...fx } = opts;
  const { documentId, lineIds } = await draftTypedDocument(db, s, {
    documentTypeId,
    series,
    effectiveDate,
    partyId: vendorId,
    warehouseId,
    ...fx,
    lines,
  });
  if (beforePost) await beforePost(documentId, lineIds);
  await withTenant(db.rw, s.tenant, s.human, (tx) =>
    postDocument(tx, ctxOf(s), { documentId, jobs: recordingJobs() }),
  );
  return { documentId, lineIds };
}

/** Converts, issues and posts in ONE transaction, the way a caller that wants the posted invoice does. */
async function invoice(
  input: Omit<ConvertToInvoiceInput, "companyId" | "targetDocumentTypeId" | "targetSeries">,
) {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctxOf(s), {
      companyId: s.company,
      targetDocumentTypeId: pinvType,
      targetSeries: "PINV",
      ...input,
    });
    await issueDocument(tx, ctxOf(s), { documentId: r.documentId });
    await postDocument(tx, ctxOf(s), { documentId: r.documentId });
    return r;
  });
}

/** The invoice's lines as the conversion wrote them. */
async function linesOf(documentId: string) {
  return db.admin<{ kind: string; quantity: string | null; amount: string; total: string }[]>`
    select kind, quantity::text as quantity, amount::text as amount, total_incl_tax::text as total
      from app.document_line where document_id = ${documentId} order by line_no`;
}

const goods = (quantity: string, unitPrice: string, amount: string): DraftLine => ({
  kind: "item",
  itemId,
  warehouseId,
  quantity,
  unitPrice,
  amount,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "purchase-invoice");
  // `seedTenant` gives 2026-01 open and 2026-02/03 closed and locked; every date below is in January, and the
  // reopen is for the costing engine's forward look, which reads the whole year.
  await ensureOpenPeriods(db, s, 2026);
  // The accounts PURCHASE_INVOICE's policy resolves (`2150` by code, `2100` through the party), plus `1300` —
  // the receipt's inventory leg, asserted UNCHANGED by the invoice — and `5900`, the account line's own
  // account. `5920` is seedTenantV2's (its fx rounding account) and `seedAccount` is idempotent on
  // (company_id, code). 4A seeds none of these in the pack (Global Constraint 14): 0C and 3C own them.
  for (const [code, nameEn, type] of [
    ["1300", "Inventory control", "asset"],
    ["2100", "Trade payables", "liability"],
    ["2150", "Goods received not invoiced", "liability"],
    ["5900", "Other operating expense", "expense"],
  ] as const) {
    await seedAccount(db, s, { code, nameEn, type });
  }
  // The types come from the PACK, through 1A's loader — the conversion is proven against the seeded files.
  const types = await loadTypesFromPack(db, s, ["GOODS_RECEIPT", "SHIPMENT", "PURCHASE_INVOICE"]);
  pinvType = types.purchaseInvoiceType!;
  grnType = types.goodsReceiptType!;
  shipmentType = types.shipmentType!;
  // `seedTenant` grants s.human nothing (§4.1) and R2 evaluates each policy's approval.post inside the
  // posting transaction: the receipt's (both 3C receipt types post under inventory.receipt.post) and the
  // invoice's.
  await grantCodes(db, s, { codes: ["inventory.receipt.post", "accounting.purchase.post"] });
  vendorId = await seedParty(db, s, { kind: "vendor", code: "VEND-PINV" });
  ({ itemId } = await seedItem(db, s, { code: "IT-PINV", kind: "product", trackLots: false }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-PINV" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("PURCHASE_INVOICE — §4.14, ADR 0044, spec:1049", () => {
  it("a GOODS_RECEIPT accrues into 2150, and its PURCHASE_INVOICE drives 2150 to EXACTLY zero", async () => {
    const before = await net("2150");
    const grn = await receive([goods("10.000000", "3.0000", "30.0000")], "2026-01-05");
    expect(await net("2150")).toBe(plus4(before, "-30.0000")); // a liability: credit

    const inv = await invoice({
      sourceDocumentId: grn.documentId,
      effectiveDate: "2026-01-06",
      lines: [],
    });
    expect(await net("2150")).toBe(before);
    expect(inv.linkIds).toHaveLength(1);
    const rows = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, e.debit::text as debit, e.credit::text as credit
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${inv.documentId} order by a.code`;
    expect(rows).toEqual([
      { code: "2100", debit: "0.0000", credit: "30.0000" },
      { code: "2150", debit: "30.0000", credit: "0.0000" },
    ]);
  });

  it("the invoice does NOT touch 1300 — the goods were capitalised at receipt, not twice", async () => {
    const beforeStock = await net("1300");
    const grn = await receive([goods("2.000000", "3.0000", "6.0000")], "2026-01-07");
    const afterReceipt = await net("1300");
    await invoice({ sourceDocumentId: grn.documentId, effectiveDate: "2026-01-08", lines: [] });
    expect(afterReceipt).toBe(plus4(beforeStock, "6.0000"));
    expect(await net("1300")).toBe(afterReceipt); // unchanged by the invoice
  });

  it("a FREIGHT accrual line is NOT carried by the conversion, and is not cleared by it either", async () => {
    // 3C's GOODS_RECEIPT posts inland freight as a `kind: "account"` line with a NULL quantity: 1300 debited,
    // the line's own account credited. app.document_open_quantity carries `where l.quantity is not null`
    // (3c:895) and convertToInvoice inner-joins that view, so the line is not in `sources` and cannot reach the
    // invoice. This case pins that as the CONTRACT rather than leaving it to be discovered as a missing line:
    // the goods corridor still closes, and the freight accrual is still standing, waiting for the forwarder's
    // own invoice. If a later slice wants a one-document form it needs an amount-linked link kind and an
    // amendment to Task 0's amendment 5 — not a change here.
    const freightAccrual = await accountByCode(db, s, "5900");
    const beforeFreight = await net("5900");
    const beforeGrni = await net("2150");
    const grn = await receive(
      [
        goods("5.000000", "3.0000", "15.0000"),
        {
          kind: "account",
          accountId: freightAccrual,
          description: "inland freight",
          amount: "40.0000",
        },
      ],
      "2026-01-12",
      {
        // Since INV-03 a capitalised freight line posts only once it is allocated onto the goods (step 6h);
        // the allocation moves the layer, never the ledger this case asserts.
        beforePost: (documentId, lineIds) =>
          withTenant(db.rw, s.tenant, s.human, (tx) =>
            allocateLandedCostForDocument(tx, ctxOf(s), {
              documentId,
              allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
            }),
          ),
      },
    );
    const inv = await invoice({
      sourceDocumentId: grn.documentId,
      effectiveDate: "2026-01-13",
      lines: [],
    });
    // ONE line on the invoice — the goods line — and every target line is `kind: 'item'`.
    expect((await linesOf(inv.documentId)).map(({ kind, amount }) => ({ kind, amount }))).toEqual([
      { kind: "item", amount: "15.0000" },
    ]);
    // The goods corridor closes to its opening balance: 2150 holds only the goods accrual.
    expect(await net("2150")).toBe(beforeGrni);
    // The freight accrual is untouched by the conversion and still owed to the forwarder. The receipt CREDITED
    // it (GOODS_RECEIPT's account rule: 1300 debit, line.account credit), so its signed debit − credit balance
    // moved by −40.0000 and the invoice moved it by nothing.
    expect(await net("5900")).toBe(plus4(beforeFreight, "-40.0000"));
  });

  it("an EXPENSE invoice with no receipt posts on its own — an account line has no corridor", async () => {
    const expenseAccount = await accountByCode(db, s, "5900");
    const r = await postArDocument(db, s, {
      documentTypeId: pinvType,
      series: "PINV",
      partyId: vendorId,
      effectiveDate: "2026-01-09",
      lines: [
        {
          kind: "account",
          accountId: expenseAccount,
          description: "warehouse rent",
          amount: "1200.0000",
        },
      ],
    });
    expect(r.ledger).toEqual([
      { code: "2100", debit: "0.0000", credit: "1200.0000" },
      { code: "5900", debit: "1200.0000", credit: "0.0000" },
    ]);
  });

  it("a PARTIAL invoice against a receipt leaves the balance of 2150 open, and the closing one clears it", async () => {
    const before = await net("2150");
    const grn = await receive([goods("3.000000", "10.0000", "30.0000")], "2026-01-10");
    const open: string[] = [];
    for (const qty of ["1.000000", "2.000000"]) {
      await invoice({
        sourceDocumentId: grn.documentId,
        effectiveDate: "2026-01-11",
        lines: [{ sourceLineId: grn.lineIds[0]!, quantity: qty }],
      });
      open.push(await net("2150"));
    }
    // After the first third, two thirds of the accrual are still owed and not yet invoiced.
    expect(open).toEqual([plus4(before, "-20.0000"), before]);
  });

  it("the closing invoice takes the RESIDUE of the accrual, so 2150 reaches exactly zero and not within 0.0001", async () => {
    // THE CASE THAT DISCRIMINATES THE RESIDUE BRANCH ON THE PURCHASE SIDE. The receipt accrues the supplier's
    // total, 10.0000 for three units, which three equal thirds cannot reproduce: 3 × round(10.0000 / 3, 4) =
    // 3 × 3.3333 = 9.9999. The third invoice completes the line, so it takes 10.0000 − 3.3333 − 3.3333 =
    // 3.3334. Against a pro-rata-only implementation 2150 is left at −0.0001 and this case is red.
    const before = await net("2150");
    const grn = await receive([goods("3.000000", "3.3333", "10.0000")], "2026-01-14");
    const amounts: string[] = [];
    for (const day of ["2026-01-14", "2026-01-15", "2026-01-16"]) {
      const r = await invoice({
        sourceDocumentId: grn.documentId,
        effectiveDate: day,
        lines: [{ sourceLineId: grn.lineIds[0]!, quantity: "1.000000" }],
      });
      amounts.push((await linesOf(r.documentId))[0]!.amount);
    }
    expect(amounts).toEqual(["3.3333", "3.3333", "3.3334"]);
    expect(await net("2150")).toBe(before);
  });

  it("a USD SHIPMENT against MYR books: the invoice copies the rate, relieves 2150 in USD and base, and not the landed cost", async () => {
    // 3C's OD-05 default (spec:1023; `purchasing/foreign-currency-shipment.test.ts`): the accrual is held in
    // the SUPPLIER's currency, 1000.0000 USD, while the layer is base and carries the allocated freight. The
    // invoice copies the shipment's rate and its provenance (SAH-012), so its 2150 debit is the same USD figure
    // at the same base figure and the corridor closes in both. It invoices the goods accrual (`line.amount`),
    // never the landed cost the line's `cost` carries: the freight is the forwarder's, not this vendor's. The
    // settlement-rate difference is 4A Task 9's `fx_difference` and 4B's posting, not this invoice's.
    await seedCurrency(db, s, { code: "USD" });
    const freightAccrual = await accountByCode(db, s, "5900");
    const beforeGrni = await net("2150");
    const beforeStock = await net("1300");
    const shp = await receive(
      [
        goods("8.000000", "125.0000", "1000.0000"),
        {
          kind: "account",
          accountId: freightAccrual,
          description: "ocean freight, USD",
          amount: "60.0000",
        },
      ],
      "2026-01-20",
      {
        documentTypeId: shipmentType,
        series: "SHP",
        currency: "USD",
        exchangeRate: "4.00000000",
        // The provenance an API-drafted foreign-currency document carries (draftTypedDocument writes none),
        // and the freight allocated onto the goods by value, as 3C's OD-05 case does.
        beforePost: (documentId, lineIds) =>
          withTenant(db.rw, s.tenant, s.human, async (tx) => {
            await tx`update app.document set rate_source = ${`manual:${s.human}`} where id = ${documentId}`;
            await allocateLandedCostForDocument(tx, ctxOf(s), {
              documentId,
              allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
            });
          }),
      },
    );
    // The shipment: 1000 USD of goods at rate 4 into 2150, and the line's cost is the LANDED value in base,
    // (1000 + 60) × 4 — the figure a conversion must not mistake for the vendor's price.
    expect(await net("2150")).toBe(plus4(beforeGrni, "-4000.0000"));
    const [shipped] = await db.admin<{ cost: string | null }[]>`
      select cost::text as cost from app.document_line where id = ${shp.lineIds[0]!}`;
    expect(shipped!.cost).toBe("4240.0000");
    const afterShipment = await net("1300");

    const inv = await invoice({
      sourceDocumentId: shp.documentId,
      effectiveDate: "2026-01-21",
      lines: [],
    });
    const [head] = await db.admin<{ currency: string; rate: string; rateSource: string | null }[]>`
      select currency::text as currency, exchange_rate::text as rate, rate_source as "rateSource"
        from app.document where id = ${inv.documentId}`;
    expect(head).toEqual({ currency: "USD", rate: "4.00000000", rateSource: `manual:${s.human}` });
    expect(await linesOf(inv.documentId)).toEqual([
      { kind: "item", quantity: "8.000000", amount: "1000.0000", total: "1000.0000" },
    ]);
    expect(await legs(inv.documentId)).toEqual([
      {
        code: "2100",
        currency: "USD",
        debit: "0.0000",
        credit: "1000.0000",
        baseDebit: "0.0000",
        baseCredit: "4000.0000",
      },
      {
        code: "2150",
        currency: "USD",
        debit: "1000.0000",
        credit: "0.0000",
        baseDebit: "4000.0000",
        baseCredit: "0.0000",
      },
    ]);
    // 2150 is back where it started in base AND in the supplier's currency; 1300 is the shipment's alone.
    expect(await net("2150")).toBe(beforeGrni);
    const [usd] = await db.admin<{ net: string }[]>`
      select coalesce(sum(e.debit - e.credit), 0)::numeric(19,4)::text as net
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where a.company_id = ${s.company} and a.code = '2150' and e.currency = 'USD'`;
    expect(usd!.net).toBe("0.0000");
    expect(afterShipment).toBe(plus4(beforeStock, "4240.0000"));
    expect(await net("1300")).toBe(afterShipment);
  });

  it("the type is `accounting` for attachments, though it posts under accounting.purchase.post (§4.14's Module rule)", () => {
    // The loader in `beforeAll` already ran both validations (validateDocumentTypeSeed, validatePolicy against
    // the catalogue) — a file that failed either would have thrown there. This pins the choices.
    const envelope = readPackFile<{
      code: string;
      module: string;
      policy: {
        direction: string;
        lines: unknown[];
        inventory: { effect: string };
        numbering: { series: string };
        approval: { post: string; create: string };
        reversal: { producesType: string };
        dimensions: { required: string[] };
      };
    }>(PACK_ROOT, "document-types", "PURCHASE_INVOICE.json");
    expect(envelope.code).toBe("PURCHASE_INVOICE");
    expect(envelope.module).toBe("accounting");
    expect(envelope.policy.direction).toBe("inbound");
    expect(envelope.policy.inventory.effect).toBe("none"); // ADR 0044
    expect(envelope.policy.numbering.series).toBe("PINV");
    expect(envelope.policy.approval.post).toBe("accounting.purchase.post");
    expect(envelope.policy.approval.create).toBe("accounting.purchase.create");
    expect(envelope.policy.reversal.producesType).toBe("PURCHASE_CREDIT_NOTE");
    // 2150 holds the accrued PRICE, not a cost: no rule of this policy reads `line.cost`, so no cost pair.
    expect(JSON.stringify(envelope.policy.lines)).toContain('"code":"2150"');
    expect(JSON.stringify(envelope.policy.lines)).not.toContain("line.cost");
    // A liability and a clearing account are neither revenue, COGS nor staff cost (spec:1066).
    expect(envelope.policy.dimensions.required).toEqual([]);
    // The purchase ORDER, SHIPMENT and GOODS_RECEIPT are `inventory` (3C) because the warehouse files their
    // paperwork; the vendor's invoice is filed by the accountant, which is what the column decides (§4.5.8).
  });
});

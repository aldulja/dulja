import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { linkFulfilment } from "../../src/documents/link";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { replaceUnitConversions } from "../../src/inventory/units";
import { issueDocument, postDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedUnit,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
} from "../index";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";
import { seedTypeFromPack } from "../../../../tests/invariants/support/ar-ap";
import { taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

/**
 * MON-02 (2026-11-15 review): `unit_price` is a price per ENTERED unit — a price list line names its unit,
 * the till extends `price × entered quantity`, an order's `amount` is `unit_price × unit_quantity` — and
 * `quantity` is always BASE (0032's trigger). Every place that extends a price into a value must use the
 * entered quantity, or a carton of twelve at 30.0000 a carton is billed 720.0000 instead of 60.0000.
 * MON-14: a price `linkFulfilment` copies onto a taxed draft recomputes the draft's tax.
 *
 * The item has a base unit (PCS, `seedItem`'s) and a carton of twelve (CTN). Every carton case is the
 * reviewer's: 2 CTN at 30.0000 a carton, an order amount of 60.0000.
 */
let db: Db;
let f: TaxFixture;
let doType: string;
let grnType: string;
let soType: string;
let poType: string;
let itemId: string;
let pcs: string;
let ctn: string;
let warehouseId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "entered-unit-price" });

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "entered-unit-price");
  doType = await seedTypeFromPack(db, f.s, "DELIVERY_ORDER");
  grnType = await seedTypeFromPack(db, f.s, "GOODS_RECEIPT");
  soType = await seedTypeFromPack(db, f.s, "SALES_ORDER");
  poType = await seedTypeFromPack(db, f.s, "PURCHASE_ORDER");
  await grantCodes(db, f.s, { codes: ["inventory.receipt.post", "inventory.transfer.post"] });
  ({ itemId, baseUnitId: pcs } = await seedItem(db, f.s, {
    code: "IT-CTN",
    kind: "product",
    trackLots: false,
  }));
  ctn = await seedUnit(db, f.s, { code: "CTN" });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    replaceUnitConversions(tx, itemId, [{ unitId: ctn, numerator: "12", denominator: "1" }]),
  );
  warehouseId = await seedWarehouse(db, f.s, { code: "WH-CTN" });
  // Five hundred pieces in base units at 1.0000, so no delivery below runs the warehouse short.
  const grn = await draftTypedDocument(db, f.s, {
    documentTypeId: grnType,
    series: "GRN",
    effectiveDate: "2026-01-05",
    partyId: f.vendorId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        unitId: pcs,
        quantity: "500.000000",
        unitPrice: "1.0000",
        amount: "500.0000",
      },
    ],
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    postDocument(tx, ctx(), { documentId: grn.documentId, jobs: recordingJobs() }),
  );
}, 240_000);
afterAll(async () => {
  await db?.stop();
});

async function linesOf(documentId: string) {
  return db.admin<
    {
      amount: string;
      unitPrice: string | null;
      quantity: string;
      taxAmount: string;
      total: string;
    }[]
  >`
    select amount::text as amount, unit_price::text as "unitPrice", quantity::text as quantity,
           tax_amount::text as "taxAmount", total_incl_tax::text as total
      from app.document_line where document_id = ${documentId} order by line_no`;
}

async function ledger(documentId: string, code: string) {
  const [row] = await db.admin<{ debit: string; credit: string }[]>`
    select coalesce(sum(e.debit), 0)::numeric(19,4)::text as debit,
           coalesce(sum(e.credit), 0)::numeric(19,4)::text as credit
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId} and a.code = ${code}`;
  return row!;
}

/** A posted DELIVERY_ORDER of one carton line at 30.0000 a carton and NO amount (a delivery recognises none). */
async function deliverCartons(cartons: string, pieces: string) {
  const { documentId } = await draftTypedDocument(db, f.s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate: "2026-01-20",
    partyId: f.customerId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        unitId: ctn,
        unitQuantity: cartons,
        quantity: pieces,
        unitPrice: "30.0000",
        amount: "0.0000",
      },
    ],
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
  );
  return documentId;
}

function convert(
  sourceDocumentId: string,
  typeCode: "SALES_INVOICE" | "PURCHASE_INVOICE",
  lines: { sourceLineId: string; quantity: string }[] = [],
) {
  return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    convertToInvoice(tx, ctx(), {
      companyId: f.s.company,
      sourceDocumentId,
      targetDocumentTypeId: f.types[typeCode]!,
      targetSeries: typeCode === "SALES_INVOICE" ? "INV" : "PINV",
      effectiveDate: "2026-01-21",
      lines,
    }),
  );
}

describe("MON-02 — a price is per ENTERED unit, so a carton is extended over cartons, never pieces", () => {
  it("DELIVERY_ORDER → SALES_INVOICE: 2 CTN at 30.0000 a carton invoices 60.0000, not 720.0000", async () => {
    const delivery = await deliverCartons("2.000000", "24.000000");
    const inv = await convert(delivery, "SALES_INVOICE");
    const [line] = await linesOf(inv.documentId);
    expect(line!.amount).toBe("60.0000");
    expect(line!.quantity).toBe("24.000000"); // the base quantity is unchanged
  });

  it("a part conversion pro-rates the carton value by base quantity, and the rest completes it exactly", async () => {
    const delivery = await deliverCartons("2.000000", "24.000000");
    const [srcLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${delivery}`;
    const first = await convert(delivery, "SALES_INVOICE", [
      { sourceLineId: srcLine!.id, quantity: "7.000000" },
    ]);
    const rest = await convert(delivery, "SALES_INVOICE");
    // 60 × 7/24 = 17.5000; the completing conversion takes the residue.
    expect((await linesOf(first.documentId))[0]!.amount).toBe("17.5000");
    expect((await linesOf(rest.documentId))[0]!.amount).toBe("42.5000");
  });

  it("SALES_ORDER → DELIVERY_ORDER → SALES_INVOICE: the order's 60.0000 is what the invoice bills", async () => {
    const order = await draftTypedDocument(db, f.s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-20",
      partyId: f.customerId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          unitPrice: "30.0000",
          amount: "60.0000",
        },
      ],
    });
    const delivery = await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: order.documentId });
      const d = await convertOrderToDelivery(tx, ctx(), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-20",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "24.000000" }],
      });
      await postDocument(tx, ctx(), { documentId: d.documentId, jobs: recordingJobs() });
      return d;
    });
    const inv = await convert(delivery.documentId, "SALES_INVOICE");
    expect((await linesOf(inv.documentId))[0]!.amount).toBe("60.0000");
  });

  it("PURCHASE_ORDER → GOODS_RECEIPT (priced by the link) → PURCHASE_INVOICE: 60.0000 at every step", async () => {
    const order = await draftTypedDocument(db, f.s, {
      documentTypeId: poType,
      series: "PO",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          unitPrice: "30.0000",
          amount: "60.0000",
        },
      ],
    });
    // The receipt line carries the carton quantity and NO price: the link prices it (spec:1050).
    const receipt = await draftTypedDocument(db, f.s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: order.documentId });
      await linkFulfilment(tx, ctx(), {
        sourceDocumentId: order.documentId,
        targetDocumentId: receipt.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: order.lineIds[0]!,
            targetLineId: receipt.lineIds[0]!,
            quantity: "24.000000",
          },
        ],
      });
    });
    expect((await linesOf(receipt.documentId))[0]).toMatchObject({
      amount: "60.0000",
      unitPrice: "30.0000",
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      postDocument(tx, ctx(), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );
    expect((await ledger(receipt.documentId, "2150")).credit).toBe("60.0000");
    const pinv = await convert(receipt.documentId, "PURCHASE_INVOICE");
    expect((await linesOf(pinv.documentId))[0]!.amount).toBe("60.0000");
  });

  it("a receipt drafted in PIECES against a carton order is priced per piece and valued at the order's figure", async () => {
    const order = await draftTypedDocument(db, f.s, {
      documentTypeId: poType,
      series: "PO",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          unitPrice: "30.0000",
          amount: "60.0000",
        },
      ],
    });
    const receipt = await draftTypedDocument(db, f.s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      warehouseId,
      lines: [{ kind: "item", itemId, warehouseId, unitId: pcs, quantity: "18.000000" }],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: order.documentId });
      await linkFulfilment(tx, ctx(), {
        sourceDocumentId: order.documentId,
        targetDocumentId: receipt.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: order.lineIds[0]!,
            targetLineId: receipt.lineIds[0]!,
            quantity: "18.000000",
          },
        ],
      });
    });
    // 18 pieces = 1.5 cartons at 30.0000 = 45.0000; the price re-expressed per piece is 2.5000.
    expect((await linesOf(receipt.documentId))[0]).toMatchObject({
      amount: "45.0000",
      unitPrice: "2.5000",
    });
  });

  it("a base-unit line is unchanged: 4 pieces at 9.0000 with no amount invoices 36.0000", async () => {
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: doType,
      series: "DO",
      effectiveDate: "2026-01-20",
      partyId: f.customerId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId: pcs,
          quantity: "4.000000",
          unitPrice: "9.0000",
          amount: "0.0000",
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
    );
    const inv = await convert(documentId, "SALES_INVOICE");
    expect((await linesOf(inv.documentId))[0]!.amount).toBe("36.0000");
  });
});

describe("MON-14 — a price copied by linkFulfilment recomputes the draft's tax", () => {
  it("a taxed SALES_INVOICE draft priced from its delivery carries the tax, not a stale zero", async () => {
    const delivery = await deliverCartons("2.000000", "24.000000");
    const [srcLine] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${delivery}`;
    const inv = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types.SALES_INVOICE!,
      series: "INV",
      effectiveDate: "2026-01-21",
      partyId: f.customerId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          taxCodeId: f.codes["SYN-OUT-STD"]!,
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      linkFulfilment(tx, ctx(), {
        sourceDocumentId: delivery,
        targetDocumentId: inv.documentId,
        linkKind: "converts_to",
        lines: [
          { sourceLineId: srcLine!.id, targetLineId: inv.lineIds[0]!, quantity: "24.000000" },
        ],
      }),
    );
    // 60.0000 net at the synthetic 11% = 6.6000 tax.
    expect((await linesOf(inv.documentId))[0]).toMatchObject({
      amount: "60.0000",
      taxAmount: "6.6000",
      total: "66.6000",
    });
  });

  it("a taxed PURCHASE_INVOICE draft priced from its receipt posts, its tax on 1350 (no line is PUT again)", async () => {
    const receipt = await draftTypedDocument(db, f.s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-20",
      partyId: f.vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          unitPrice: "30.0000",
          amount: "60.0000",
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      postDocument(tx, ctx(), { documentId: receipt.documentId, jobs: recordingJobs() }),
    );
    const pinv = await draftTypedDocument(db, f.s, {
      documentTypeId: f.types.PURCHASE_INVOICE!,
      series: "PINV",
      effectiveDate: "2026-01-21",
      partyId: f.vendorId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: ctn,
          unitQuantity: "2.000000",
          quantity: "24.000000",
          taxCodeId: f.codes["SYN-IN-STD"]!,
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      linkFulfilment(tx, ctx(), {
        sourceDocumentId: receipt.documentId,
        targetDocumentId: pinv.documentId,
        linkKind: "converts_to",
        lines: [
          {
            sourceLineId: receipt.lineIds[0]!,
            targetLineId: pinv.lineIds[0]!,
            quantity: "24.000000",
          },
        ],
      }),
    );
    expect((await linesOf(pinv.documentId))[0]).toMatchObject({
      amount: "60.0000",
      taxAmount: "6.6000",
      total: "66.6000",
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: pinv.documentId });
      await postDocument(tx, ctx(), { documentId: pinv.documentId });
    });
    expect((await ledger(pinv.documentId, "1350")).debit).toBe("6.6000");
    expect((await ledger(pinv.documentId, "2100")).credit).toBe("66.6000");
  });
});

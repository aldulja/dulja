import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { linkFulfilment } from "../../src/documents/link";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { issueDocument, postDocument, voidDocument } from "../../src/posting";
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedLot,
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
 * PR 11 review, round 3 — an order line's `discount` is a LINE total (`amount = unit_price × quantity −
 * discount`, 3C's price copy), and `convertOrderToDelivery` copied the whole of it onto every delivery line it
 * drafted: each FEFO lot split, the shortfall pair, and every partial delivery of the line. 4A's
 * `convertToInvoice` values a delivery line as `unit_price × quantity − discount`, so an order line of
 * 10 × 10.0000 less 5.0000 split 6 + 4 across two lots was invoiced 90.0000 — the discount taken twice — and,
 * since Phase 5 carries the order's code onto the invoice, taxed on 90.
 *
 * Each drafted line now carries the order discount PRO RATA to its quantity (`Money.multiply` by the exact
 * rational, HALF_AWAY_FROM_ZERO), and the line that completes the order line takes the RESIDUE: the order
 * discount less what earlier drafted lines of this call and earlier deliveries of that order line already
 * carry — the deliveries whose claim the open-quantity view counts (not void; reversed only while its claim
 * stands). The proofs run on the shipped pack's types (SALES_ORDER, DELIVERY_ORDER, SALES_INVOICE v2) and its
 * synthetic 11 % code.
 */
let db: Db;
let f: TaxFixture;
let soType: string;
let doType: string;
let grnType: string;
let unitId: string;
let warehouseId: string;
const ctx = () => ({ tenantId: f.s.tenant, actorId: f.s.human, requestId: "fefo-discount" });

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "fefo-discount");
  soType = await seedTypeFromPack(db, f.s, "SALES_ORDER");
  doType = await seedTypeFromPack(db, f.s, "DELIVERY_ORDER");
  grnType = await seedTypeFromPack(db, f.s, "GOODS_RECEIPT");
  await grantCodes(db, f.s, { codes: ["inventory.receipt.post", "inventory.transfer.post"] });
  unitId = await seedUnit(db, f.s, { code: "PCS" });
  warehouseId = await seedWarehouse(db, f.s, { code: "WH-DISC" });
}, 240_000);
afterAll(async () => {
  await db?.stop();
});

/** A lot-tracked product, and a GOODS_RECEIPT putting `quantity` of it into each lot named, at 3.0000 a unit
 *  (`amount` is that extension, written out). Every lot is dated 2099 so migration 0112's past-expiry skip
 *  never drops one; the first named expires first. */
async function stockedItem(
  code: string,
  lots: readonly { code: string; quantity: string; amount: string }[],
) {
  const { itemId } = await seedItem(db, f.s, { code, trackLots: true, baseUnitId: unitId });
  const lotIds: string[] = [];
  for (const [i, lot] of lots.entries()) {
    const lotId = await seedLot(db, f.s, {
      itemId,
      code: `${code}-${lot.code}`,
      expiresOn: `2099-0${i + 3}-28`,
    });
    lotIds.push(lotId);
    const { documentId } = await draftTypedDocument(db, f.s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-02-02",
      partyId: f.vendorId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: lot.quantity,
          unitPrice: "3.0000",
          amount: lot.amount,
        },
      ],
    });
    await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
      postDocument(tx, ctx(), { documentId, jobs: recordingJobs() }),
    );
  }
  return { itemId, lotIds };
}

/** An issued SALES_ORDER of one line at 10.0000 a unit, less `discount` (`amount` is the net, written out),
 *  coded SYN-OUT-STD. */
async function order(itemId: string, line: { quantity: string; discount: string; amount: string }) {
  const { quantity, discount, amount } = line;
  const o = await draftTypedDocument(db, f.s, {
    documentTypeId: soType,
    series: "SO",
    effectiveDate: "2026-02-03",
    partyId: f.customerId,
    lines: [
      {
        kind: "item",
        itemId,
        unitId,
        quantity,
        unitPrice: "10.0000",
        discount,
        amount,
        taxCodeId: f.codes["SYN-OUT-STD"]!,
      },
    ],
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    issueDocument(tx, ctx(), { documentId: o.documentId }),
  );
  return { documentId: o.documentId, lineId: o.lineIds[0]! };
}

function deliver(o: { documentId: string; lineId: string }, quantity: string, fefo: boolean) {
  return withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    convertOrderToDelivery(tx, ctx(), {
      sourceDocumentId: o.documentId,
      targetDocumentTypeId: doType,
      targetSeries: "DO",
      effectiveDate: "2026-02-04",
      warehouseId,
      fefo,
      lines: [{ sourceLineId: o.lineId, quantity }],
    }),
  );
}

/** The drafted delivery's lines as stored: [lot, quantity, discount] in line order. */
function deliveryLines(documentId: string) {
  return db.admin<{ lot_id: string | null; quantity: string; discount: string }[]>`
    select lot_id, quantity::text as quantity, discount::text as discount
      from app.document_line where document_id = ${documentId} order by line_no`;
}

/** A DELIVERY_ORDER drafted through the generic path and linked `fulfils` to the order line (3C's client path,
 *  `POST …/links`), carrying `quantity` units at the discount its client keyed. Returns its document id. */
async function clientDelivery(
  o: { documentId: string; lineId: string },
  itemId: string,
  quantity: string,
  discount: string,
): Promise<string> {
  const client = await draftTypedDocument(db, f.s, {
    documentTypeId: doType,
    series: "DO",
    effectiveDate: "2026-02-04",
    partyId: f.customerId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        unitId,
        quantity,
        unitPrice: "10.0000",
        discount,
        amount: "0.0000",
      },
    ],
  });
  await withTenant(db.rw, f.s.tenant, f.s.human, (tx) =>
    linkFulfilment(tx, ctx(), {
      sourceDocumentId: o.documentId,
      targetDocumentId: client.documentId,
      linkKind: "fulfils",
      lines: [{ sourceLineId: o.lineId, targetLineId: client.lineIds[0]!, quantity }],
      priceFromSource: false,
    }),
  );
  return client.documentId;
}

/** Every claim on the order line, as `link_kind:quantity` — what a refused conversion must leave untouched. */
async function claims(o: { lineId: string }): Promise<string[]> {
  const rows = await db.admin<{ claim: string }[]>`
    select link_kind || ':' || quantity::text as claim
      from app.document_link where source_line_id = ${o.lineId} order by created_at`;
  return rows.map((r) => r.claim);
}

/** The review's order line: 10 × 10.0000 less 5.0000. */
const TEN_LESS_FIVE = { quantity: "10.000000", discount: "5.0000", amount: "95.0000" };

describe("convertOrderToDelivery — an order line's discount is shared, never copied (PR 11 review, round 3)", () => {
  it("a 6 + 4 FEFO split carries 3.0000 + 2.0000, and the invoice is 95.0000, taxed on 95.0000", async () => {
    const { itemId, lotIds } = await stockedItem("DISC-SPLIT", [
      { code: "A", quantity: "6.000000", amount: "18.0000" },
      { code: "B", quantity: "4.000000", amount: "12.0000" },
    ]);
    const o = await order(itemId, TEN_LESS_FIVE);
    const d = await deliver(o, "10.000000", true);
    // Soft, so a regression reports what the invoice then charges as well as the split that caused it.
    expect.soft(await deliveryLines(d.documentId)).toEqual([
      { lot_id: lotIds[0], quantity: "6.000000", discount: "3.0000" },
      { lot_id: lotIds[1], quantity: "4.000000", discount: "2.0000" },
    ]);

    const invoiced = await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await postDocument(tx, ctx(), { documentId: d.documentId, jobs: recordingJobs() });
      const r = await convertToInvoice(tx, ctx(), {
        companyId: f.s.company,
        sourceDocumentId: d.documentId,
        targetDocumentTypeId: f.types["SALES_INVOICE"]!,
        targetSeries: "INV",
        effectiveDate: "2026-02-05",
        lines: [],
      });
      await issueDocument(tx, ctx(), { documentId: r.documentId });
      await postDocument(tx, ctx(), { documentId: r.documentId });
      return r.documentId;
    });
    const [lines] = await db.admin<{ amount: string; tax: string }[]>`
      select sum(amount)::text as amount, sum(tax_amount)::text as tax
        from app.document_line where document_id = ${invoiced}`;
    expect(lines).toEqual({ amount: "95.0000", tax: "10.4500" });
    const [taxed] = await db.admin<{ base: string; tax: string }[]>`
      select sum(base)::text as base, sum(tax)::text as tax
        from app.tax_transaction where document_id = ${invoiced}`;
    expect(taxed).toEqual({ base: "95.0000", tax: "10.4500" });
  });

  it("two partial deliveries, 3 then 7, carry 1.5000 then the residue 3.5000", async () => {
    const { itemId } = await stockedItem("DISC-PART", []);
    const o = await order(itemId, TEN_LESS_FIVE);
    const first = await deliver(o, "3.000000", false);
    expect((await deliveryLines(first.documentId)).map((l) => l.discount)).toEqual(["1.5000"]);
    const second = await deliver(o, "7.000000", false);
    expect((await deliveryLines(second.documentId)).map((l) => l.discount)).toEqual(["3.5000"]);
  });

  it("thirds of an awkward discount round each share and the completing delivery takes the residue", async () => {
    const { itemId } = await stockedItem("DISC-THIRDS", []);
    const o = await order(itemId, { quantity: "3.000000", discount: "1.0000", amount: "29.0000" });
    const shares: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await deliver(o, "1.000000", false);
      shares.push(...(await deliveryLines(d.documentId)).map((l) => l.discount));
    }
    expect(shares).toEqual(["0.3333", "0.3333", "0.3334"]);
  });

  it("the shortfall pair shares the discount with the lot it follows", async () => {
    // One lot holds 6 of the 10 asked; FEFO picks it and the uncovered 4 becomes the null-lot pair.
    const { itemId, lotIds } = await stockedItem("DISC-SHORT", [
      { code: "A", quantity: "6.000000", amount: "18.0000" },
    ]);
    const o = await order(itemId, TEN_LESS_FIVE);
    const d = await deliver(o, "10.000000", true);
    expect(await deliveryLines(d.documentId)).toEqual([
      { lot_id: lotIds[0], quantity: "6.000000", discount: "3.0000" },
      { lot_id: null, quantity: "4.000000", discount: "2.0000" },
    ]);
  });

  it("a whole-line delivery carries the whole discount, as before", async () => {
    const { itemId } = await stockedItem("DISC-WHOLE", []);
    const o = await order(itemId, TEN_LESS_FIVE);
    const d = await deliver(o, "10.000000", false);
    expect(await deliveryLines(d.documentId)).toEqual([
      { lot_id: null, quantity: "10.000000", discount: "5.0000" },
    ]);
  });

  it("a voided delivery's share is released: the residue falls on the delivery that really completes", async () => {
    // Thirds again, after a first delivery of one unit is voided. Counted, the void would make the SECOND
    // live delivery look like the completing one (1 + 1 + 1 = 3) and hand it the residue 0.3334, leaving the
    // third a pro-rata 0.3333 — the order discount carried in the wrong place.
    const { itemId } = await stockedItem("DISC-VOID", []);
    const o = await order(itemId, { quantity: "3.000000", discount: "1.0000", amount: "29.0000" });
    const voided = await deliver(o, "1.000000", false);
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: voided.documentId });
      await voidDocument(tx, ctx(), { documentId: voided.documentId, reason: "picked in error" });
    });
    const shares: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const d = await deliver(o, "1.000000", false);
      shares.push(...(await deliveryLines(d.documentId)).map((l) => l.discount));
    }
    expect(shares).toEqual(["0.3333", "0.3333", "0.3334"]);
  });

  it("a client-drafted `fulfils` delivery's discount counts, so the order's discount is carried exactly once", async () => {
    // A delivery drafted through the API and linked `fulfils` (3C's client path) carries the discount its
    // client keyed — here 1.0000 on 4 of the 10, not the pro-rata 2.0000. The service delivery of the other 6
    // completes the line and takes the residue, 4.0000, so the two deliveries carry 5.0000 between them.
    const { itemId } = await stockedItem("DISC-CLIENT", []);
    const o = await order(itemId, TEN_LESS_FIVE);
    await clientDelivery(o, itemId, "4.000000", "1.0000");
    const d = await deliver(o, "6.000000", false);
    expect((await deliveryLines(d.documentId)).map((l) => l.discount)).toEqual(["4.0000"]);
  });
});

// ── PR 11 review, round 3, adversarial pass: a service delivery's share is bounded by the order's discount. ─
describe("convertOrderToDelivery — a delivery never carries more of the discount than is left, nor a surcharge", () => {
  it("many small deliveries never over-carry: rounded shares stop at the order's discount, the residue is 0", async () => {
    // 5 × 10.0000 less 0.0003, one unit at a time. Each pro-rata share is 0.00006, rounded HALF_AWAY_FROM_ZERO to
    // 0.0001, so uncapped the first four would carry 0.0004 of a 0.0003 discount and the fifth — completing —
    // a residue of −0.0001: a surcharge on a pure-service history (ADR 0050 decision 8's opposite-sign limit).
    // Capped at what is left, the fourth carries 0.0000 and the residue is 0.0000.
    const { itemId } = await stockedItem("DISC-TINY", []);
    const o = await order(itemId, { quantity: "5.000000", discount: "0.0003", amount: "49.9997" });
    const shares: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const d = await deliver(o, "1.000000", false);
      shares.push(...(await deliveryLines(d.documentId)).map((l) => l.discount));
    }
    expect(shares).toEqual(["0.0001", "0.0001", "0.0001", "0.0000", "0.0000"]);
  });

  it("after a client delivery carrying more than its pro-rata share, the service carries only what is left", async () => {
    // The client keyed 4.0000 on 4 of the 10 (pro rata it would be 2.0000), which is still within the order's
    // 5.0000. A service delivery of 3 would take 1.5000 pro rata and leave the completing 3 a residue of
    // −0.5000; capped, it takes the 1.0000 left and the completing delivery 0.0000. 4 + 1 + 0 = 5.
    const { itemId } = await stockedItem("DISC-FRONT", []);
    const o = await order(itemId, TEN_LESS_FIVE);
    await clientDelivery(o, itemId, "4.000000", "4.0000");
    const second = await deliver(o, "3.000000", false);
    expect((await deliveryLines(second.documentId)).map((l) => l.discount)).toEqual(["1.0000"]);
    const third = await deliver(o, "3.000000", false);
    expect((await deliveryLines(third.documentId)).map((l) => l.discount)).toEqual(["0.0000"]);
  });

  it("a history already carrying more than the order line's discount is refused, never answered with a surcharge", async () => {
    // The review's probe: a client delivery of 4 keyed 10.0000 against an order line less 5.0000. The service
    // delivery of the other 6 completed the line with a residue of −5.0000, which 4A's conversion invoiced at
    // 65.0000 for 60.0000 of goods and taxed on 65. The history is wrong whichever delivery meets it, so a
    // non-completing delivery is refused too, and nothing is written.
    const { itemId } = await stockedItem("DISC-OVER", []);
    const o = await order(itemId, TEN_LESS_FIVE);
    const client = await clientDelivery(o, itemId, "4.000000", "10.0000");
    for (const quantity of ["6.000000", "3.000000"]) {
      await expect(deliver(o, quantity, false)).rejects.toThrow(
        new RegExp(
          `^ERR_VALIDATION_FAILED: order line 1 cannot be delivered: delivery ${client} already carries ` +
            "a discount of 10\\.0000 of the order line's 5\\.0000",
        ),
      );
    }
    expect(await claims(o)).toEqual(["fulfils:4.000000"]);
  });

  it("a history whose discount runs against the order line's sign is refused, and so is any on an undiscounted line", async () => {
    // −1.0000 on the client's 4 would leave the completing 6 a residue of 6.0000: more than the order gave.
    // On a line with no discount at all, any discount a delivery carries is the same fault in its own sign.
    const { itemId } = await stockedItem("DISC-SIGN", []);
    const negative = await order(itemId, TEN_LESS_FIVE);
    const surcharged = await clientDelivery(negative, itemId, "4.000000", "-1.0000");
    await expect(deliver(negative, "6.000000", false)).rejects.toThrow(
      new RegExp(
        `^ERR_VALIDATION_FAILED: order line 1 cannot be delivered: delivery ${surcharged} `,
      ),
    );
    expect(await claims(negative)).toEqual(["fulfils:4.000000"]);

    const undiscounted = await order(itemId, {
      quantity: "10.000000",
      discount: "0.0000",
      amount: "100.0000",
    });
    const discounted = await clientDelivery(undiscounted, itemId, "4.000000", "1.0000");
    await expect(deliver(undiscounted, "6.000000", false)).rejects.toThrow(
      new RegExp(
        `^ERR_VALIDATION_FAILED: order line 1 cannot be delivered: delivery ${discounted} already ` +
          "carries a discount of 1\\.0000 of the order line's 0\\.0000",
      ),
    );
    expect(await claims(undiscounted)).toEqual(["fulfils:4.000000"]);
  });

  it("the refusal's remedy releases it: once the client delivery is voided, the service delivers the line", async () => {
    // PR 11 review, round 3, second adversarial pass: the refusal holds the rest of an undiscounted line for as
    // long as a client delivery of it carries an allowance. Its message names the way out — correct the draft,
    // void it if issued, reverse it if posted — and this pins that the way out works: a voided delivery's claim
    // and its discount are released together, so the service then delivers the whole line at no discount.
    const { itemId } = await stockedItem("DISC-REMEDY", []);
    const o = await order(itemId, {
      quantity: "10.000000",
      discount: "0.0000",
      amount: "100.0000",
    });
    const client = await clientDelivery(o, itemId, "4.000000", "1.0000");
    await expect(deliver(o, "6.000000", false)).rejects.toThrow(
      /^ERR_VALIDATION_FAILED: order line 1 /,
    );
    await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      await issueDocument(tx, ctx(), { documentId: client });
      await voidDocument(tx, ctx(), { documentId: client, reason: "allowance keyed in error" });
    });
    const d = await deliver(o, "10.000000", false);
    expect(await deliveryLines(d.documentId)).toEqual([
      { lot_id: null, quantity: "10.000000", discount: "0.0000" },
    ]);
  });
});

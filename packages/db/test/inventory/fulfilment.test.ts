import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { issueDocument, postDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedLot,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { ctxOf, DELIVERY_ORDER_POLICY, GRN_POLICY, SALES_ORDER_POLICY } from "./policies";

describe("convertOrderToDelivery — SALES_ORDER → DELIVERY_ORDER (spec:1050-1051, §4.14)", () => {
  let db: Db;
  let s: Seed;
  let soType: string;
  let doType: string;
  let grnType: string;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let partyId: string;
  let lotEarly: string;
  let lotLate: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-fulfil");
    // `grantCodes(db, s)` with no `codes` grants NOTHING (its docstring), and 2B's R2 evaluates
    // GRN_POLICY's `approval.post` inside the posting transaction that `receive()` below opens.
    await grantCodes(db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
    await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    // `2150` is GRN_POLICY's credit leg. Without it `receive()` below raises ERR_POLICY_REQUIRES_MISSING at
    // post (§4.4.1: an §4.15 account code the company cannot resolve is a 422, never a null-account
    // fallback), and the FEFO cases would fail on an empty warehouse rather than on their own claim.
    await seedAccount(db, s, {
      code: "2150",
      nameEn: "Goods received not invoiced",
      type: "liability",
    });
    soType = await seedDocumentType(db, s, {
      code: "SALES_ORDER",
      module: "inventory",
      policy: SALES_ORDER_POLICY,
    });
    doType = await seedDocumentType(db, s, {
      code: "DELIVERY_ORDER",
      module: "inventory",
      policy: DELIVERY_ORDER_POLICY,
    });
    grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-MAIN" });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-FEFO", trackLots: true, baseUnitId: unitId }));
    // The FEFO proof needs two lots whose expiry order is the OPPOSITE of their insertion order,
    // so a query that happened to return them by ctid would fail this test. Both are dated 2099: migration
    // 0112 makes `pick_lots_fefo` skip a lot already past its expiry on the SERVER's `current_date`, so a
    // build-year date silently drops that lot from every FEFO pick once the calendar passes it.
    lotLate = await seedLot(db, s, { itemId, code: "LOT-DEC", expiresOn: "2099-12-31" });
    lotEarly = await seedLot(db, s, { itemId, code: "LOT-MAR", expiresOn: "2099-03-31" });
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** Puts stock in both lots through a GOODS_RECEIPT (3C) — the only legitimate way stock exists.
   *  `warehouseId` is on the HEADER as well as the line: `GRN_POLICY` declares
   *  `requires: ["party", "warehouse"]` and §4.3.2 step 4's `validateRequires` reads the header. */
  async function receive(lotId: string, qty: string, amount: string): Promise<void> {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          lotId,
          unitId,
          quantity: qty,
          unitPrice: "3.0000",
          amount,
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }

  it("converts a partial quantity, links with `converts_to` and leaves the rest open", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-10",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "10.000000",
          unitPrice: "5.0000",
          amount: "50.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "4.000000" }],
      }),
    );

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.quantity).toBe("4.000000");
    expect(result.lines[0]!.lotId).toBeNull();
    expect(result.links.map((l) => l.linkKind)).toEqual(["converts_to"]);
    expect(result.remaining[0]!.openQuantity).toBe("6.000000");
  });

  it("FEFO splits one order line into one drafted line per lot, earliest expiry first", async () => {
    await receive(lotLate, "5.000000", "15.0000");
    await receive(lotEarly, "3.000000", "9.0000");
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-15",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "4.000000",
          unitPrice: "5.0000",
          amount: "20.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-16",
        warehouseId,
        fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "4.000000" }],
      }),
    );

    // LOT-MAR expires 2099-03-31 and LOT-DEC 2099-12-31, so the March lot is exhausted first.
    expect(result.lines.map((l) => [l.lotId, l.quantity])).toEqual([
      [lotEarly, "3.000000"],
      [lotLate, "1.000000"],
    ]);
    expect(result.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it("a quantity ABOVE on-hand drafts the FULL quantity — N lot pairs plus one null-lot shortfall pair", async () => {
    // The two receipts above put 3 in LOT-MAR and 5 in LOT-DEC and nothing has been posted out, so 8 units
    // exist. Asking for 12 must draft 12, not 8: `app.pick_lots_fefo` caps its picks at what each lot holds
    // and returns fewer rows than asked (3A), and a conversion that accepted that cap would silently ship
    // less than the customer ordered, link only the capped quantity, and make the negative-stock override
    // path unreachable — test 18's re-run (Task 6) and test 7's "gone negative" leg (Task 11) both go
    // through exactly this call.
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-17",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "12.000000",
          unitPrice: "5.0000",
          amount: "60.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-18",
        warehouseId,
        fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "12.000000" }],
      }),
    );

    expect(result.lines.map((l) => [l.lotId, l.quantity])).toEqual([
      [lotEarly, "3.000000"],
      [lotLate, "5.000000"],
      [null, "4.000000"], // the uncovered remainder; applyMovements resolves the NONE sentinel
    ]);
    // The drafted quantity is exactly what was asked, and the WHOLE of it is linked to the order line, so
    // the order closes and 3C's over-fulfilment guard would fire on a second conversion.
    expect(result.remaining[0]!.openQuantity).toBe("0.000000");
  });

  it("a quantity above the open quantity is refused by 3C's guard", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-20",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "2.000000",
          unitPrice: "5.0000",
          amount: "10.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convertOrderToDelivery(tx, ctxOf(s), {
          sourceDocumentId: order.documentId,
          targetDocumentTypeId: doType,
          targetSeries: "DO",
          effectiveDate: "2026-01-21",
          warehouseId,
          fefo: false,
          lines: [{ sourceLineId: order.lineIds[0]!, quantity: "3.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });

  it("a DRAFT source is refused — 3C's link source must be issued or posted", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-22",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "1.000000",
          unitPrice: "5.0000",
          amount: "5.0000",
        },
      ],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convertOrderToDelivery(tx, ctxOf(s), {
          sourceDocumentId: order.documentId,
          targetDocumentTypeId: doType,
          targetSeries: "DO",
          effectiveDate: "2026-01-23",
          warehouseId,
          fefo: false,
          lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: source document .* is draft, not issued or posted/);
  });

  it("a source line id that is not on the source document is ERR_NOT_FOUND", async () => {
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-24",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "1.000000",
          unitPrice: "5.0000",
          amount: "5.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );
    const stranger = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-24",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: "1.000000",
          unitPrice: "5.0000",
          amount: "5.0000",
        },
      ],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        convertOrderToDelivery(tx, ctxOf(s), {
          sourceDocumentId: order.documentId,
          targetDocumentTypeId: doType,
          targetSeries: "DO",
          effectiveDate: "2026-01-25",
          warehouseId,
          fefo: false,
          lines: [{ sourceLineId: stranger.lineIds[0]!, quantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document line .* is not a line of document/);
  });
});

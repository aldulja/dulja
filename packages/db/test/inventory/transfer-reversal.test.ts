import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import { draftTransfer, draftTransferReceipt } from "../../src/inventory/transfer";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { ctxOf, GRN_POLICY, TRANSFER_POLICY, TRANSFER_RECEIPT_POLICY } from "./policies";
import { ensureOpenPeriods } from "../../../../tests/invariants/support/post-inventory";

/**
 * Review MON-03 (2026-11-15): reversing a TRANSFER dispatch that a TRANSFER_RECEIPT has received against.
 *
 * Every dispatch to a branch shares that branch's one in-transit warehouse. Once dispatch A is received its
 * units have left the corridor, so a mirror of A would issue ANOTHER dispatch's units out of transit back to
 * the sender: the sender's books gain stock it never got back and the other shipment's receipt is then short.
 * `reverseDocument` refused partial credits, `returns` links, unposted `converts_to` targets and live
 * allocations, but never counted `receives_against`. A dispatch with a posted receipt, or with a draft or issued one,
 * is now refused; a void receipt has released its claim.
 */
describe("TRANSFER reversal against its receipts (review MON-03)", () => {
  let db: Db;
  let s: Seed;
  let trfType: string;
  let trrType: string;
  let itemId: string;
  let unitId: string;
  let whHq: string;
  let whBranch: string;
  let whTransit: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-mon-03");
    await ensureOpenPeriods(db, s, 2026);
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    const acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
    await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
    await seedAccount(db, s, {
      code: "2150",
      nameEn: "Goods received not invoiced",
      type: "liability",
    });
    trfType = await seedDocumentType(db, s, {
      code: "TRANSFER",
      module: "inventory",
      policy: TRANSFER_POLICY,
    });
    trrType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT",
      module: "inventory",
      policy: TRANSFER_RECEIPT_POLICY,
    });
    const grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    const partyId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    const branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
    whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    whTransit = await seedWarehouse(db, s, {
      code: "WH-BR2-TR",
      kind: "in_transit",
      branchId: branchB,
    });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-MON03",
      trackLots: false,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whHq,
          unitId,
          quantity: "100.000000",
          unitPrice: "5.0000",
          amount: "500.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }, 240_000);
  afterAll(async () => {
    await db?.stop();
  });

  async function dispatch(qty: string, effectiveDate: string) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq,
        toWarehouseId: whBranch,
        effectiveDate,
        series: "TRF",
        documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: qty }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      return drafted;
    });
  }

  /** Draft (and, when `post`, issue and post) a full receipt of `transfer`. */
  async function receive(transfer: { documentId: string }, effectiveDate: string, post: boolean) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: transfer.documentId,
        documentTypeId: trrType,
        series: "TRR",
        effectiveDate,
      });
      if (post) {
        await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
        await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      }
      return drafted;
    });
  }

  const reverse = (documentId: string, effectiveDate: string) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), { documentId, effectiveDate, reason: "MON-03" }),
    );

  const onHand = async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ hq: string; br: string; tr: string }[]>`
        select coalesce(sum(quantity) filter (where warehouse_id = ${whHq}), 0)::text      as hq,
               coalesce(sum(quantity) filter (where warehouse_id = ${whBranch}), 0)::text  as br,
               coalesce(sum(quantity) filter (where warehouse_id = ${whTransit}), 0)::text as tr
          from app.stock_on_hand where item_id = ${itemId}`,
    );
    return row!;
  };

  const statusOf = async (documentId: string) => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; n: number }[]>`
        select (select status::text from app.document where id = ${documentId}) as status,
               (select count(*)::int from app.document where reverses_document_id = ${documentId}) as n`,
    );
    return row!;
  };

  it("a dispatch whose receipt has POSTED is refused, and another dispatch's goods stay in transit", async () => {
    const a = await dispatch("10.000000", "2026-04-10");
    await receive(a, "2026-04-11", true);
    const b = await dispatch("10.000000", "2026-04-12");
    const before = await onHand();
    expect(before).toEqual({ hq: "80.000000", br: "10.000000", tr: "10.000000" });

    await expect(reverse(a.documentId, "2026-04-13")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL.*transfer receipt/,
    );
    // Nothing moved: no mirror, A still posted, B's 10 still on the truck.
    expect(await statusOf(a.documentId)).toEqual({ status: "posted", n: 0 });
    expect(await onHand()).toEqual(before);
    // And B's own receipt still finds its goods in transit.
    await receive(b, "2026-04-14", true);
    expect(await onHand()).toEqual({ hq: "80.000000", br: "20.000000", tr: "0.000000" });
  });

  it("a dispatch with a DRAFT or ISSUED receipt is refused; voiding the receipt releases it and the reversal then nets", async () => {
    const c = await dispatch("10.000000", "2026-04-20");
    const draft = await receive(c, "2026-04-21", false);
    const before = await onHand();
    expect(before).toEqual({ hq: "70.000000", br: "20.000000", tr: "10.000000" });

    await expect(reverse(c.documentId, "2026-04-22")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL.*transfer receipt/,
    );
    expect(await statusOf(c.documentId)).toEqual({ status: "posted", n: 0 });
    expect(await onHand()).toEqual(before);

    // ISSUED and unposted still holds its claim…
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: draft.documentId }),
    );
    await expect(reverse(c.documentId, "2026-04-22")).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL.*transfer receipt/,
    );
    // …and the remedy the refusal names, voiding the receipt not yet posted, releases it.
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      voidDocument(tx, ctxOf(s), { documentId: draft.documentId, reason: "MON-03 remedy" }),
    );
    await reverse(c.documentId, "2026-04-22");
    expect(await statusOf(c.documentId)).toEqual({ status: "reversed", n: 1 });
    expect(await onHand()).toEqual({ hq: "80.000000", br: "20.000000", tr: "0.000000" });
    // …and a reversed dispatch can no longer be received (draftTransferReceipt takes only a posted one).
    await expect(receive(c, "2026-04-23", false)).rejects.toThrow(/only a posted transfer/);
  });

  it("a dispatch never received still reverses — the guard refuses only what was received against", async () => {
    const d = await dispatch("5.000000", "2026-05-01");
    await reverse(d.documentId, "2026-05-02");
    expect(await statusOf(d.documentId)).toEqual({ status: "reversed", n: 1 });
    expect(await onHand()).toEqual({ hq: "80.000000", br: "20.000000", tr: "0.000000" });
  });
});

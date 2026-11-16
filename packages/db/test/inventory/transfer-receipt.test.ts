import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument, reverseDocument, voidDocument } from "../../src/posting";
import { recordCounts } from "../../src/inventory/count";
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
import type { TenantContext } from "../../src/with-tenant";
import {
  ensureOpenPeriods,
  secondPrincipal,
} from "../../../../tests/invariants/support/post-inventory";

/** ORCH-03's two-connection cases: a promise's outcome, and whether it has settled yet. Module scope, as
 *  `unicorn/consistent-function-scoping` asks of a helper that captures nothing. */
const settled = <T>(p: Promise<T>) => {
  const state = { done: false };
  const outcome = p.then(
    (value) => ((state.done = true), { ok: true as const, value }),
    (error: unknown) => ((state.done = true), { ok: false as const, error }),
  );
  return { state, outcome };
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TRANSFER_RECEIPT — the receive leg and its variance (spec:1053)", () => {
  let db: Db;
  let s: Seed;
  let trfType: string;
  let trrType: string;
  let grnType: string;
  let itemId: string;
  let unitId: string;
  let partyId: string;
  let whHq: string;
  let whBranch: string;
  let whTransit: string;
  let branchB: string;
  let acc1300: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-trr");
    // The last case dispatches on 2026-02-01, which Plan 0A's `seedTenant` seeds CLOSED.
    await ensureOpenPeriods(db, s, 2026);
    // `seedTenant` grants `s.human` NOTHING (§4.1) and 2B's R2 evaluates `approval.post` INSIDE the
    // posting transaction, so without these four every post below is a 403.
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    acc1300 = await seedAccount(db, s, {
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
    grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
    whBranch = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    whTransit = await seedWarehouse(db, s, {
      code: "WH-BR2-TR",
      kind: "in_transit",
      branchId: branchB,
    });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-TRR",
      trackLots: false,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    // One receipt of 100 at 5.0000 into WH-HQ: enough stock for every dispatch below, which together send
    // 61 units (10+10+6+4+3+2+4+10+10+1+1). The 40 first written here ran dry at the eighth dispatch.
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

  /** Dispatch `qty` and return the posted TRANSFER's ids. */
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

  /** Receive `transfer`. `counted === null` omits `received` entirely, which receives everything. */
  async function receive(
    transfer: { documentId: string; lineIds: string[] },
    counted: string | null,
    effectiveDate: string,
  ) {
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: transfer.documentId,
        documentTypeId: trrType,
        series: "TRR",
        effectiveDate,
        ...(counted === null
          ? {}
          : { received: [{ transferLineId: transfer.lineIds[0]!, countedQuantity: counted }] }),
      });
      await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      return drafted;
    });
  }

  /** `e.credit desc` is the THIRD sort key and it is load-bearing. The SHORTFALL case expects two `1310`
   *  rows whose `debit` is `0.0000` on both; `order by a.code, e.debit desc` leaves that pair tied, so
   *  Postgres may return either order and the `toEqual` would pass or fail on plan choice. The credits are
   *  what separate them. */
  const ledgerOf = (documentId: string) =>
    withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.debit::text, e.credit::text
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code, e.debit desc, e.credit desc`,
    );

  const transitQuantity = async (): Promise<string> => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
         where item_id = ${itemId} and warehouse_id = ${whTransit}`,
    );
    return row!.q;
  };

  it("a FULL receipt moves the whole value out of 1310 and posts no variance", async () => {
    const t = await dispatch("10.000000", "2026-01-10");
    const r = await receive(t, "10.000000", "2026-01-11");
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "50.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "50.0000" },
    ]);
    expect(await transitQuantity()).toBe("0.000000"); // the corridor cleared
  });

  it("a SHORTFALL posts the difference to 5110 and still clears 1310 exactly", async () => {
    const t = await dispatch("10.000000", "2026-01-12");
    const r = await receive(t, "8.000000", "2026-01-13");
    // Dispatched 10 at 5.0000 = 50.0000 debited to 1310. Arrived 8 = 40.0000. Missing 2 = 10.0000.
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "40.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "40.0000" },
      { code: "1310", debit: "0.0000", credit: "10.0000" },
      { code: "5110", debit: "10.0000", credit: "0.0000" },
    ]);
    expect(await transitQuantity()).toBe("0.000000"); // 10 in, 10 out: the missing 2 left transit too
  });

  it("the two movements carry DIFFERENT quantities — expected out of transit, counted into the branch", async () => {
    const t = await dispatch("6.000000", "2026-01-14");
    const r = await receive(t, "5.000000", "2026-01-15");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ movement_no: number; warehouse_id: string; quantity: string }[]>`
        select movement_no, warehouse_id, quantity::text
          from app.inventory_movement where document_id = ${r.documentId} order by movement_no`,
    );
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whTransit, quantity: "-6.000000" }, // everything that left
      { movement_no: 2, warehouse_id: whBranch, quantity: "5.000000" }, // what arrived
    ]);
  });

  it("an OVERAGE posts the difference the other way", async () => {
    const t = await dispatch("4.000000", "2026-01-16");
    const r = await receive(t, "5.000000", "2026-01-17");
    const rows = await ledgerOf(r.documentId);
    // Arrived 5 at the transit unit cost 5.0000 = 25.0000; dispatched 4 = 20.0000; over by 5.0000.
    expect(rows).toContainEqual({ code: "1310", debit: "5.0000", credit: "0.0000" });
    expect(rows).toContainEqual({ code: "5110", debit: "0.0000", credit: "5.0000" });
  });

  it("`received` omitted receives everything, so the variance is null and no 5110 row exists", async () => {
    const t = await dispatch("3.000000", "2026-01-18");
    const r = await receive(t, null, "2026-01-19");
    expect((await ledgerOf(r.documentId)).map((x) => x.code)).toEqual(["1300", "1310"]);
  });

  it("the receipt links to the transfer with `receives_against`", async () => {
    const t = await dispatch("2.000000", "2026-01-20");
    const r = await receive(t, "2.000000", "2026-01-21");
    const links = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ link_kind: string; source: string }[]>`
        select link_kind, source_document_id as source
          from app.document_link where target_document_id = ${r.documentId}`,
    );
    expect(links).toEqual([{ link_kind: "receives_against", source: t.documentId }]);
  });

  it("an OVERAGE links at the DISPATCHED quantity — a fulfilment never exceeds what was ordered", async () => {
    // Migration 0037's trigger refuses `linked > ordered` with ERR_DOC_LINK_OVER_FULFILLED. More arriving
    // than left is a VARIANCE to account for (the 5110 legs above), never a larger fulfilment, so the link
    // is capped at the dispatch line's own quantity.
    const t = await dispatch("4.000000", "2026-01-22");
    const r = await receive(t, "6.000000", "2026-01-23");
    const links = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string }[]>`
        select quantity::text from app.document_link where target_document_id = ${r.documentId}`,
    );
    expect(links).toEqual([{ quantity: "4.000000" }]);
  });

  it("a shortfall receipt's movements are asserted by WAREHOUSE and DIRECTION, not by a balance sum", async () => {
    // The direction is the whole content of this type, and Sum(debit) = Sum(credit) is satisfied by every
    // policy-driven document ever posted — it would not have caught a receipt that moved goods the wrong
    // way. So the assertion is the two rows themselves: everything that left the corridor, and only what
    // arrived at the branch.
    const t = await dispatch("10.000000", "2026-01-24");
    const r = await receive(t, "7.000000", "2026-01-25");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        { movement_no: number; warehouse_id: string; quantity: string; value: string }[]
      >`select movement_no, warehouse_id, quantity::text, value::text
          from app.inventory_movement where document_id = ${r.documentId} order by movement_no`,
    );
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whTransit, quantity: "-10.000000", value: "-50.0000" },
      { movement_no: 2, warehouse_id: whBranch, quantity: "7.000000", value: "35.0000" },
    ]);
  });

  it("a TRANSFER_RECEIPT cannot be reversed — the policy forbids it and 1A's guard says so by name", async () => {
    // `document_line.quantity` on this type is the VARIANCE, so `reverseDocument`'s negation would produce
    // a FORWARD move of the variance rather than an undo of the 10-out / 7-in pair. The policy therefore
    // declares `reversal: { allowed: false, producesType: null }` and 1A's `reverseDocument` refuses before
    // it writes anything. A mis-counted receipt is corrected by a STOCK_COUNT at the receiving branch.
    const t = await dispatch("10.000000", "2026-01-26");
    const r = await receive(t, "7.000000", "2026-01-27");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reverseDocument(tx, ctxOf(s), {
          documentId: r.documentId,
          effectiveDate: "2026-01-28",
          reason: "wrong receipt",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);
    // Nothing was written: no reversal document, and the receipt is still `posted`.
    const [counts] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number; status: string }[]>`
        select (select count(*)::int from app.document where reverses_document_id = ${r.documentId}) as n,
               (select status::text from app.document where id = ${r.documentId})                    as status`,
    );
    expect(counts).toEqual({ n: 0, status: "posted" });
  });

  it("a receipt of a transfer that is not posted is refused", async () => {
    const drafted = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq,
        toWarehouseId: whBranch,
        effectiveDate: "2026-01-29",
        series: "TRF",
        documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: "1.000000" }],
      }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: drafted.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate: "2026-01-30",
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: transfer .* is draft/);
  });

  it("a `received` entry naming a line of another document is ERR_NOT_FOUND", async () => {
    const t = await dispatch("1.000000", "2026-01-31");
    const other = await dispatch("1.000000", "2026-02-01");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: t.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate: "2026-02-02",
          received: [{ transferLineId: other.lineIds[0]!, countedQuantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document line .* is not a line of document/);
  });

  // ── Code review 3 (Phase 4), the verification of R3: a drafting service under a type of the wrong shape ──
  // Both services took `documentTypeId` from the caller and asked nothing of it (and both routes take the code
  // from the body). On c7d26b4 a receipt drafted as a TRANSFER, counted 8 of 10, posted Dr 1310 / Cr 1300 at
  // 50.0000 beside -10 out of transit and +8 into WH-BR2: 1300 fell by 50 while the branch's stock rose by 40,
  // and 1310 rose by 50 while transit emptied. Step 6d admitted the line because it carries both count columns.

  it("draftTransferReceipt refuses a type whose policy is not a transfer receipt (TRANSFER), and the same dispatch still receives", async () => {
    const t = await dispatch("10.000000", "2026-02-10");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: t.documentId,
          documentTypeId: trfType,
          series: "TRF",
          effectiveDate: "2026-02-11",
          received: [{ transferLineId: t.lineIds[0]!, countedQuantity: "8.000000" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document type TRANSFER is not a transfer receipt: .*debit item\.inventory_account/,
    );
    // The refusal is the type's: the dispatch is untouched and receives under TRANSFER_RECEIPT.
    const r = await receive(t, "8.000000", "2026-02-11");
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "40.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "40.0000" },
      { code: "1310", debit: "0.0000", credit: "10.0001" },
      { code: "5110", debit: "10.0001", credit: "0.0000" },
    ]);
  });

  it("draftTransfer refuses a type whose policy is not a transfer dispatch (TRANSFER_RECEIPT)", async () => {
    // On c7d26b4 this drafted, and posted Dr 1300 / Cr 1310 beside -4 out of WH-HQ and +4 into transit.
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransfer(tx, ctxOf(s), {
          fromWarehouseId: whHq,
          toWarehouseId: whBranch,
          effectiveDate: "2026-02-12",
          series: "TRR",
          documentTypeId: trrType,
          lines: [{ itemId, unitId, quantity: "4.000000" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document type TRANSFER_RECEIPT is not a transfer dispatch: .*credit item\.inventory_account/,
    );
  });

  it("a counted arrival that differs from its dispatch is refused at post when no rule it meets posts line.variance_value (step 6e)", async () => {
    // A zero-code receipt with TRANSFER_RECEIPT's arrived pair and no variance pair: receipt-SHAPED, so the
    // service drafts it. Its only fill is line.cost, and a single-kind line takes |issue.value| (§4.7.2), so on
    // c7d26b4 a 10-out / 8-in arrival posted Dr 1300 / Cr 1310 at 50.0000 beside +8 (40.0000) into WH-BR2.
    const plainType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT_PLAIN",
      module: "inventory",
      policy: {
        ...TRANSFER_RECEIPT_POLICY,
        documentType: "TRANSFER_RECEIPT_PLAIN",
        lines: TRANSFER_RECEIPT_POLICY.lines.slice(0, 2),
        numbering: { series: "TRP", assignAt: "issue" },
      },
    });
    const t = await dispatch("10.000000", "2026-02-13");
    const { documentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: t.documentId,
        documentTypeId: plainType,
        series: "TRP",
        effectiveDate: "2026-02-14",
        received: [{ transferLineId: t.lineIds[0]!, countedQuantity: "8.000000" }],
      }),
    );
    const transitBefore = await transitQuantity();
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: 8\.000000 arrived of 10\.000000 dispatched, and no each_line rule of the TRANSFER_RECEIPT_PLAIN policy .* posts line\.variance_value/,
    );
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; number: string | null; ledger: number; moves: number }[]>`
        select d.status::text as status, d.number::text as number,
               (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
               (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
          from app.document d where d.id = ${documentId}`,
    );
    expect(row).toEqual({ status: "draft", number: null, ledger: 0, moves: 0 });
    expect(await transitQuantity()).toBe(transitBefore);

    // An EXACT arrival under the same type is not asked — both legs carry one value — and posts.
    const exact = await dispatch("5.000000", "2026-02-15");
    const r = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: exact.documentId,
        documentTypeId: plainType,
        series: "TRP",
        effectiveDate: "2026-02-16",
      });
      await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      return drafted;
    });
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "24.9999", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "24.9999" },
    ]);
  });

  it("the verification's TRANSFER-typed receipt, written without the service, is refused at post too (step 6e)", async () => {
    // The data-layer half: the same document the unchecked service drafted — TRANSFER's dispatch rules, the
    // corridor as warehouse and the branch as destination, one line counted 8 of 10 — written straight to the
    // tables as any app_rw writer could. It posted on c7d26b4 (Dr 1310 / Cr 1300 at 50.0000).
    await dispatch("10.000000", "2026-02-17");
    const documentId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [doc] = await tx<{ id: string }[]>`
        insert into app.document
          (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
           warehouse_id, to_warehouse_id, branch_id)
        values (${s.tenant}, ${s.company}, ${trfType}, 'TRF', '2026-02-18', 'MYR', '1.00000000',
                ${whTransit}, ${whBranch}, ${branchB})
        returning id`;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, unit_id, quantity,
           counted_quantity, expected_quantity, amount)
        values (${s.tenant}, ${s.company}, ${doc!.id}, 1, 'item', ${itemId}, ${whTransit}, ${unitId},
                -2, 8, 10, 0)`;
      return doc!.id;
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: 8\.000000 arrived of 10\.000000 dispatched, and no each_line rule of the TRANSFER policy .* posts line\.variance_value/,
    );
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; ledger: number; moves: number }[]>`
        select d.status::text as status,
               (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
               (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
          from app.document d where d.id = ${documentId}`,
    );
    expect(row).toEqual({ status: "draft", ledger: 0, moves: 0 });
  });

  // ── The verification of R3, second half: a transfer's legs at the warehouses its policy's leg names ────
  // item.inventory_account is the STOCK warehouse's account and 1310 the corridor's, so a dispatch-shaped
  // policy (it credits item.inventory_account) is right only for stock → in_transit, and a receipt-shaped one
  // only for in_transit → stock. The services draft only that, but the line's warehouse is PUT …/lines's to
  // write (bound to the company, its kind not asked), and draftTransfer never asked the SOURCE's kind.

  /** Tops WH-HQ up at 5.0000 (`amount` is `qty` x 5.0000, written out), so the cases below never depend on
   *  what the earlier ones left and the AVCO unit cost stays 5.0000. */
  async function topUp(qty: string, amount: string, effectiveDate: string) {
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate,
      partyId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whHq,
          unitId,
          quantity: qty,
          unitPrice: "5.0000",
          amount,
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }
  const draftState = (documentId: string) =>
    withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; ledger: number; moves: number }[]>`
        select d.status::text as status,
               (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
               (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
          from app.document d where d.id = ${documentId}`,
    );

  it("a TRANSFER_RECEIPT whose line was moved to a stock warehouse, as PUT …/lines may, is refused at post (step 6f)", async () => {
    // On d175409 this posted: WH-HQ -3 and WH-BR2 +3 (the stock warehouses' value unchanged) beside
    // Dr 1300 / Cr 1310 at 15.0000, while the corridor still held the dispatch's 3.
    await topUp("10.000000", "50.0000", "2026-02-19");
    const t = await dispatch("3.000000", "2026-02-19");
    const { documentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      draftTransferReceipt(tx, ctxOf(s), {
        transferDocumentId: t.documentId,
        documentTypeId: trrType,
        series: "TRR",
        effectiveDate: "2026-02-20",
      }),
    );
    // What PUT …/lines leaves: the line at a live company warehouse of any kind, and no count columns
    // (DocumentLineInput cannot carry them).
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        update app.document_line
           set warehouse_id = ${whHq}, quantity = 3, counted_quantity = null, expected_quantity = null
         where document_id = ${documentId}`,
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: the TRANSFER_RECEIPT policy posts a transfer receipt, whose issue leg must be at an in_transit warehouse; this line's is at stock warehouse WH-HQ/,
    );
    expect(await draftState(documentId)).toEqual([{ status: "draft", ledger: 0, moves: 0 }]);
  });

  it("a dispatch out of an in-transit warehouse is refused: by draftTransfer, and at post (step 6f)", async () => {
    // Goods in the corridor are 1310's, not item.inventory_account's, so TRANSFER's Cr 1300 is wrong for them.
    await topUp("2.000000", "10.0000", "2026-02-21");
    await dispatch("2.000000", "2026-02-21"); // 2 more in WH-BR2-TR, whatever the cases above left there
    // An HQ corridor, so that `resolveInTransitWarehouse(WH-HQ)` answers and the SOURCE is what is asked.
    const hqTransit = await seedWarehouse(db, s, {
      code: "WH-HQ-TR",
      kind: "in_transit",
      branchId: s.hq,
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransfer(tx, ctxOf(s), {
          fromWarehouseId: whTransit,
          toWarehouseId: whHq,
          effectiveDate: "2026-02-22",
          series: "TRF",
          documentTypeId: trfType,
          lines: [{ itemId, unitId, quantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: warehouse WH-BR2-TR is in_transit; a transfer's source must be a stock warehouse/,
    );
    // The same document by hand — the corridor to another corridor, which is what draftTransfer drafted on
    // d175409 for WH-BR2-TR → WH-HQ. It posted Dr 1310 / Cr 1300 with no stock warehouse's value moving.
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: trfType,
      series: "TRF",
      effectiveDate: "2026-02-22",
      warehouseId: whTransit,
      toWarehouseId: hqTransit,
      lines: [{ kind: "item", itemId, warehouseId: whTransit, unitId, quantity: "1.000000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: the TRANSFER policy posts a transfer dispatch, whose issue leg must be at a stock warehouse; this line's is at in_transit warehouse WH-BR2-TR/,
    );
    expect(await draftState(documentId)).toEqual([{ status: "draft", ledger: 0, moves: 0 }]);
  });

  it("the two swapped shapes the verification named, written without the services, are refused at post whatever their variance (step 6f)", async () => {
    // The services refuse both (the cases above), but an app_rw writer does not go through them, and step 6e
    // asks only a counted line whose legs DIFFER. So on 2e395c1 both of these posted: a TRANSFER-typed
    // "receipt" counted 2 of 2 put Dr 1310 / Cr 1300 beside a move out of transit into WH-BR2, and a
    // TRANSFER_RECEIPT-typed "dispatch" put Dr 1300 / Cr 1310 beside a move out of WH-HQ into transit.
    await topUp("3.000000", "15.0000", "2026-02-23");
    await dispatch("2.000000", "2026-02-23"); // 2 more in WH-BR2-TR, for the swapped receipt to take out
    const exactReceiptAsTransfer = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [doc] = await tx<{ id: string }[]>`
        insert into app.document
          (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
           warehouse_id, to_warehouse_id, branch_id)
        values (${s.tenant}, ${s.company}, ${trfType}, 'TRF', '2026-02-24', 'MYR', '1.00000000',
                ${whTransit}, ${whBranch}, ${branchB})
        returning id`;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, unit_id, quantity,
           counted_quantity, expected_quantity, amount)
        values (${s.tenant}, ${s.company}, ${doc!.id}, 1, 'item', ${itemId}, ${whTransit}, ${unitId},
                0, 2, 2, 0)`;
      return doc!.id;
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctxOf(s), { documentId: exactReceiptAsTransfer }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: the TRANSFER policy posts a transfer dispatch, whose issue leg must be at a stock warehouse; this line's is at in_transit warehouse WH-BR2-TR/,
    );
    expect(await draftState(exactReceiptAsTransfer)).toEqual([
      { status: "draft", ledger: 0, moves: 0 },
    ]);

    const { documentId: dispatchAsReceipt } = await draftTypedDocument(db, s, {
      documentTypeId: trrType,
      series: "TRR",
      effectiveDate: "2026-02-24",
      warehouseId: whHq,
      toWarehouseId: whTransit,
      lines: [{ kind: "item", itemId, warehouseId: whHq, unitId, quantity: "1.000000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctxOf(s), { documentId: dispatchAsReceipt }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: the TRANSFER_RECEIPT policy posts a transfer receipt, whose issue leg must be at an in_transit warehouse; this line's is at stock warehouse WH-HQ/,
    );
    expect(await draftState(dispatchAsReceipt)).toEqual([{ status: "draft", ledger: 0, moves: 0 }]);
  });

  // ── Code review 4, item 1: a counted line whose sign disagrees with its count columns ──────────────────
  // Step 6d admits a negative transfer line carrying both count columns because such a line's `quantity` is
  // the variance `counted − expected` — but nothing enforced that equality. `transferQuantities` takes the
  // two legs from the count columns, while TRANSFER_RECEIPT's variance rules select on `line.quantity_sign`,
  // so a line whose sign lies passed 6d, 6e (a variance rule of the wrong sign meets it) and 6f (its
  // warehouses are right) and posted the variance to the wrong side of 1310. On 04cf7ef both of these posted:
  // -2 counted 12 of 10 left 1310 20.0000 below the transit value, and +2 counted 8 of 10 moved 1310 by
  // -30.0000 while the transit value moved by -50.0000. Only `draftTransferReceipt` and `recordCounts` write
  // the count columns, and both set `quantity = counted − expected` in the same statement; an app_rw writer
  // need not, so step 6d now refuses the lie before step 7.

  it("a counted line whose quantity is not counted − expected, written without the service, is refused at post and stays a draft (step 6d)", async () => {
    await topUp("20.000000", "100.0000", "2026-02-25");
    for (const [label, quantity, counted, expected] of [
      ["over-arrival signed short", "-2", "12", "10"],
      ["short arrival signed over", "2", "8", "10"],
    ] as const) {
      await dispatch("10.000000", "2026-02-25");
      const transitBefore = await transitQuantity();
      const documentId = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const [doc] = await tx<{ id: string }[]>`
          insert into app.document
            (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
             warehouse_id, to_warehouse_id, branch_id)
          values (${s.tenant}, ${s.company}, ${trrType}, 'TRR', '2026-02-26', 'MYR', '1.00000000',
                  ${whTransit}, ${whBranch}, ${branchB})
          returning id`;
        await tx`
          insert into app.document_line
            (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, unit_id, quantity,
             counted_quantity, expected_quantity, amount)
          values (${s.tenant}, ${s.company}, ${doc!.id}, 1, 'item', ${itemId}, ${whTransit}, ${unitId},
                  ${quantity}, ${counted}, ${expected}, 0)`;
        return doc!.id;
      });
      await expect(
        withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
        label,
      ).rejects.toThrow(
        /ERR_VALIDATION_FAILED: document .* line 1: a counted line's quantity is its variance counted_quantity − expected_quantity/,
      );
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ status: string; number: string | null; ledger: number; moves: number }[]>`
          select d.status::text as status, d.number::text as number,
                 (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
                 (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
            from app.document d where d.id = ${documentId}`,
      );
      expect(row, label).toEqual({ status: "draft", number: null, ledger: 0, moves: 0 });
      expect(await transitQuantity(), label).toBe(transitBefore);
    }

    // The same two arrivals written truthfully — the variance's own sign — post, through the service.
    const short = await dispatch("10.000000", "2026-02-27");
    const r = await receive(short, "8.000000", "2026-02-28");
    expect(await ledgerOf(r.documentId)).toEqual([
      { code: "1300", debit: "40.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "40.0000" },
      { code: "1310", debit: "0.0000", credit: "10.0002" },
      { code: "5110", debit: "10.0002", credit: "0.0000" },
    ]);
  });

  // ── After 0068 and 0119: branch-restricted principals and the inter-branch transfer (contracts §4.5.6) ──
  // §4.5.6 and ADR 0062 justify Form A″'s in-transit exception by a receipt at branch B of what branch A
  // dispatched, and the 2026-10-07 reconciliation asks for the end-to-end proof. Until 0119 these cases PINNED
  // its absence: no principal restricted to one branch could dispatch or receive (ADR 0062's 2026-10-23
  // amendment). ADR 0043's amendment, accepted by the owner on 2026-11-04 with every recommended default and
  // implemented by migration 0119, closes it in three bounded steps, and these cases are now the proof:
  //   - the RECEIVING branch stamps and gates the receipt (`draftTransferReceipt` stamps the corridor's branch,
  //     and 2B's status trigger gates the post there);
  //   - Form A on `document` READS one more shape — a POSTED document into an in_transit warehouse of a branch
  //     the actor is in — so the receiving branch reads the dispatch's header and, through the unchanged
  //     `document_parent_visibility` USING, its lines; its WITH CHECKs keep every write at the writer's branch;
  //   - the sending branch resolves the hidden destination's corridor through the bounded, company-bound
  //     `app.transfer_destination_branch`, and Form A″ still hides B's stock warehouse from it.
  // The controls stay: a principal granted BOTH branches dispatches and receives, and the company-wide
  // `s.human` of every case above receives. A third branch sees none of it.
  describe("after 0068 and 0119 — a branch-restricted principal and the inter-branch transfer (ADR 0043's amendment; contracts §4.5.6)", () => {
    let receiverB: string;
    let dispatcherA: string;
    let bothBranches: string;
    let thirdC: string;
    let branchC: string;
    const ctxAs = (actorId: string): TenantContext => ({ ...ctxOf(s), actorId });

    /** A fresh human holding the two codes the seeded branch_manager holds for transfers (spec:2160), at
     *  exactly `branchIds` — 2B's `grantCodes` writes one `role_assignment_branch` row per branch. */
    async function restrictedTo(label: string, branchIds: readonly string[]): Promise<string> {
      const id = await secondPrincipal(db, s, label);
      await grantCodes(db, s, {
        codes: ["inventory.transfer.create", "inventory.transfer.post"],
        principalId: id,
        roleCode: label,
        branchIds,
      });
      return id;
    }

    const documentCount = async (): Promise<number> => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ n: number }[]>`
          select count(*)::int as n from app.document where company_id = ${s.company}`,
      );
      return row!.n;
    };

    const movementsOf = (documentId: string) =>
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ status: string; warehouse_id: string; quantity: string }[]>`
          select d.status::text as status, m.warehouse_id, m.quantity::text
            from app.document d join app.inventory_movement m on m.document_id = d.id
           where d.id = ${documentId} order by m.movement_no`,
      );

    /** What `actorId` can read of `documentIds`: headers, and lines through the parent guard. */
    const seenBy = async (actorId: string, documentIds: readonly string[]) => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        actorId,
        (tx) => tx<{ headers: number; lines: number }[]>`
          select (select count(*)::int from app.document where id = any(${documentIds}::uuid[])) as headers,
                 (select count(*)::int from app.document_line
                   where document_id = any(${documentIds}::uuid[])) as lines`,
      );
      return row!;
    };

    const dispatchInput = (quantity: string, effectiveDate: string) => ({
      fromWarehouseId: whHq,
      toWarehouseId: whBranch,
      effectiveDate,
      series: "TRF",
      documentTypeId: trfType,
      lines: [{ itemId, unitId, quantity }],
    });

    /** Draft, issue and post a dispatch A → B, all as `actorId`. */
    const dispatchAs = (actorId: string, quantity: string, effectiveDate: string) =>
      withTenant(db.rw, s.tenant, actorId, async (tx) => {
        const drafted = await draftTransfer(
          tx,
          ctxAs(actorId),
          dispatchInput(quantity, effectiveDate),
        );
        await issueDocument(tx, ctxAs(actorId), { documentId: drafted.documentId });
        await postDocument(tx, ctxAs(actorId), { documentId: drafted.documentId });
        return drafted;
      });

    /** Draft, issue and post the receipt of `transferDocumentId`, all as `actorId`. */
    const receiveAs = (
      actorId: string,
      transfer: { documentId: string; lineIds: string[] },
      counted: string | null,
      effectiveDate: string,
    ) =>
      withTenant(db.rw, s.tenant, actorId, async (tx) => {
        const drafted = await draftTransferReceipt(tx, ctxAs(actorId), {
          transferDocumentId: transfer.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate,
          ...(counted === null
            ? {}
            : { received: [{ transferLineId: transfer.lineIds[0]!, countedQuantity: counted }] }),
        });
        await issueDocument(tx, ctxAs(actorId), { documentId: drafted.documentId });
        await postDocument(tx, ctxAs(actorId), { documentId: drafted.documentId });
        return drafted;
      });

    const branchOf = async (documentId: string): Promise<string> => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx<{ branch_id: string }[]>`select branch_id from app.document where id = ${documentId}`,
      );
      return row!.branch_id;
    };

    beforeAll(async () => {
      receiverB = await restrictedTo("trr-receiver-b", [branchB]);
      dispatcherA = await restrictedTo("trr-dispatcher-a", [s.hq]);
      bothBranches = await restrictedTo("trr-both-branches", [s.hq, branchB]);
      branchC = await seedBranch(db, s, { code: "BR-C", nameEn: "Branch C" });
      thirdC = await restrictedTo("trr-third-c", [branchC]);
      await topUp("20.000000", "100.0000", "2026-03-02");
    });

    it("a principal restricted to the SENDING branch drafts, issues and posts the dispatch; B's stock warehouse stays hidden from it", async () => {
      const t = await dispatchAs(dispatcherA, "2.000000", "2026-03-03");
      // The corridor was found through the bounded lookup of the destination's branch: B's in-transit
      // warehouse, which Form A″ already showed to A.
      expect(t.inTransitWarehouseId).toBe(whTransit);
      expect(await branchOf(t.documentId)).toBe(s.hq);
      expect(await movementsOf(t.documentId)).toEqual([
        { status: "posted", warehouse_id: whHq, quantity: "-2.000000" },
        { status: "posted", warehouse_id: whTransit, quantity: "2.000000" },
      ]);
      // Form A″ exactly as before 0119: B's in-transit row is visible to A, B's stock row is not, and the
      // final destination is recorded on the dispatch all the same.
      const [seen] = await withTenant(
        db.rw,
        s.tenant,
        dispatcherA,
        (tx) => tx<{ warehouses: string[]; final: string | null }[]>`
          select (select array_agg(id order by code) from app.warehouse
                   where id in (${whHq}, ${whBranch}, ${whTransit})) as warehouses,
                 (select v.value #>> '{}' from app.custom_field_value v
                    join app.custom_field_definition d on d.id = v.definition_id
                   where v.entity_id = ${t.documentId} and d.code = 'final_warehouse_id') as final`,
      );
      expect(seen).toEqual({ warehouses: [whTransit, whHq], final: whBranch });

      // A principal restricted to B cannot dispatch FROM A: A's stock warehouse is hidden from it.
      await expect(
        withTenant(db.rw, s.tenant, receiverB, (tx) =>
          draftTransfer(tx, ctxAs(receiverB), dispatchInput("1.000000", "2026-03-03")),
        ),
      ).rejects.toThrow(`ERR_NOT_FOUND: warehouse ${whHq} is not visible`);

      // The company-wide `s.human` receives it, which leaves the corridor as this case found it.
      await receive(t, null, "2026-03-04");
    });

    it("a principal restricted to the RECEIVING branch reads the posted dispatch, receives it stamped and gated at B, and a second receipt is refused", async () => {
      const t = await dispatchAs(dispatcherA, "3.000000", "2026-03-05");

      // What B reads of the dispatch before receiving: its header and its line, the final destination — and
      // still no transfer authority at A, only at B.
      expect(await seenBy(receiverB, [t.documentId])).toEqual({ headers: 1, lines: 1 });
      const [authority] = await withTenant(
        db.rw,
        s.tenant,
        receiverB,
        (tx) => tx<{ post_at_a: boolean; post_at_b: boolean }[]>`
          select app.actor_has('inventory.transfer.post', ${s.company}::uuid, ${s.hq}::uuid) as post_at_a,
                 app.actor_has('inventory.transfer.post', ${s.company}::uuid, ${branchB}::uuid) as post_at_b`,
      );
      expect(authority).toEqual({ post_at_a: false, post_at_b: true });

      // 2 of the 3 arrive: a shortfall, received and posted entirely on B's authority.
      const r = await receiveAs(receiverB, t, "2.000000", "2026-03-06");
      expect(r.finalWarehouseId).toBe(whBranch);
      expect(await branchOf(r.documentId)).toBe(branchB);
      expect(await movementsOf(r.documentId)).toEqual([
        { status: "posted", warehouse_id: whTransit, quantity: "-3.000000" },
        { status: "posted", warehouse_id: whBranch, quantity: "2.000000" },
      ]);

      // The `receives_against` link accounts for the whole dispatch line — the 2 that arrived and the 1 lost,
      // which is the line's variance (full review INV-01) — so nothing is left open, and that is readable at B.
      const [link] = await withTenant(
        db.rw,
        s.tenant,
        receiverB,
        (tx) => tx<{ link_kind: string; quantity: string; open: string }[]>`
          select l.link_kind, l.quantity::text,
                 (select o.open_quantity::text from app.document_open_quantity o
                   where o.document_line_id = ${t.lineIds[0]!}) as open
            from app.document_link l where l.target_document_id = ${r.documentId}`,
      );
      expect(link).toEqual({
        link_kind: "receives_against",
        quantity: "3.000000",
        open: "0.000000",
      });

      // A second receipt of the same dispatch is refused for B: nothing is open.
      const before = await documentCount();
      await expect(receiveAs(receiverB, t, null, "2026-03-06")).rejects.toThrow(
        /ERR_DOC_LINK_OVER_FULFILLED/,
      );
      expect(await documentCount()).toBe(before);

      // The sending branch does not read the receipt: it is B's document into B's stock warehouse.
      expect(await seenBy(dispatcherA, [r.documentId])).toEqual({ headers: 0, lines: 0 });
    });

    it("only a POSTED dispatch is read at the receiving branch, and a third branch reads neither the dispatch, its lines nor the receipt", async () => {
      // Drafted and issued, the dispatch is still only A's.
      const drafted = await withTenant(db.rw, s.tenant, dispatcherA, async (tx) => {
        const own = await draftTransfer(
          tx,
          ctxAs(dispatcherA),
          dispatchInput("1.000000", "2026-03-07"),
        );
        await issueDocument(tx, ctxAs(dispatcherA), { documentId: own.documentId });
        return own;
      });
      expect(await seenBy(receiverB, [drafted.documentId])).toEqual({ headers: 0, lines: 0 });
      await expect(
        withTenant(db.rw, s.tenant, receiverB, (tx) =>
          draftTransferReceipt(tx, ctxAs(receiverB), {
            transferDocumentId: drafted.documentId,
            documentTypeId: trrType,
            series: "TRR",
            effectiveDate: "2026-03-08",
          }),
        ),
      ).rejects.toThrow(`ERR_NOT_FOUND: document ${drafted.documentId} is not visible`);
      await withTenant(db.rw, s.tenant, dispatcherA, (tx) =>
        postDocument(tx, ctxAs(dispatcherA), { documentId: drafted.documentId }),
      );
      expect(await seenBy(receiverB, [drafted.documentId])).toEqual({ headers: 1, lines: 1 });

      const r = await receiveAs(receiverB, drafted, null, "2026-03-08");
      // A third branch is neither the dispatch's nor the corridor's: it sees nothing of either document.
      expect(await seenBy(thirdC, [drafted.documentId, r.documentId])).toEqual({
        headers: 0,
        lines: 0,
      });
      const before = await documentCount();
      await expect(
        withTenant(db.rw, s.tenant, thirdC, (tx) =>
          draftTransferReceipt(tx, ctxAs(thirdC), {
            transferDocumentId: drafted.documentId,
            documentTypeId: trrType,
            series: "TRR",
            effectiveDate: "2026-03-08",
          }),
        ),
      ).rejects.toThrow(`ERR_NOT_FOUND: document ${drafted.documentId} is not visible`);
      expect(await documentCount()).toBe(before);
    });

    it("the widened read is a read: the receiving branch cannot change, extend or delete the sender's dispatch or its lines", async () => {
      const t = await dispatchAs(dispatcherA, "1.000000", "2026-03-09");
      const snapshot = async () => {
        const [row] = await withTenant(
          db.rw,
          s.tenant,
          s.human,
          (tx) => tx<{ status: string; branch_id: string; lines: string }[]>`
            select d.status::text as status, d.branch_id,
                   (select string_agg(l.line_no || ':' || l.quantity || ':' || coalesce(l.cost::text, '-'),
                                      ',' order by l.line_no)
                      from app.document_line l where l.document_id = d.id) as lines
              from app.document d where d.id = ${t.documentId}`,
        );
        return row!;
      };
      const before = await snapshot();
      const asB = (statement: (tx: Sql) => Promise<unknown>) =>
        withTenant(db.rw, s.tenant, receiverB, statement);

      // The header: a no-op re-save passes the status matrix and every freeze, so Form A's WITH CHECK is
      // what refuses it; a move into B's own name is refused by 0117 first.
      await expect(
        asB((tx) => tx`update app.document set status = status where id = ${t.documentId}`),
      ).rejects.toThrow(
        /new row violates row-level security policy "branch_isolation" for table "document"/,
      );
      await expect(
        asB((tx) => tx`update app.document set branch_id = ${branchB} where id = ${t.documentId}`),
      ).rejects.toThrow(/ERR_DOC_NOT_DRAFT: .*its header cannot be changed \(branch_id\)/);
      await expect(
        asB((tx) => tx`delete from app.document where id = ${t.documentId}`),
      ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);

      // The lines: 0113 admits a `cost` change at posted (the cost replay's), so the parent guard's WITH
      // CHECK — the parent must be one B may WRITE, not merely read — is the only thing that refuses it.
      await expect(
        asB(
          (tx) => tx`update app.document_line set cost = coalesce(cost, 0) + 1
                      where document_id = ${t.documentId}`,
        ),
      ).rejects.toThrow(
        /new row violates row-level security policy "document_parent_visibility" for table "document_line"/,
      );
      await expect(
        asB(
          (
            tx,
          ) => tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind)
                     values (${s.tenant}, ${s.company}, ${t.documentId}, 2, 'text')`,
        ),
      ).rejects.toThrow(/ERR_DOC_NOT_DRAFT|row-level security/);
      await expect(
        asB((tx) => tx`delete from app.document_line where document_id = ${t.documentId}`),
      ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
      // Nor can B reverse it: the mirror `reverseDocument` drafts is A's row, which Form A's WITH CHECK refuses.
      await expect(
        asB((tx) =>
          reverseDocument(tx, ctxAs(receiverB), {
            documentId: t.documentId,
            effectiveDate: "2026-03-09",
            reason: "probe: the receiving branch reverses the sender's dispatch",
          }),
        ),
      ).rejects.toThrow(
        /new row violates row-level security policy "branch_isolation" for table "document"/,
      );

      expect(await snapshot()).toEqual(before);
      expect(before).toMatchObject({ status: "posted", branch_id: s.hq });
      // The dispatch is still B's to receive.
      await receiveAs(receiverB, t, null, "2026-03-10");
    });

    it("app.transfer_destination_branch answers one fact, to a member of the company, in its own tenant", async () => {
      const lookup = (tenant: string, actorId: string, companyId: string, warehouseId: string) =>
        withTenant(
          db.rw,
          tenant,
          actorId,
          (tx) => tx<{ branch_id: string | null }[]>`
            select app.transfer_destination_branch(${companyId}::uuid, ${warehouseId}::uuid) as branch_id`,
        ).then((rows) => rows[0]!.branch_id);

      // The one fact: the branch of a live STOCK warehouse of the company.
      expect(await lookup(s.tenant, dispatcherA, s.company, whBranch)).toBe(branchB);
      expect(await lookup(s.tenant, dispatcherA, s.company, whHq)).toBe(s.hq);
      // Nothing for a corridor (Form A″ shows those already), an archived warehouse, an unknown id, or a
      // company the warehouse is not in.
      const archived = await seedWarehouse(db, s, {
        code: "WH-BR2-OLD",
        kind: "stock",
        branchId: branchB,
      });
      await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.warehouse set archived_at = now() where id = ${archived}`,
      );
      expect(await lookup(s.tenant, dispatcherA, s.company, whTransit)).toBeNull();
      expect(await lookup(s.tenant, dispatcherA, s.company, archived)).toBeNull();
      expect(
        await lookup(s.tenant, dispatcherA, s.company, "00000000-0000-7000-8000-000000000000"),
      ).toBeNull();
      const other = await seedTenantV2(db, "tenant-3d-trr-other");
      expect(await lookup(s.tenant, dispatcherA, other.company, whBranch)).toBeNull();
      // Only to a principal holding a live role in that company.
      const outsider = await secondPrincipal(db, s, "trr-no-role");
      expect(await lookup(s.tenant, outsider, s.company, whBranch)).toBeNull();
      // Tenant-bound: another tenant's principal, in its own tenant, learns nothing of this one.
      expect(await lookup(other.tenant, other.human, s.company, whBranch)).toBeNull();

      // Bounded as 0068's resolve_cashier_employee is: SECURITY DEFINER owned by app_auth (no BYPASSRLS), a
      // fixed search_path, no PUBLIC execute, and exactly six warehouse columns readable by app_auth — which
      // is why Form A″ is scoped to the two data roles, with its USING unchanged.
      const [fn] = await db.admin<
        {
          secdef: boolean;
          owner: string;
          bypass: boolean;
          config: string[];
          pub: boolean;
          rw: boolean;
        }[]
      >`select p.prosecdef as secdef, r.rolname as owner, r.rolbypassrls as bypass, p.proconfig as config,
               exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub,
               has_function_privilege('app_rw', p.oid, 'EXECUTE') as rw
          from pg_proc p join pg_roles r on r.oid = p.proowner
         where p.pronamespace = 'app'::regnamespace and p.proname = 'transfer_destination_branch'`;
      expect(fn).toEqual({
        secdef: true,
        owner: "app_auth",
        bypass: false,
        config: ["search_path=app, pg_temp"],
        pub: false,
        rw: true,
      });
      const columns = await db.admin<{ column_name: string; privilege_type: string }[]>`
        select column_name, privilege_type from information_schema.column_privileges
         where grantee = 'app_auth' and table_schema = 'app' and table_name = 'warehouse' order by 1`;
      expect(columns).toEqual(
        ["archived_at", "branch_id", "company_id", "id", "kind", "tenant_id"].map(
          (column_name) => ({
            column_name,
            privilege_type: "SELECT",
          }),
        ),
      );
      const [formA2] = await db.admin<{ roles: string[]; permissive: string; qual: string }[]>`
        select roles, permissive, qual from pg_policies
         where schemaname = 'app' and tablename = 'warehouse' and policyname = 'branch_isolation'`;
      expect(formA2).toEqual({
        roles: ["app_migrator", "app_rw"],
        permissive: "RESTRICTIVE",
        qual: "((kind = 'in_transit'::text) OR app.actor_in_branch(company_id, branch_id))",
      });
    });

    it("two tenants: the widened read and the lookup stop at the tenant", async () => {
      const t = await dispatchAs(dispatcherA, "1.000000", "2026-03-11");
      const other = await seedTenantV2(db, "tenant-3d-trr-other-2");
      // Another tenant's principals — its company-wide human and its system principal, which passes every
      // branch form in its own tenant — read nothing of this one, the widened clause included.
      for (const actor of [other.human, other.system]) {
        const [row] = await withTenant(
          db.rw,
          other.tenant,
          actor,
          (tx) => tx<{ headers: number; lines: number }[]>`
            select (select count(*)::int from app.document where id = ${t.documentId}) as headers,
                   (select count(*)::int from app.document_line where document_id = ${t.documentId}) as lines`,
        );
        expect(row, actor).toEqual({ headers: 0, lines: 0 });
      }
      await receive(t, null, "2026-03-12");
    });

    it("the controls: a principal granted BOTH branches dispatches and receives, and the receipt is stamped with the receiving branch", async () => {
      const t = await dispatchAs(bothBranches, "1.000000", "2026-03-13");
      expect(await branchOf(t.documentId)).toBe(s.hq);
      const r = await receiveAs(bothBranches, t, null, "2026-03-14");
      expect(await branchOf(r.documentId)).toBe(branchB);
      expect(await movementsOf(r.documentId)).toEqual([
        { status: "posted", warehouse_id: whTransit, quantity: "-1.000000" },
        { status: "posted", warehouse_id: whBranch, quantity: "1.000000" },
      ]);
    });
  });

  // ── Full review 2026-11-15, INV-01 and INV-05: a dispatch line's open quantity is received at most once ──
  // Each receipt line expected the WHOLE dispatched quantity and linked only what arrived, and a total loss
  // linked nothing at all (quantity NULL, which 0116's guard does not bound). So a total loss followed by a
  // full receipt of the same dispatch both posted, as did 6 then 4 of one 10-unit dispatch: 20 units left the
  // corridor, the second batch out of ANOTHER dispatch's goods. A receipt line now expects, takes out of
  // transit and links exactly what is still open on its dispatch line — what arrived and what was lost alike
  // — and a receipt of a dispatch with nothing open is refused. INV-05: `recordCounts` rewrote a draft
  // receipt's counted quantity behind its link, and is now refused on anything but a count sheet.
  describe("full review INV-01/INV-05 — a dispatch is received once", () => {
    const linksOf = (documentId: string) =>
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ quantity: string | null; open: string }[]>`
          select l.quantity::text as quantity,
                 (select o.open_quantity::text from app.document_open_quantity o
                   where o.document_line_id = l.source_line_id) as open
            from app.document_link l where l.target_document_id = ${documentId}`,
      );
    const documentCount = async (): Promise<number> => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.document`,
      );
      return row!.n;
    };

    it("a total loss consumes the dispatch: a later full receipt of it is refused and the other dispatch stays in transit", async () => {
      await topUp("20.000000", "100.0000", "2026-04-01");
      const before = await transitQuantity();
      const other = await dispatch("10.000000", "2026-04-02");
      const t = await dispatch("10.000000", "2026-04-02");
      const lost = await receive(t, "0.000000", "2026-04-03");
      expect(await ledgerOf(lost.documentId)).toEqual([
        { code: "1310", debit: "0.0000", credit: "50.0000" },
        { code: "5110", debit: "50.0000", credit: "0.0000" },
      ]);
      const documents = await documentCount();
      await expect(receive(t, "10.000000", "2026-04-04")).rejects.toThrow(
        /ERR_DOC_LINK_OVER_FULFILLED/,
      );
      expect(await documentCount()).toBe(documents);
      // The loss took the whole open quantity, and the link says so: nothing is left to receive.
      expect(await linksOf(lost.documentId)).toEqual([{ quantity: "10.000000", open: "0.000000" }]);
      // Only the OTHER dispatch's 10 are in the corridor, and they still receive.
      expect(Number(await transitQuantity()) - Number(before)).toBe(10);
      await receive(other, null, "2026-04-04");
      expect(await transitQuantity()).toBe(before);
    });

    it("a short receipt consumes the dispatch: receiving 6 then 4 of 10 refuses the second and leaves the other dispatch whole", async () => {
      await topUp("20.000000", "100.0000", "2026-04-05");
      const before = await transitQuantity();
      const other = await dispatch("10.000000", "2026-04-06");
      const t = await dispatch("10.000000", "2026-04-06");
      const short = await receive(t, "6.000000", "2026-04-07");
      await expect(receive(t, "4.000000", "2026-04-08")).rejects.toThrow(
        /ERR_DOC_LINK_OVER_FULFILLED/,
      );
      // Ten out of transit (six in, four lost), and the link records all ten as accounted for.
      expect(await linksOf(short.documentId)).toEqual([
        { quantity: "10.000000", open: "0.000000" },
      ]);
      expect(Number(await transitQuantity()) - Number(before)).toBe(10);
      await receive(other, null, "2026-04-08");
      expect(await transitQuantity()).toBe(before);
    });

    it("a voided receipt releases what it took: the dispatch is open again and receives once more", async () => {
      await topUp("5.000000", "25.0000", "2026-04-09");
      const t = await dispatch("5.000000", "2026-04-10");
      await withTenant(db.rw, s.tenant, s.human, async (tx) => {
        const drafted = await draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: t.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate: "2026-04-11",
        });
        await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
        await voidDocument(tx, ctxOf(s), { documentId: drafted.documentId, reason: "re-count" });
      });
      const r = await receive(t, "5.000000", "2026-04-12");
      expect(await linksOf(r.documentId)).toEqual([{ quantity: "5.000000", open: "0.000000" }]);
    });

    // ORCH-03 (from PR #39's review): the receipt read its dispatch without a row lock, so a receipt drafted
    // while the dispatch's reversal was in flight did not wait for it. `draftTransferReceipt` now reads the
    // dispatch `for share`, as `convertToInvoice` reads its source, against `reverseDocument`'s `for update`.

    it("ORCH-03: a receipt drafted while the dispatch's reversal is uncommitted waits for it, then is refused as reversed", async () => {
      await topUp("2.000000", "10.0000", "2026-04-16");
      const t = await dispatch("2.000000", "2026-04-17");
      let reversed!: () => void;
      let commit!: () => void;
      const isReversed = new Promise<void>((resolve) => (reversed = resolve));
      const committed = new Promise<void>((resolve) => (commit = resolve));
      const reversal = withTenant(db.rw, s.tenant, s.human, async (tx) => {
        await reverseDocument(tx, ctxOf(s), {
          documentId: t.documentId,
          effectiveDate: "2026-04-18",
          reason: "ORCH-03",
        });
        reversed();
        await committed;
      });
      await isReversed;
      const receipt = settled(
        withTenant(db.rw, s.tenant, s.human, (tx) =>
          draftTransferReceipt(tx, ctxOf(s), {
            transferDocumentId: t.documentId,
            documentTypeId: trrType,
            series: "TRR",
            effectiveDate: "2026-04-18",
          }),
        ),
      );
      let waited: boolean;
      try {
        await pause(300);
        waited = !receipt.state.done; // waiting on the reversal's row lock
      } finally {
        commit();
        await reversal;
      }
      const result = await receipt.outcome;
      expect(waited).toBe(true);
      expect(result.ok).toBe(false);
      // Refused by the LOCKED read of the dispatch, which now sees it reversed — not later, by the link guard.
      expect(String((result as { error: unknown }).error)).toMatch(
        /ERR_VALIDATION_FAILED: transfer .* is reversed; only a posted transfer can be received/,
      );
    });

    it("ORCH-03: a reversal of the dispatch cannot complete while a receipt draft that has read it is uncommitted", async () => {
      await topUp("2.000000", "10.0000", "2026-04-19");
      const t = await dispatch("2.000000", "2026-04-20");
      // The draft pauses at its first `document_link:` advisory lock: after it has read the dispatch, and
      // before its first audited write (which would serialise the two on the tenant's audit key anyway).
      let atLock!: () => void;
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => (atLock = resolve));
      const go = new Promise<void>((resolve) => (resume = resolve));
      let once = false;
      const pausing = (tx: Sql): Sql =>
        new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const [strings] = args;
            if (
              !once &&
              Array.isArray(strings) &&
              "raw" in strings &&
              (strings as readonly string[]).join("?").includes("pg_advisory_xact_lock")
            ) {
              once = true;
              atLock();
              return go.then(() => Reflect.apply(target, thisArg, args) as unknown);
            }
            return Reflect.apply(target, thisArg, args) as unknown;
          },
        });
      const receipt = settled(
        withTenant(db.rw, s.tenant, s.human, (tx) =>
          draftTransferReceipt(pausing(tx), ctxOf(s), {
            transferDocumentId: t.documentId,
            documentTypeId: trrType,
            series: "TRR",
            effectiveDate: "2026-04-21",
          }),
        ),
      );
      await paused;
      const reversal = settled(
        withTenant(db.rw, s.tenant, s.human, (tx) =>
          reverseDocument(tx, ctxOf(s), {
            documentId: t.documentId,
            effectiveDate: "2026-04-21",
            reason: "ORCH-03",
          }),
        ),
      );
      let waited: boolean;
      try {
        await pause(500);
        waited = !reversal.state.done;
      } finally {
        resume();
      }
      expect((await receipt.outcome).ok).toBe(true);
      await reversal.outcome;
      // The reversal waited on the draft's `for share` row lock. Whether it may then proceed against a live
      // receipt is reverseDocument's guard (PR #39), not this file's: the lock is what lets that guard see it.
      expect(waited).toBe(true);
    });

    it("INV-05: recordCounts refuses a draft TRANSFER_RECEIPT and leaves its line as drafted", async () => {
      await topUp("10.000000", "50.0000", "2026-04-22");
      const t = await dispatch("10.000000", "2026-04-23");
      const drafted = await withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransferReceipt(tx, ctxOf(s), {
          transferDocumentId: t.documentId,
          documentTypeId: trrType,
          series: "TRR",
          effectiveDate: "2026-04-24",
          received: [{ transferLineId: t.lineIds[0]!, countedQuantity: "0.000000" }],
        }),
      );
      await expect(
        withTenant(db.rw, s.tenant, s.human, (tx) =>
          recordCounts(tx, ctxOf(s), {
            documentId: drafted.documentId,
            counts: [{ documentLineId: drafted.lineIds[0]!, countedQuantity: "10.000000" }],
          }),
        ),
      ).rejects.toThrow(/ERR_VALIDATION_FAILED: .* is not a stock-count sheet/);
      const [line] = await withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ counted: string; expected: string; quantity: string }[]>`
          select counted_quantity::text as counted, expected_quantity::text as expected,
                 quantity::text as quantity
            from app.document_line where id = ${drafted.lineIds[0]!}`,
      );
      expect(line).toEqual({ counted: "0.000000", expected: "10.000000", quantity: "-10.000000" });
    });
  });
});

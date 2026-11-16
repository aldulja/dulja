import { beforeAll, describe, expect, it } from "vitest";
import { repoFile, sharedDb } from "../support/regression";
import { CreateDocumentBody, DocumentLineInput } from "@dulja/contracts/accounting/document";
import {
  convertOrderToDelivery,
  creditNoteFrom,
  draftTransfer,
  draftTransferReceipt,
  issueDocument,
  postDocument,
  reverseDocument,
  voidDocument,
  withTenant,
} from "@dulja/db";
import { ensureOpenPeriods } from "../invariants/support/post-inventory";
import { postArDocument } from "../invariants/support/post-ar";
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
} from "@dulja/db/test";

/** The two envelopes are read from the seed pack rather than re-typed: `packages/db/test/inventory/
 *  policies.ts` is not part of `@dulja/db/test`'s exports, and a third copy of either policy is the
 *  duplication hazard 9 forbids. `repoFile` is 0B's (§4.17.1) — Vitest runs this workspace from `tests/`,
 *  so a bare relative path never resolves. Both files exist by this task: SALES_ORDER at Task 5 and
 *  DELIVERY_ORDER at Task 6. */
const packPolicy = (code: string): unknown =>
  (
    JSON.parse(repoFile(`packages/db/seed/my/document-types/${code}.json`)) as {
      policy: unknown;
    }
  ).policy;

/**
 * SAH-018 — the legacy system stored a returned/delivered quantity as a column on the order row and it
 * drifted from the movements within weeks. The fix is structural: a fulfilled, delivered or returned
 * quantity is a PROJECTION over `document_link` and `inventory_movement`, and no table holds one.
 *
 * 3D is the first slice in execution order to touch SAH-018 (§6.3), so it creates this file; 4A appends its
 * own block for returned quantity once credit notes exist. A plain `describe` and not `thinRegression`:
 * that wrapper runs its body inside a single `it` (0b:5317-5326), which is a nested-test error, and its
 * `ThinContext` carries no `Seed` and none of this slice's services. The file gets its own tenant on the
 * shared container, for 3B's reason (3b:5973): the shared `a`/`b` seeds come from Plan 0A's `seedTenant`,
 * which wires neither `fx_rounding_account_id` nor the `1000`/`4000` accounts.
 */
describe("SAH-018 Delivered and returned quantity as a projection, never a stored column — 3D", () => {
  let s: Seed;
  let soType: string;
  let doType: string;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let partyId: string;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    const { db } = await sharedDb();
    s = await seedTenantV2(db, "sah-018");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah-018" };
    await grantCodes(db, s);
    await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    soType = await seedDocumentType(db, s, {
      code: "SALES_ORDER",
      module: "inventory",
      policy: packPolicy("SALES_ORDER"),
    });
    doType = await seedDocumentType(db, s, {
      code: "DELIVERY_ORDER",
      module: "inventory",
      policy: packPolicy("DELIVERY_ORDER"),
    });
    partyId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    warehouseId = await seedWarehouse(db, s, { code: "WH-018" });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-018", trackLots: false, baseUnitId: unitId }));
  }, 180_000);
  // No `afterAll`: the container belongs to `sharedDb()` and is stopped by the run, not by this file.

  it("no table carries a delivered / fulfilled / returned / remaining quantity column", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'app'
         and (column_name ~ '(delivered|fulfilled|returned|remaining|shipped)_(quantity|qty)'
              or column_name in ('quantity_delivered', 'quantity_returned', 'quantity_remaining'))
         -- cost_layer.qty_remaining is the ONE legitimate exception: a layer's remaining quantity is the
         -- layer's own state, written by the costing engine, not a duplicate of anything (§4.7.3).
         and not (table_name = 'cost_layer' and column_name = 'qty_remaining')
       order by table_name, column_name`;
    expect(rows).toEqual([]);
  });

  it("open quantity comes from a view over document_link, and the view has no storage", async () => {
    const { db } = await sharedDb();
    const [rel] = await db.admin<{ relkind: string }[]>`
      select relkind::text from pg_class
       where relname = 'document_open_quantity' and relnamespace = 'app'::regnamespace`;
    expect(rel!.relkind).toBe("v"); // 'v' = view; 'r' or 'm' would be a stored copy
  });

  it("a partial conversion moves the open quantity without touching the order line", async () => {
    const { db } = await sharedDb();
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-10",
      partyId,
      warehouseId,
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
    await withTenant(db.rw, ctx, (tx) => issueDocument(tx, ctx, { documentId: order.documentId }));

    // `quantity` alone, and the line's AUDIT rows — NOT `updated_at`. `app.document_line` has `created_at`
    // and no `updated_at` (§4.3.4's base DDL, contracts:2200-2217, and §4.6.1's universal-column rule),
    // so selecting one is a 42703 and the case would fail for the wrong reason. `attach_audit` is on this
    // table (contracts:2221), so an UPDATE of any kind writes an `app.audit_log` row — which is a stronger
    // statement than a timestamp: it says nothing was written at all, not merely that a clock did not move.
    const lineId = order.lineIds[0]!;
    const ordered = (): Promise<{ quantity: string }[]> =>
      withTenant(
        db.rw,
        ctx,
        (tx) => tx<{ quantity: string }[]>`
          select quantity::text from app.document_line where id = ${lineId}`,
      );
    // `action` is lower case: plan0A:2269 declares `check (action in ('insert', 'update', 'delete'))`, and
    // `row_id` is `text` (plan0A:2268 — join tables have composite keys), so the uuid is compared as text.
    const audits = (): Promise<{ n: number }[]> =>
      db.admin<{ n: number }[]>`
        select count(*)::int as n from app.audit_log
         where table_name = 'document_line' and row_id = ${lineId}::text and action = 'update'`;

    const [beforeQty] = await ordered();
    const [beforeAudit] = await audits();

    await withTenant(db.rw, ctx, (tx) =>
      convertOrderToDelivery(tx, ctx, {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: lineId, quantity: "4.000000" }],
      }),
    );

    const [afterQty] = await ordered();
    const [afterAudit] = await audits();
    expect(afterQty!.quantity).toBe(beforeQty!.quantity); // still 10.000000
    expect(afterAudit!.n).toBe(beforeAudit!.n); // and not one UPDATE was written
    const [open] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ open_quantity: string }[]>`
        select open_quantity::text from app.document_open_quantity where document_line_id = ${lineId}`,
    );
    expect(open!.open_quantity).toBe("6.000000"); // the remaining 6 is arithmetic, not a column
  });
});

/**
 * SAH-018's invoiced-return half, which the card assigns 4A: the legacy defect kept `BdtQnt` as a maintained
 * counter on the invoice — deleting a return line left it high, so no further return was possible, and
 * editing one to a smaller figure made it larger. Here the credited quantity is Σ `document_link.quantity` over
 * live `returns` links (3C) and there is no counter to drift. Its own tenant on the shared container, for the
 * 3D block's reason above; the two invoice types are the PACK's policies, seeded under their pack codes so
 * `creditNoteFrom`'s reversal-target check reads the real `producesType`.
 */
describe("SAH-018 An invoiced return is bounded by what was invoiced, and is a projection — 4A", () => {
  let s: Seed;
  let invType: string;
  let cnType: string;
  let partyId: string;
  let itemId: string;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    const { db } = await sharedDb();
    s = await seedTenantV2(db, "sah-018-4a");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah-018-4a" };
    for (const [code, nameEn, type] of [
      ["1200", "Trade receivables", "asset"],
      ["1250", "Goods delivered not invoiced", "asset"],
      ["5000", "Cost of goods sold", "expense"],
    ] as const) {
      await seedAccount(db, s, { code, nameEn, type });
    }
    invType = await seedDocumentType(db, s, {
      code: "SALES_INVOICE",
      module: "accounting",
      policy: packPolicy("SALES_INVOICE"),
    });
    cnType = await seedDocumentType(db, s, {
      code: "SALES_CREDIT_NOTE",
      module: "accounting",
      policy: packPolicy("SALES_CREDIT_NOTE"),
    });
    partyId = await seedParty(db, s, { code: "CUST-018", kind: "customer" });
    ({ itemId } = await seedItem(db, s, { code: "SKU-018-4A", trackLots: false }));
  }, 180_000);

  it("no invoice line carries a returned / credited quantity counter", async () => {
    const { db } = await sharedDb();
    const [col] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('returned_quantity', 'credited_quantity', 'bdt_qnt')`;
    expect(col!.n).toBe(0);
  });

  it("returning more than the invoice carried is refused, the refusal is the LINK's, and a void releases it", async () => {
    const { db } = await sharedDb();
    const inv = await postArDocument(db, s, {
      documentTypeId: invType,
      series: "INV",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          quantity: "5.000000",
          unitPrice: "9.0000",
          amount: "45.0000",
          cost: "15.0000",
        },
      ],
    });
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${inv.documentId}`;
    const invLine = line!.id;
    const audits = async (): Promise<number> => {
      const [row] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.audit_log
         where table_name = 'document_line' and row_id = ${invLine}::text and action = 'update'`;
      return row!.n;
    };
    const auditsBefore = await audits();
    /** Drafts and issues a credit of `quantity` in one transaction, so its reason lands on the event. */
    const credit = (quantity: string) =>
      withTenant(db.rw, ctx, async (tx) => {
        const r = await creditNoteFrom(tx, ctx, {
          companyId: s.company,
          settledDocumentId: inv.documentId,
          targetDocumentTypeId: cnType,
          targetSeries: "CN",
          effectiveDate: "2026-01-16",
          reason: `${quantity} back`,
          lines: [{ settledLineId: invLine, quantity }],
        });
        await issueDocument(tx, ctx, { documentId: r.documentId });
        return r;
      });

    const three = await credit("3.000000");
    await credit("2.000000");
    await expect(credit("1.000000")).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
    // The legacy counter would still read 5 after this: the void RELEASES the three, because the bound is a
    // sum over live links and a void credit note is not live (3C's view and trigger, one definition).
    await withTenant(db.rw, ctx, (tx) =>
      voidDocument(tx, ctx, { documentId: three.documentId, reason: "raised in error" }),
    );
    await credit("3.000000");
    await expect(credit("1.000000")).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
    // …and not one UPDATE reached the invoice line: nothing on it is maintained.
    expect(await audits()).toBe(auditsBefore);
  });

  it("a credit note is created only by creditNoteFrom or reverseDocument — a hand-built one cannot be POSTed", () => {
    // 2A's `DocumentLineInput` keeps 1A's non-negative `Amount` on every money field, so a NEGATED line — the
    // shape both credit-note paths write — cannot enter through 1A's generic document route. It does NOT
    // keep a hand-drafted negated DELIVERY_ORDER out on its own: `QuantitySchema` is signed, so a line at
    // quantity -2 with a positive amount passes the schema (code review 2, M1-X). What keeps §4.7.2's
    // receipt-value branch 3 unreachable for it is `postDocument` step 6d, which refuses a negative-quantity
    // line on a stock-moving policy outside a reversal; only reverseDocument's copied cost (branch 1) is
    // admitted (`packages/db/test/ar-ap/stock-return.test.ts`, both halves).
    const line = { lineNo: 1, kind: "item", quantity: "2.000000", unitPrice: "9.0000" };
    expect(DocumentLineInput.safeParse({ ...line, amount: "18.0000" }).success).toBe(true); // the control
    const negated = DocumentLineInput.safeParse({ ...line, amount: "-18.0000" });
    expect(negated.success).toBe(false);
    expect(negated.error?.issues.map((i) => i.path.join("."))).toEqual(["amount"]);
    // …and a POSITIVE hand-built credit note — which would post exactly as an invoice — cannot name the
    // invoice it credits: the generic body is `.strict()` and has no `reversesDocumentId`, so the credit-note
    // policies' `requires: ["reverses_document"]` refuses it at post (§4.3.2 step 4).
    const body = {
      documentTypeCode: "SALES_CREDIT_NOTE",
      effectiveDate: "2026-01-16",
      currency: "MYR",
      branchId: "00000000-0000-7000-8000-000000000001",
      lines: [{ ...line, amount: "18.0000" }],
    };
    expect(CreateDocumentBody.safeParse(body).success).toBe(true); // the control
    expect(
      CreateDocumentBody.safeParse({
        ...body,
        reversesDocumentId: "00000000-0000-7000-8000-000000000002",
      }).success,
    ).toBe(false);
    expect(packPolicy("SALES_CREDIT_NOTE")).toMatchObject({
      requires: ["party", "reverses_document"],
    });
  });
});

/**
 * SAH-018, review MON-03 (2026-11-15): what a dispatch has been RECEIVED against is the same projection over
 * `document_link` (`receives_against`), and a full reversal must read it as it reads `returns`. Reversing a
 * received dispatch mirrored units that had already left the shared in-transit warehouse, so it took another
 * dispatch's goods back to the sender. `reverseDocument` now refuses while any receipt drafted against the
 * dispatch is not void. The full case set is `packages/db/test/inventory/transfer-reversal.test.ts`.
 */
describe("SAH-018 A received dispatch cannot be reversed — the receipt link is read like a return — review MON-03", () => {
  let s: Seed;
  let trfType: string;
  let trrType: string;
  let itemId: string;
  let unitId: string;
  let whHq: string;
  let whBranch: string;
  let ctx: { tenantId: string; actorId: string; requestId: string };

  beforeAll(async () => {
    const { db } = await sharedDb();
    s = await seedTenantV2(db, "sah-018-mon03");
    ctx = { tenantId: s.tenant, actorId: s.human, requestId: "sah-018-mon03" };
    await ensureOpenPeriods(db, s, 2026);
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    for (const [code, nameEn, type] of [
      ["1300", "Inventory control", "asset"],
      ["1310", "Goods in transit", "asset"],
      ["2150", "Goods received not invoiced", "liability"],
      ["5110", "Stock-count variance", "expense"],
    ] as const) {
      await seedAccount(db, s, { code, nameEn, type });
    }
    trfType = await seedDocumentType(db, s, {
      code: "TRANSFER",
      module: "inventory",
      policy: packPolicy("TRANSFER"),
    });
    trrType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT",
      module: "inventory",
      policy: packPolicy("TRANSFER_RECEIPT"),
    });
    const grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: packPolicy("GOODS_RECEIPT"),
    });
    const supplier = await seedParty(db, s, { code: "SUP-018", kind: "vendor" });
    const branchB = await seedBranch(db, s, { code: "BR-018", nameEn: "Branch 018" });
    whHq = await seedWarehouse(db, s, { code: "WH-018-HQ", kind: "stock", branchId: s.hq });
    whBranch = await seedWarehouse(db, s, { code: "WH-018-BR", kind: "stock", branchId: branchB });
    await seedWarehouse(db, s, { code: "WH-018-TR", kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-018-T",
      trackLots: false,
      baseUnitId: unitId,
    }));
    const grn = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-06-01",
      partyId: supplier,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whHq,
          unitId,
          quantity: "20.000000",
          unitPrice: "5.0000",
          amount: "100.0000",
        },
      ],
    });
    await withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId: grn.documentId }));
  }, 180_000);

  it("reversing a dispatch whose receipt has posted is refused and writes nothing", async () => {
    const { db } = await sharedDb();
    const a = await withTenant(db.rw, ctx, async (tx) => {
      const d = await draftTransfer(tx, ctx, {
        fromWarehouseId: whHq,
        toWarehouseId: whBranch,
        effectiveDate: "2026-06-02",
        series: "TRF",
        documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: "10.000000" }],
      });
      await issueDocument(tx, ctx, { documentId: d.documentId });
      await postDocument(tx, ctx, { documentId: d.documentId });
      const r = await draftTransferReceipt(tx, ctx, {
        transferDocumentId: d.documentId,
        documentTypeId: trrType,
        series: "TRR",
        effectiveDate: "2026-06-03",
      });
      await issueDocument(tx, ctx, { documentId: r.documentId });
      await postDocument(tx, ctx, { documentId: r.documentId });
      return d;
    });
    await expect(
      withTenant(db.rw, ctx, (tx) =>
        reverseDocument(tx, ctx, {
          documentId: a.documentId,
          effectiveDate: "2026-06-04",
          reason: "SAH-018 MON-03",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL.*transfer receipt/);
    const [row] = await db.admin<{ status: string; n: number }[]>`
      select (select status::text from app.document where id = ${a.documentId}) as status,
             (select count(*)::int from app.document where reverses_document_id = ${a.documentId}) as n`;
    expect(row).toEqual({ status: "posted", n: 0 });
  });
});

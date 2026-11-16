import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, transitionDocument } from "../../src/posting";
import { draftExpiryWriteOff, WRITE_OFF_REASON_FIELD } from "../../src/inventory/write-off";
import { startDb, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedItem,
  seedLot,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { ctxOf, EXPIRY_WRITE_OFF_POLICY, GRN_POLICY } from "./policies";
import {
  ensureOpenPeriods,
  secondPrincipal,
} from "../../../../tests/invariants/support/post-inventory";
import type { TenantContext } from "../../src/with-tenant";

describe("EXPIRY_WRITE_OFF — branch drafts, accountant approves, 5100 tagged BRANCH (spec:1054)", () => {
  let db: Db;
  let s: Seed;
  let ewoType: string;
  let grnType: string;
  let itemId: string;
  let unitId: string;
  let partyId: string;
  let branchB: string;
  let whHq: string;
  let whBranch: string;
  let lotExpired: string;
  let lotGood: string;
  let acc1300: string;
  let clerk: string;
  let accountant: string;
  let clerkCtx: TenantContext;
  let accountantCtx: TenantContext;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-ewo");
    await grantCodes(db, s);
    // Every write-off below is dated in March 2026, which Plan 0A's `seedTenant` seeds LOCKED; issuing
    // into it is ERR_PERIOD_NOT_OPEN before R1, R2 or the ledger are ever reached.
    await ensureOpenPeriods(db, s, 2026);
    acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    // 5100 is 3C's account (§4.15) and is NAMED, never re-seeded, by the policy — but a Testcontainers
    // tenant has only seedTenantV2's two accounts, so the test creates it exactly as it creates 1300.
    // Task 2's hazard-33 case is what proves the real seed pack resolves it.
    await seedAccount(db, s, {
      code: "5100",
      nameEn: "Inventory write-off — expiry loss",
      type: "expense",
    });
    await seedAccount(db, s, {
      code: "2150",
      nameEn: "Goods received not invoiced",
      type: "liability",
    });
    ewoType = await seedDocumentType(db, s, {
      code: "EXPIRY_WRITE_OFF",
      module: "inventory",
      policy: EXPIRY_WRITE_OFF_POLICY,
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
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-EWO",
      trackLots: true,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    lotExpired = await seedLot(db, s, { itemId, code: "LOT-FEB", expiresOn: "2026-02-28" });
    lotGood = await seedLot(db, s, { itemId, code: "LOT-JAN", expiresOn: "2027-01-31" });

    clerk = await secondPrincipal(db, s, "clerk");
    accountant = await secondPrincipal(db, s, "accountant");
    // The authority split spec:1054 asks for, and the reason R1 and R2 are BOTH non-vacuous here: the
    // drafting code and the approving code are held by disjoint principals (Task 2's role grants).
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.create"],
      principalId: clerk,
      roleCode: "ewo-clerk",
    });
    await grantCodes(db, s, {
      codes: ["inventory.adjustment.approve"],
      principalId: accountant,
      roleCode: "ewo-approver",
    });
    await grantCodes(db, s, { codes: ["inventory.receipt.post", "inventory.receipt.create"] });
    clerkCtx = { tenantId: s.tenant, actorId: clerk, requestId: "ewo-clerk" };
    accountantCtx = { tenantId: s.tenant, actorId: accountant, requestId: "ewo-approver" };

    // 10 units of each lot at 4.0000 into WH-BR2 — the BRANCH the write-off is drafted at, which is what
    // makes the BRANCH-dimension case a real assertion rather than a restatement of `s.hq`.
    for (const lotId of [lotExpired, lotGood]) {
      const { documentId } = await draftTypedDocument(db, s, {
        documentTypeId: grnType,
        series: "GRN",
        effectiveDate: "2026-01-05",
        partyId,
        warehouseId: whBranch,
        branchId: branchB,
        lines: [
          {
            kind: "item",
            itemId,
            warehouseId: whBranch,
            lotId,
            unitId,
            quantity: "10.000000",
            unitPrice: "4.0000",
            amount: "40.0000",
          },
        ],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        postDocument(tx, ctxOf(s), { documentId }),
      );
    }
  }, 240_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** A fresh draft of two units of the expired lot, as the clerk. Each call drafts its OWN document:
   *  three cases below take one all the way to `posted`, and a memoised single draft would be written off
   *  three times against a lot that holds ten units once. */
  async function draft(effectiveDate = "2026-03-01"): Promise<{ documentId: string }> {
    return withTenant(db.rw, s.tenant, clerk, (tx) =>
      draftExpiryWriteOff(tx, clerkCtx, {
        documentTypeId: ewoType,
        series: "EWO",
        effectiveDate,
        warehouseId: whBranch,
        lots: [{ lotId: lotExpired, quantity: "2.000000" }],
        reason: "expired 2026-02-28, destroyed per SOP",
      }),
    );
  }

  /** …and its full R1/R2 walk: the clerk submits, the accountant approves, issues and posts. Two units at
   *  4.0000 = 8.0000 per call, so the lot's ten units cover the three cases that use it with room to spare
   *  and every one of them is a genuinely separate document. */
  async function approvedAndPosted(effectiveDate = "2026-03-01"): Promise<string> {
    const { documentId } = await draft(effectiveDate);
    await withTenant(db.rw, s.tenant, clerk, (tx) =>
      transitionDocument(tx, clerkCtx, { documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, accountant, async (tx) => {
      await transitionDocument(tx, accountantCtx, { documentId, to: "approved" });
      await transitionDocument(tx, accountantCtx, { documentId, to: "issued" });
      await postDocument(tx, accountantCtx, { documentId });
    });
    return documentId;
  }

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

  it("drafts one line per lot at the quantity on hand, and records the reason", async () => {
    const drafted = await withTenant(db.rw, s.tenant, clerk, (tx) =>
      draftExpiryWriteOff(tx, clerkCtx, {
        documentTypeId: ewoType,
        series: "EWO",
        effectiveDate: "2026-03-01",
        warehouseId: whBranch,
        lots: [{ lotId: lotExpired }],
        reason: "expired 2026-02-28, destroyed per SOP",
      }),
    );
    expect(drafted.totalQuantity).toBe("10.000000");
    // §4.2.11's header bag, not a `document.custom_fields` column — `app.document` has none in this tree.
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ reason: unknown }[]>`
      select value.value as reason
        from app.custom_field_value value
        join app.custom_field_definition definition on definition.id = value.definition_id
       where value.entity_id = ${drafted.documentId}
         and definition.entity = 'document' and definition.code = ${WRITE_OFF_REASON_FIELD}`,
    );
    expect(row!.reason).toBe("expired 2026-02-28, destroyed per SOP");
  });

  it("a lot with no stock in this warehouse is refused at DRAFTING time, naming the lot", async () => {
    await expect(
      withTenant(db.rw, s.tenant, clerk, (tx) =>
        draftExpiryWriteOff(tx, clerkCtx, {
          documentTypeId: ewoType,
          series: "EWO",
          effectiveDate: "2026-03-01",
          warehouseId: whHq,
          lots: [{ lotId: lotExpired }],
          reason: "wrong warehouse",
          // The message names the warehouse the CALL asked for — `input.warehouseId`, here WH-HQ — because
          // that is where the clerk claims the stock is. Step 4's raise reads `wh.code`, which is looked up
          // from `input.warehouseId`; expecting WH-BR2 (where the stock actually is) can never match, and
          // the case would fail even when the behaviour is exactly right.
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: lot LOT-FEB has no stock in warehouse WH-HQ/);
  });

  it("the CLERK cannot approve their own write-off (R1) and cannot post it (R2)", async () => {
    const { documentId } = await draft();
    await withTenant(db.rw, s.tenant, clerk, (tx) =>
      transitionDocument(tx, clerkCtx, { documentId, to: "submitted" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, clerk, (tx) =>
        transitionDocument(tx, clerkCtx, { documentId, to: "approved" }),
      ),
    ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    // …and even after the accountant approves and issues it, the clerk cannot post: R2 asks
    // app.actor_has(policy.approval.post = inventory.adjustment.approve), which the clerk does not hold.
    await withTenant(db.rw, s.tenant, accountant, async (tx) => {
      await transitionDocument(tx, accountantCtx, { documentId, to: "approved" });
      await transitionDocument(tx, accountantCtx, { documentId, to: "issued" });
    });
    await expect(
      withTenant(db.rw, s.tenant, clerk, (tx) => postDocument(tx, clerkCtx, { documentId })),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN|ERR_SOD/);
  });

  it("posts a debit to 5100 and a credit to the item's inventory account, at cost", async () => {
    // `approvedAndPosted` writes off 2 units of LOT-FEB at the AVCO unit cost 4.0000 = 8.0000, and it
    // drafts its OWN document per call — the lot holds ten units, and the three cases that use the helper
    // would otherwise be writing the same ten units off three times.
    const documentId = await approvedAndPosted("2026-03-01");
    expect(await ledgerOf(documentId)).toEqual([
      { code: "1300", debit: "0.0000", credit: "8.0000" },
      { code: "5100", debit: "8.0000", credit: "0.0000" },
    ]);
  });

  it("EVERY posted ledger line carries the BRANCH dimension of the drafting branch (spec:1054)", async () => {
    const documentId = await approvedAndPosted("2026-03-02");
    const dims = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; value_code: string }[]>`
      select dt.code, dv.code as value_code
        from app.ledger_entry e
        join app.ledger_entry_dimension d on d.entry_id = e.id
        join app.dimension_value dv on dv.id = d.dimension_value_id
        join app.dimension_type  dt on dt.id = dv.dimension_type_id
       where e.document_id = ${documentId} order by dt.code`,
    );
    expect(dims).toHaveLength(2); // one per ledger line
    expect(dims.every((d) => d.code === "BRANCH" && d.value_code === "BR-2")).toBe(true);
  });

  it("the write-off consumes the expired lot's own layer, not the cheapest one", async () => {
    // AVCO pools by (item, warehouse), but the MOVEMENT names the lot, so the quantity leaves the expired
    // lot's stock_on_hand key. A write-off that drained another lot would leave expired stock on the books
    // — which is why LOT-JAN exists in this fixture and holds the same ten units at the same cost.
    const documentId = await approvedAndPosted("2026-03-03");
    const [mv] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ lot_id: string }[]>`
      select lot_id from app.inventory_movement where document_id = ${documentId}`,
    );
    expect(mv!.lot_id).toBe(lotExpired);
  });
});

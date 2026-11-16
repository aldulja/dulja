import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { currency, Money, Quantity } from "@dulja/domain";
// `recordOverride` lives beside `postDocument` in `packages/db/src/posting/` (contracts §4.3.1, file layout
// at contracts:2046 — 2B put it in `posting/lifecycle.ts` and the barrel re-exports it). There is no
// `src/documents/events.ts`; an earlier draft of this block named one.
import { issueDocument, postDocument, recordOverride } from "../../src/posting";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
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
// §4.17.1 amendment 12 (Task 0): the one shared test helper this slice exports rather than copies.
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

const MYR = currency("MYR");
/** The agreed selling price. It reaches no ledger row in this slice — 4A's SALES_INVOICE is what recognises
 *  revenue (F-19) — but the order line carries it so the invoice can read it. */
const SELL = Money.of("9.0000", MYR);

describe("DELIVERY_ORDER — stock out to 1250, and the override path (spec:1051, test 18)", () => {
  let db: Db;
  let s: Seed;
  let soType: string;
  let doType: string;
  let grnType: string;
  let itemId: string;
  let unitId: string;
  let warehouseId: string;
  let partyId: string;
  let lotId: string;
  let acc1300: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-do");
    // `grantCodes(db, s)` with no `codes` grants NOTHING (its docstring), and 2B's R2 evaluates each
    // policy's `approval.post` inside the posting transaction: GRN_POLICY's for `receive()`,
    // DELIVERY_ORDER_POLICY's for `deliver()`.
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    await seedAccount(db, s, {
      code: "1250",
      nameEn: "Goods delivered not invoiced",
      type: "asset",
    });
    acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
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
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-DO",
      trackLots: true,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    // 2099, not the build year: migration 0112's `pick_lots_fefo` skips a lot already past its expiry on the
    // server's `current_date`, and every delivery below is drafted with `fefo: true`.
    lotId = await seedLot(db, s, { itemId, code: "LOT-A", expiresOn: "2099-06-30" });
    // 20 units at 3.0000 = 60.0000 of stock, one layer.
    await receive("20.000000", "3.0000", "60.0000");
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  /** `amount` is passed in rather than multiplied out: every fixture figure here is a hand-chosen constant
   *  and Global Constraint 1 forbids money through a float even in a test. */
  async function receive(qty: string, price: string, amount: string): Promise<string> {
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
          unitPrice: price,
          amount,
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
    return documentId;
  }

  /** Drafts a delivery for `qty` and posts it, returning the drafted document id and its posted status. The
   *  order line's extended amount is computed through `Money`, which is exact at scale 4 — `Number(qty) * 9`
   *  is the float this codebase never writes (Global Constraint 1). Nothing posts from the order itself
   *  (`lines: []`), so the figure is only what 4A's invoice will read. */
  async function deliver(
    qty: string,
    effectiveDate: string,
    beforePost?: (tx: Sql, id: string) => Promise<unknown>,
  ): Promise<{ documentId: string; status: string }> {
    const extended = SELL.multiply(Quantity.of(qty).toDecimal(), "HALF_AWAY_FROM_ZERO");
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate,
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId,
          unitId,
          quantity: qty,
          unitPrice: SELL.toString(),
          amount: extended.toString(),
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      issueDocument(tx, ctxOf(s), { documentId: order.documentId }),
    );
    return withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const { documentId } = await convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate,
        warehouseId,
        fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: qty }],
      });
      await issueDocument(tx, ctxOf(s), { documentId });
      if (beforePost !== undefined) await beforePost(tx, documentId);
      await postDocument(tx, ctxOf(s), { documentId });
      // `PostResult` carries the number, the sequence and the row ids but NOT a status (§4.3.1), so the
      // posted state is read back from the row the state machine wrote.
      const [row] = await tx<{ status: string }[]>`
        select status::text as status from app.document where id = ${documentId}`;
      return { documentId, status: row!.status };
    });
  }

  it("posts exactly two ledger lines: debit 1250, credit the item's inventory account, at cost", async () => {
    const { documentId } = await deliver("5.000000", "2026-01-10");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.debit::text, e.credit::text
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code`,
    );
    // 5 at the AVCO unit cost of 3.0000 = 15.0000. The DELIVERY carries no revenue: 9.0000 is the agreed
    // SELLING price, copied onto the line for 4A's invoice, and it appears in NO ledger row here.
    expect(rows).toEqual([
      { code: "1250", debit: "15.0000", credit: "0.0000" },
      { code: "1300", debit: "0.0000", credit: "15.0000" },
    ]);
  });

  it("writes one negative movement and decrements stock_on_hand", async () => {
    const { documentId } = await deliver("2.000000", "2026-01-11");
    const [mv] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ quantity: string; value: string; lot_id: string; movement_no: number }[]>`
        select quantity::text, value::text, lot_id, movement_no
          from app.inventory_movement where document_id = ${documentId}`,
    );
    expect(mv!.quantity).toBe("-2.000000"); // + receipt, − issue (§4.7.3)
    expect(mv!.value).toBe("-6.0000");
    expect(mv!.lot_id).toBe(lotId); // FEFO resolved the only lot with stock
    expect(mv!.movement_no).toBe(1);
  });

  it("document_line.cost is the non-negative magnitude applyMovements wrote", async () => {
    const { documentId } = await deliver("1.000000", "2026-01-12");
    const [line] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ cost: string }[]>`
        select cost::text from app.document_line where document_id = ${documentId}`,
    );
    expect(line!.cost).toBe("3.0000"); // never "-3.0000" — §4.7.2 amendment A6
  });

  it("an over-issue with NO override is refused by the data layer with ERR_STOCK_INSUFFICIENT (test 18)", async () => {
    await expect(deliver("500.000000", "2026-01-13")).rejects.toThrow(/ERR_STOCK_INSUFFICIENT/);
  });

  it("an over-issue WITH a second principal's override event posts, and the shortfall has no consumption row", async () => {
    const supervisor = await secondPrincipal(db, s, "supervisor");
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      principalId: supervisor,
      roleCode: "override-holder",
    });
    const remaining = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
         where item_id = ${itemId} and warehouse_id = ${warehouseId}`,
    );
    const onHand = Quantity.of(remaining[0]!.q);
    const asked = onHand.add(Quantity.of("4.000000")); // four units more than exist

    const { documentId, status } = await deliver(asked.toString(), "2026-01-14", (tx, id) =>
      // The ONE door F-6 admits, in the ONE shape §4.5.3's guard accepts. `recordOverride` does NOT take
      // `actor_id` from the ctx — `document_event.actor_id` defaults to `app.current_actor()`, so inside
      // this transaction it is always `s.human`, the document's creator (3B states this at 3b:2631-2634 and
      // shapes `postOverriddenIssue` the same way). The supervisor is therefore the **attributed**
      // principal: `assert_override_authorised` resolves `coalesce(attributed_to, actor_id)` and refuses
      // when that equals `created_by`. Passing a supervisor-flavoured ctx instead would insert
      // `actor_id = s.human, attributed_to = null` and raise. The event must be inserted BEFORE
      // postDocument: `assert_stock_available` fires inside it.
      recordOverride(tx, ctxOf(s), {
        documentId: id,
        code: "inventory.negative_stock.override",
        reason: "customer collection, count pending",
        attributedTo: supervisor,
      }),
    );

    expect(status).toBe("posted");
    // The FEFO split put the uncovered four units on their own line against the item's `NONE` sentinel lot,
    // so WH-MAIN now has two `stock_on_hand` rows for this item (LOT-A at 0 and NONE at −4). Sum them: a
    // single-row read would return whichever key the planner produced first.
    const [soh] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
         where item_id = ${itemId} and warehouse_id = ${warehouseId}`,
    );
    expect(soh!.q).toBe("-4.000000"); // genuinely negative, and visible as such

    // `cost_consumption.layer_id` is NOT NULL (§4.7.3), so the four uncovered units have no consumption
    // row — the covered quantity is consumed as usual and the uncovered quantity carries no value on
    // either side. That asymmetry is 3B's golden fixture to define, not this slice's.
    const [cons] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ q: string }[]>`
        select coalesce(sum(c.quantity), 0)::text as q
          from app.cost_consumption c
          join app.inventory_movement m on m.id = c.movement_id
         where m.document_id = ${documentId}`,
    );
    expect(Quantity.of(cons!.q).toString()).toBe(onHand.toString());
  });

  it("the override event needs a SECOND principal — the creator authorising itself is refused", async () => {
    // `attributedTo: s.human` is the creator, so `coalesce(attributed_to, actor_id)` = `created_by` and the
    // guard raises. This case is deliberately distinguishable from the one above: both run as `s.human`,
    // and the ONLY difference is which principal the override is attributed to — which is exactly the
    // control §4.5.3 describes. (Omitting `attributedTo` altogether raises the same code, because the
    // column then falls back to `app.current_actor()`, and that is what makes the positive case above
    // impossible to write any other way.)
    //
    // The creator is granted the override code first. `assert_override_authorised` (0021) checks
    // `principal_has` BEFORE the second-principal rule, so a creator who lacks the code is refused as
    // "does not hold" and the case would never reach the rule it is about. Holding the code does not help:
    // that is the claim.
    await grantCodes(db, s, {
      codes: ["inventory.negative_stock.override"],
      roleCode: "override-self",
    });
    await expect(
      deliver("999.000000", "2026-01-15", (tx, id) =>
        recordOverride(tx, ctxOf(s), {
          documentId: id,
          code: "inventory.negative_stock.override",
          reason: "self-authorised",
          attributedTo: s.human,
        }),
      ),
    ).rejects.toThrow(
      /ERR_OVERRIDE_NOT_AUTHORISED: an override on document .* needs a second principal/,
    );
  });
});

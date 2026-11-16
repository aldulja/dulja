import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import {
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
import { startDb, uuidv7, withTenant, type Db } from "../harness";
// The shared test-policy module, CREATED BY THIS TASK because Task 4 is the first task in execution order
// that configures a document type. Tasks 5, 7, 8 and 9 append to it.
import { ctxOf, GRN_POLICY, TRANSFER_RECEIPT_POLICY } from "../inventory/policies";
// The reach into `tests/invariants/support/**` is 3B's amendment A21(c) — the named `dependency-rule`
// allowance that lets a DB-tier costing suite use the same helpers the invariant suites do. Only
// `recordingJobs` is taken: `postInventoryDocument` writes no `party_id` and no count columns, so the two
// fixtures below are file-local.
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

/** File-local. §4.17 assigns 3D no fixtures.ts helper and hazard 9 forbids inventing one beside the
 *  register. Creates every account this slice's policies name by code — including **`2150`**, which is
 *  3C's `GOODS_RECEIPT` credit leg (`{ code: "2150" }`) and therefore needed by `receiveStock` below:
 *  §4.4.1 raises `ERR_POLICY_REQUIRES_MISSING` (422) on an `account.code` the company cannot resolve
 *  rather than falling back to a null account, so the first receipt would fail before any fill assertion
 *  ran. `1250`, `5000` and `5100` are not named by either policy this file posts; they are seeded anyway
 *  so the helper is the same six-plus-one list every other task in this slice uses. */
async function seedInventoryAccounts(db: Db, s: Seed): Promise<void> {
  await seedAccount(db, s, { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" });
  await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
  await seedAccount(db, s, { code: "1310", nameEn: "Goods in transit", type: "asset" });
  await seedAccount(db, s, {
    code: "2150",
    nameEn: "Goods received not invoiced",
    type: "liability",
  });
  await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
  await seedAccount(db, s, {
    code: "5100",
    nameEn: "Inventory write-off — expiry loss",
    type: "expense",
  });
  await seedAccount(db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
}

describe("applyMovements — the 3D fill rules (§4.7.2 as amended)", () => {
  let db: Db;
  let s: Seed;
  let item: { itemId: string; baseUnitId: string };
  let whA: string;
  let whTransit: string;
  let lot: string;
  let grn: string;
  let receiptType: string;
  let partyId: string;

  /** File-local. Puts `qty` of the item into `warehouseId` at `unitCost` through 3C's GOODS_RECEIPT, which
   *  is the only way stock legitimately exists (hazard 22: nothing outside the posting service writes a
   *  movement). Returns the receipt document id. */
  async function receiveStock(opts: {
    warehouseId: string;
    qty: string;
    unitCost: string;
  }): Promise<string> {
    const docId = await uuidv7(db.admin);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // Two columns an earlier draft of this fixture omitted, both of which fail BEFORE any assertion runs
      // and both of which read like a costing bug when they do:
      //   `series`   — `app.document.series` is `text not null` with NO default (plan0A:1780), so omitting
      //                it raises 23502 on the insert. The value is the policy's own `numbering.series`.
      //   `party_id` — `GRN_POLICY` declares `requires: ["party", "warehouse"]`, and step 4 of §4.3.2 runs
      //                `validateRequires` before anything else, raising ERR_POLICY_REQUIRES_MISSING naming
      //                `party`. The column is nullable in the DDL; the POLICY is what makes it mandatory.
      await tx`insert into app.document
                 (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id,
                  party_id, warehouse_id)
               values (${docId}, ${s.tenant}, ${s.company}, ${grn}, 'GRN', '2026-01-05', 'MYR', ${s.hq},
                       ${partyId}, ${opts.warehouseId})`;
      await tx`insert into app.document_line
                 (id, tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id,
                  unit_id, quantity, unit_price, amount)
               values (${lineId}, ${s.tenant}, ${s.company}, ${docId}, 1, 'item', ${item.itemId},
                       ${opts.warehouseId}, ${lot}, ${item.baseUnitId}, ${opts.qty}, ${opts.unitCost},
                       round(${opts.qty}::numeric * ${opts.unitCost}::numeric, 4))`;
      // The product is computed in SQL at numeric precision, never as `Number(qty) * Number(cost)`: Global
      // Constraint 1 forbids money through a float "at any phase, for any reason", and fixture code is where
      // that habit gets copied from.
    });
    // `jobs` is not optional here, unlike in the plan's draft of this fixture: the LAST case tops the
    // corridor up with a second receipt dated 2026-01-05 while movements already exist at 2026-01-20, which
    // is back-dating, and §4.3.2 step 14 refuses a back-dated inventory post whose caller supplied no
    // JobClient rather than silently skipping the recost (SAH-005).
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: docId, jobs: recordingJobs() }),
    );
    return docId;
  }

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "fill");
    await seedInventoryAccounts(db, s);
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.post",
        "inventory.transfer.post",
        "inventory.adjustment.approve",
        "accounting.journal.post",
      ],
    });
    await seedUnit(db, s, { code: "EA" });
    item = await seedItem(db, s, { code: "SKU1", trackLots: true });
    // `seedItem` seeds and resolves the item's default accounts itself — 1300, 5000 and 5900 through
    // `seedAccount` — so `inventory_account` resolves without an `accounts` override here.
    whA = await seedWarehouse(db, s, { code: "WH-A" });
    whTransit = await seedWarehouse(db, s, { code: "WH-TRANSIT", kind: "in_transit" });
    lot = await seedLot(db, s, { itemId: item.itemId, code: "L1", expiresOn: "2027-01-01" });
    // `vendor`, not the plan's `supplier`: §4.17's `seedParty` admits customer | vendor | employee |
    // student | dealer, and the supplier of a goods receipt is a vendor.
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    grn = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    receiptType = await seedDocumentType(db, s, {
      code: "TRANSFER_RECEIPT",
      module: "inventory",
      policy: TRANSFER_RECEIPT_POLICY,
    });
    // 100 units at 3.0000 into the in-transit warehouse: the state a dispatched TRANSFER leaves behind.
    await receiveStock({ warehouseId: whTransit, qty: "100.000000", unitCost: "3.0000" });
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  async function postReceipt(counted: string, expected: string): Promise<string> {
    const docId = await uuidv7(db.admin);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // `series` again (plan0A:1780). TRANSFER_RECEIPT's `requires` is `["warehouse", "to_warehouse"]` and
      // NOT `party`, so this insert carries no `party_id` — the two fixtures differ because the two
      // policies differ, not by oversight.
      await tx`insert into app.document
                 (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id,
                  warehouse_id, to_warehouse_id)
               values (${docId}, ${s.tenant}, ${s.company}, ${receiptType}, 'TRR', '2026-01-20', 'MYR',
                       ${s.hq}, ${whTransit}, ${whA})`;
      // `warehouse_id` is written on the LINE as well as the header, because the policy reads
      // `warehouse: "line.warehouse"` — which is also what `draftTransferReceipt` (Task 8) does, and what
      // this plan's Architecture paragraph means by "always writing `document_line.warehouse_id`
      // explicitly". The corridor is the line's warehouse; the header's `to_warehouse_id` is the
      // destination the receipt movement lands in.
      await tx`insert into app.document_line
                 (id, tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id,
                  unit_id, quantity, counted_quantity, expected_quantity)
               values (${lineId}, ${s.tenant}, ${s.company}, ${docId}, 1, 'item', ${item.itemId},
                       ${whTransit}, ${lot}, ${item.baseUnitId},
                       (${counted}::numeric(19,6) - ${expected}::numeric(19,6)),
                       ${counted}, ${expected})`;
      // The variance is subtracted in SQL, exactly as `draftTransferReceipt` does it — a quantity never
      // passes through `Number()` (Global Constraint 4), and the two operands and their difference are
      // written in one statement so they cannot disagree.
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: docId, jobs: recordingJobs() }),
    );
    return docId;
  }

  async function ledgerOf(
    documentId: string,
  ): Promise<{ code: string; debit: string; credit: string }[]> {
    // `l.credit desc` is the THIRD sort key and it is load-bearing, not decoration: an expected list may
    // hold two `1310` rows whose `debit` is `0.0000` on both, so `order by a.code, l.debit desc` leaves the
    // pair tied and Postgres may return either order — the case would pass or fail on plan choice. The
    // credits are what separate them.
    return withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.debit::text, l.credit::text
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.document_id = ${documentId} order by a.code, l.debit desc, l.credit desc`,
    );
  }

  async function costOf(documentId: string): Promise<string | null> {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string | null }[]>`
        select cost::text from app.document_line where document_id = ${documentId}`,
    );
    return row?.cost ?? null;
  }

  async function transitQuantity(): Promise<string> {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ q: string }[]>`
        select coalesce(sum(quantity), 0)::text as q from app.stock_on_hand
         where company_id = ${s.company} and item_id = ${item.itemId} and warehouse_id = ${whTransit}`,
    );
    return row!.q;
  }

  it("an unequal transfer fills `cost` from the receipt leg and `variance_value` from the difference", async () => {
    // 10 left in-transit at 3.0000 = 30.0000; 8 arrived = 24.0000; variance 6.0000.
    const docId = await postReceipt("8.000000", "10.000000");
    expect(await ledgerOf(docId)).toEqual([
      { code: "1300", debit: "24.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "24.0000" },
      { code: "1310", debit: "0.0000", credit: "6.0000" },
      { code: "5110", debit: "6.0000", credit: "0.0000" },
    ]);
    expect(await costOf(docId)).toBe("24.0000"); // the matched value, non-negative
  });

  it("the in-transit warehouse is emptied by the ISSUE leg's expected quantity, not the received one", async () => {
    expect(await transitQuantity()).toBe("90.000000"); // 100 − 10 dispatched-out, not 100 − 8
  });

  it("an exact transfer plans two ledger lines only, both at the same magnitude", async () => {
    const docId = await postReceipt("5.000000", "5.000000");
    expect(await ledgerOf(docId)).toEqual([
      { code: "1300", debit: "15.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "15.0000" },
    ]);
  });

  it("an over-receipt fills the same magnitudes and the POLICY reverses the variance direction", async () => {
    const docId = await postReceipt("7.000000", "6.000000");
    const rows = await ledgerOf(docId);
    expect(rows).toEqual([
      { code: "1300", debit: "21.0000", credit: "0.0000" },
      { code: "1310", debit: "3.0000", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "21.0000" },
      { code: "5110", debit: "0.0000", credit: "3.0000" },
    ]);
    // Every amount is a magnitude; nothing in this slice reads a sign to choose a direction (§4.4.2 A9).
    expect(rows.every((r) => !r.debit.startsWith("-") && !r.credit.startsWith("-"))).toBe(true);
  });

  it("a TOTAL LOSS in transit puts the whole dispatched value on 5110 and NOTHING on the destination", async () => {
    // counted 0 against expected 10: the receipt movement's quantity resolves to zero and Task 3's
    // behaviour 3 DROPS it (`app.inventory_movement` carries `check (quantity <> 0)`), so one movement
    // survives on a line the policy tagged with BOTH `cost` and `variance_value`. The fill rule is chosen
    // by the tags, so `cost` is Money.zero: the destination's inventory account is debited nothing and the
    // 30.0000 that left the corridor lands on 5110. If instead 1300 shows a 30.0000 debit and 1310 a
    // 60.0000 credit, `fillTaggedLedgerLines` is still keying on the movement COUNT — that is the defect
    // this case exists to catch, and it produces a document that balances.
    const docId = await postReceipt("0.000000", "10.000000");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.document_id = ${docId} group by a.code order by a.code`,
    );
    // Per-account sums, not an exact row list. The zero-amount `cost` pair is DROPPED rather than inserted
    // — `applyMovements` applies §4.3.2 step 6's zero-drop once the value is known, and postDocument's
    // step-9b guard refuses a plan that still carries a zero-amount line — so `1300` has no row at all
    // here, where the plan's draft of this case expected one at 0.0000/0.0000. The accounting claim the
    // case exists for is the same either way: nothing is debited to the destination, and the corridor is
    // relieved ONCE, in full.
    expect(rows).toEqual([
      { code: "1310", debit: "0.0000", credit: "30.0000" },
      { code: "5110", debit: "30.0000", credit: "0.0000" },
    ]);
    expect(await costOf(docId)).toBe("0.0000"); // `document_line.cost` follows the `fill: "cost"` value
    expect(await transitQuantity()).toBe("69.000000"); // 100 − 10 − 5 − 6 − 10: the whole dispatched 10 left
  });

  it("an EXACT receipt whose unit cost does not divide keeps BOTH legs at one value (§4.7.2 A7)", async () => {
    // This case is last on purpose: it changes the corridor's cost pool, and the four cases above assert
    // absolute figures against a pool of 3.0000 exactly.
    //
    // Top the corridor up with one unit at 4.0000. The pool becomes 70 units at 211.0000, whose average
    // 3.014285714… needs more precision than MONEY_SCALE holds — which is the whole point.
    await receiveStock({ warehouseId: whTransit, qty: "1.000000", unitCost: "4.0000" });
    const docId = await postReceipt("7.000000", "7.000000");
    // The two legs of ONE transfer line must carry ONE value. A `transferReceiptValue` that divided the
    // issue value by the issue quantity into a 4-dp `Money` and then re-multiplied would hand the receipt
    // leg a different figure — `21.1000 ÷ 7 = 3.0142857… → 3.0143 → × 7 = 21.1001`. The corridor would then
    // never clear: 1310 was debited |issue.value| at dispatch and is credited |receipt.value| here, so a
    // cent is stranded on the account for ever and Task 7's "1310 carries the value of the goods in
    // transit, to the cent" becomes false one document later.
    //
    // `sum(value)` over the document's two movements is the assertion rather than a literal, because it is
    // exact whichever way 3B rounds the pool (unit cost first, or the extended value first) — and the
    // defect this case catches is a DIFFERENCE between the two legs, not a particular figure.
    const [net] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ net: string; n: number }[]>`
        select coalesce(sum(value), 0)::text as net, count(*)::int as n
          from app.inventory_movement where document_id = ${docId}`,
    );
    expect(net).toEqual({ net: "0.0000", n: 2 });
    // …and the two `cost` ledger legs carry that same single magnitude, as does `document_line.cost`.
    const rows = await ledgerOf(docId);
    expect(rows.map((r) => r.code)).toEqual(["1300", "1310"]);
    const cost = await costOf(docId);
    expect(rows[0]!.debit).toBe(cost);
    expect(rows[1]!.credit).toBe(cost);
  });
});

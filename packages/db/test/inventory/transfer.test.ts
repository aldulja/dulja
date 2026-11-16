import { Money, currency } from "@dulja/domain";
import { valuationAsOf } from "../../src/costing/valuation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument, postDocument, reverseDocument } from "../../src/posting";
import { draftTransfer, resolveInTransitWarehouse } from "../../src/inventory/transfer";
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
import { ctxOf, GRN_POLICY, TRANSFER_POLICY } from "./policies";

describe("TRANSFER — dispatch into an in-transit warehouse (spec:1053; the DoD clause)", () => {
  let db: Db;
  let s: Seed;
  let trfType: string;
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
    s = await seedTenantV2(db, "tenant-3d-trf");
    // `seedTenant` grants `s.human` NOTHING (§4.1), and 2B's R2 evaluates `approval.post` inside the
    // posting transaction, so a bare `grantCodes(db, s)` would leave every post below a 403.
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
    grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    partyId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    // Two branches: s.hq (Plan 0A's BRANCH value) and a second from 0D's seedBranch.
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
      code: "SKU-TRF",
      trackLots: false,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));
    // 12 units at 5.0000 into WH-HQ.
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
          quantity: "12.000000",
          unitPrice: "5.0000",
          amount: "60.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId }));
  }, 180_000);
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
      return {
        ...drafted,
        result: await postDocument(tx, ctxOf(s), { documentId: drafted.documentId }),
      };
    });
  }

  it("resolveInTransitWarehouse finds the in_transit warehouse of the DESTINATION's branch", async () => {
    const resolved = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      resolveInTransitWarehouse(tx, whBranch, s.company),
    );
    expect(resolved).toBe(whTransit);
  });

  it("a destination branch with no in_transit warehouse is refused, naming the branch", async () => {
    const branchC = await seedBranch(db, s, { code: "BR-3", nameEn: "Branch 3" });
    const whC = await seedWarehouse(db, s, {
      code: "WH-BR3",
      kind: "stock",
      branchId: branchC,
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => resolveInTransitWarehouse(tx, whC, s.company)),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: branch .* has no in_transit warehouse/);
  });

  it("emits TWO movements for one line — an issue at the source and a receipt in transit", async () => {
    const { documentId } = await dispatch("5.000000", "2026-01-10");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        { movement_no: number; warehouse_id: string; quantity: string; value: string }[]
      >`select movement_no, warehouse_id, quantity::text, value::text
          from app.inventory_movement where document_id = ${documentId} order by movement_no`,
    );
    expect(rows).toEqual([
      { movement_no: 1, warehouse_id: whHq, quantity: "-5.000000", value: "-25.0000" },
      { movement_no: 2, warehouse_id: whTransit, quantity: "5.000000", value: "25.0000" },
    ]);
  });

  it("THE DoD CLAUSE — in transit is in neither warehouse's on-hand and in the company's total", async () => {
    // Opening: 12 at HQ. One dispatch has run above and moved 5. So HQ 7, transit 5, company total 12 —
    // and WH-BR2 has NO ROW AT ALL, which is a stronger statement of "the destination is unchanged" than a
    // zero would be. `app.stock_on_hand` rows exist only where the step-12 MERGE inserted one, and its
    // source is the document's own movements (§4.7.3): a warehouse no movement has touched is absent from
    // the projection, so a `{ code: "WH-BR2", quantity: "0.000000" }` expectation would fail on the join,
    // not on the arithmetic.
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; kind: string; quantity: string }[]>`
        select w.code, w.kind, sum(h.quantity)::text as quantity
          from app.stock_on_hand h join app.warehouse w on w.id = h.warehouse_id
         where h.item_id = ${itemId} group by w.code, w.kind order by w.code`,
    );
    expect(rows).toEqual([
      { code: "WH-BR2-TR", kind: "in_transit", quantity: "5.000000" }, // held here
      { code: "WH-HQ", kind: "stock", quantity: "7.000000" }, // source decremented
    ]);
    expect(rows.some((r) => r.code === "WH-BR2")).toBe(false); // destination UNCHANGED — no row
    // …and the company total is unchanged by the move.
    const [total] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ q: string }[]>`
        select sum(quantity)::text as q from app.stock_on_hand where item_id = ${itemId}`,
    );
    expect(total!.q).toBe("12.000000");
  });

  it("1310 carries the value of the goods in transit, to the cent", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ debit: string; credit: string }[]>`
        select coalesce(sum(e.debit), 0)::text as debit, coalesce(sum(e.credit), 0)::text as credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where a.code = '1310' and e.company_id = ${s.company}`,
    );
    // 5 units at the AVCO unit cost 5.0000. Debit only: nothing has been received yet.
    expect(row!.debit).toBe("25.0000");
    expect(row!.credit).toBe("0.0000");
  });

  it("both ledger legs are the same magnitude and `side` carries the direction (A9)", async () => {
    const { documentId } = await dispatch("2.000000", "2026-01-11");
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.debit::text, e.credit::text
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${documentId} order by a.code`,
    );
    expect(rows).toEqual([
      { code: "1300", debit: "0.0000", credit: "10.0000" },
      { code: "1310", debit: "10.0000", credit: "0.0000" },
    ]);
    // Neither figure is ever negative — the ledger_entry CHECKs would refuse it (§4.4.2 A9). Tested on the
    // `::text` form, not through `Number()`: no monetary value in this plan passes through a float.
    for (const r of rows) {
      expect(r.debit.startsWith("-")).toBe(false);
      expect(r.credit.startsWith("-")).toBe(false);
    }
  });

  it("the destination layer is created at the source's unit cost, not re-derived", async () => {
    const layers = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; qty_in: string; unit_cost: string }[]>`
        select w.code, l.qty_in::text, l.unit_cost::text
          from app.cost_layer l join app.warehouse w on w.id = l.warehouse_id
         where l.item_id = ${itemId} and w.kind = 'in_transit' order by l.sequence`,
    );
    expect(layers.map((l) => l.unit_cost)).toEqual(["5.0000", "5.0000"]);
  });

  it("the final destination is recorded on the dispatch, and it is NOT the corridor (ADR 0043)", async () => {
    const { documentId, inTransitWarehouseId } = await dispatch("1.000000", "2026-01-12");
    expect(inTransitWarehouseId).toBe(whTransit);
    const [header] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ warehouse_id: string; to_warehouse_id: string; final: string | null }[]>`
        select d.warehouse_id, d.to_warehouse_id,
               (select v.value #>> '{}' from app.custom_field_value v
                  join app.custom_field_definition f on f.id = v.definition_id
                 where v.entity_id = d.id and f.code = 'final_warehouse_id') as final
          from app.document d where d.id = ${documentId}`,
    );
    expect(header!.warehouse_id).toBe(whHq);
    expect(header!.to_warehouse_id).toBe(whTransit);
    expect(header!.final).toBe(whBranch);
  });

  it("refuses a transfer whose source and destination are one warehouse", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        draftTransfer(tx, ctxOf(s), {
          fromWarehouseId: whBranch,
          toWarehouseId: whBranch,
          effectiveDate: "2026-01-13",
          series: "TRF",
          documentTypeId: trfType,
          lines: [{ itemId, unitId, quantity: "1.000000" }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: a transfer's source and destination are the same/);
  });

  it("refuses an in_transit warehouse named as the DESTINATION", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        resolveInTransitWarehouse(tx, whTransit, s.company),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: warehouse WH-BR2-TR is in_transit/);
  });

  // ── Code review 3 (Phase 4), R3: a hand-drafted negative dispatch line ──────────────────────────────────
  // TRANSFER's two rules (Dr 1310 / Cr item.inventory_account at line.cost, on `line.kind: item`) do not
  // select on the sign, so the ledger kept the dispatch's sides while `orientLeg` flipped BOTH movements. A
  // TRANSFER drafted at -2 — reachable through PUT …/lines, whose quantity is signed; only draftTransfer's own
  // body is positive — posted on 381bb34: +2 back into WH-HQ and -2 out of transit, beside 1310 Dr / 1300 Cr
  // of the same value, so each account moved the opposite way to its stock and the corridor never clears.
  it("a TRANSFER drafted by hand at -2 is refused at post: no movement, no ledger row, no number (R3)", async () => {
    const snapshot = async () =>
      (
        await withTenant(
          db.rw,
          s.tenant,
          s.human,
          (tx) => tx<{ n1300: string; n1310: string; hq: string; transit: string }[]>`
            select (select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text
                      from app.ledger_entry e join app.account a on a.id = e.account_id
                     where a.company_id = ${s.company} and a.code = '1300') as n1300,
                   (select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text
                      from app.ledger_entry e join app.account a on a.id = e.account_id
                     where a.company_id = ${s.company} and a.code = '1310') as n1310,
                   (select coalesce(sum(quantity), 0)::numeric(19,6)::text from app.stock_on_hand
                     where item_id = ${itemId} and warehouse_id = ${whHq}) as hq,
                   (select coalesce(sum(quantity), 0)::numeric(19,6)::text from app.stock_on_hand
                     where item_id = ${itemId} and warehouse_id = ${whTransit}) as transit`,
        )
      )[0];
    const before = await snapshot();
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId: trfType,
      series: "TRF",
      effectiveDate: "2026-01-14",
      warehouseId: whHq,
      toWarehouseId: whTransit,
      lines: [{ kind: "item", itemId, warehouseId: whHq, quantity: "-2.000000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctxOf(s), { documentId })),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* line 1: a negative-quantity TRANSFER line .*POST …\/reverse of the original/,
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
    expect(await snapshot()).toEqual(before);
  });

  it("the registered way to undo a dispatch — reverseDocument of it — still posts, both legs back (R3's control)", async () => {
    const { documentId } = await dispatch("1.000000", "2026-01-15");
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctxOf(s), {
        documentId,
        effectiveDate: "2026-01-15",
        reason: "dispatched in error",
      }),
    );
    const moves = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ warehouse_id: string; quantity: string; value: string }[]>`
        select warehouse_id, quantity::text as quantity, value::text as value
          from app.inventory_movement where document_id = ${reversalDocumentId} order by movement_no`,
    );
    expect(moves).toEqual([
      { warehouse_id: whHq, quantity: "1.000000", value: "5.0001" },
      { warehouse_id: whTransit, quantity: "-1.000000", value: "-5.0001" },
    ]);
    const ledger = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, e.debit::text as debit, e.credit::text as credit
          from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${reversalDocumentId} order by a.code`,
    );
    expect(ledger).toEqual([
      { code: "1300", debit: "5.0001", credit: "0.0000" },
      { code: "1310", debit: "0.0000", credit: "5.0001" },
    ]);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await valuationAsOf(tx, {
        companyId: s.company,
        asOf: "2026-01-31",
        limit: 100,
      });
      const myr = currency("MYR");
      const total = rows.reduce((sum, row) => sum.add(Money.of(row.value, myr)), Money.zero(myr));
      const [balance] = await tx<
        { value: string }[]
      >`select sum(e.base_debit - e.base_credit)::numeric(19,4)::text as value
        from app.ledger_entry e join app.account a on a.id = e.account_id
        where e.company_id = ${s.company} and a.code in ('1300', '1310')`;
      expect(total.toString()).toBe(balance!.value);
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { valuationAsOf } from "../../src/costing/valuation";
import { convertOrderToDelivery } from "../../src/inventory/fulfilment";
import { draftTransfer } from "../../src/inventory/transfer";
import { lintSchema } from "../../src/lint-schema";
import { issueDocument, postDocument } from "../../src/posting";
import { salesByItem } from "../../src/reports/sales-by-item";
import { stockOnHand, stockOnHandTotals } from "../../src/reports/stock-on-hand";
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
import {
  ctxOf,
  DELIVERY_ORDER_POLICY,
  GRN_POLICY,
  SALES_ORDER_POLICY,
  TRANSFER_POLICY,
} from "../inventory/policies";

/** The tie-outs sum EXACTLY, through `Money`, never through `Number()` (Global Constraints 1 and 4). */
const MYR = currency("MYR");

describe("the three minimal inventory reports (spec:2300, §4.16.1, §4.16.3)", () => {
  let db: Db;
  let s: Seed;
  let whHq: string;
  let whBr2: string;
  let itemId: string;
  let unitId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d-reports");
    // `seedTenant` grants `s.human` NOTHING (§4.1) and 2B's R2 evaluates `approval.post` INSIDE the posting
    // transaction, so every code the four policies below name has to be granted before the first post.
    await grantCodes(db, s, {
      codes: [
        "inventory.receipt.create",
        "inventory.receipt.post",
        "accounting.sales.create",
        "inventory.transfer.create",
        "inventory.transfer.post",
      ],
    });
    const acc1300 = await seedAccount(db, s, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    for (const account of [
      { code: "1250", nameEn: "Goods delivered not invoiced", type: "asset" as const },
      { code: "1310", nameEn: "Goods in transit", type: "asset" as const },
      { code: "2150", nameEn: "Goods received not invoiced", type: "liability" as const },
      { code: "5110", nameEn: "Stock-count variance", type: "expense" as const },
    ]) {
      await seedAccount(db, s, account);
    }
    const grnType = await seedDocumentType(db, s, {
      code: "GOODS_RECEIPT",
      module: "inventory",
      policy: GRN_POLICY,
    });
    const soType = await seedDocumentType(db, s, {
      code: "SALES_ORDER",
      module: "inventory",
      policy: SALES_ORDER_POLICY,
    });
    const doType = await seedDocumentType(db, s, {
      code: "DELIVERY_ORDER",
      module: "inventory",
      policy: DELIVERY_ORDER_POLICY,
    });
    const trfType = await seedDocumentType(db, s, {
      code: "TRANSFER",
      module: "inventory",
      policy: TRANSFER_POLICY,
    });
    // `seedParty`'s kinds are customer|vendor|employee|student|dealer — there is no "supplier".
    const vendorId = await seedParty(db, s, { code: "SUP-1", kind: "vendor" });
    const customerId = await seedParty(db, s, { code: "CUST-1", kind: "customer" });
    const branchB = await seedBranch(db, s, { code: "BR-2", nameEn: "Branch 2" });
    whHq = await seedWarehouse(db, s, { code: "WH-HQ", kind: "stock", branchId: s.hq });
    whBr2 = await seedWarehouse(db, s, { code: "WH-BR2", kind: "stock", branchId: branchB });
    // The corridor. It is never named by a caller — `draftTransfer` resolves it from the DESTINATION's
    // branch — so it is seeded and not held, and the reports below find it through `warehouse.kind`.
    await seedWarehouse(db, s, { code: "WH-BR2-TR", kind: "in_transit", branchId: branchB });
    unitId = await seedUnit(db, s, { code: "PCS" });
    ({ itemId } = await seedItem(db, s, {
      code: "SKU-RPT",
      trackLots: false,
      baseUnitId: unitId,
      accounts: { inventoryAccountId: acc1300 },
    }));

    // 1. GRN of 20 @ 5.0000 into WH-HQ → 100.0000 of stock in one layer.
    const grn = await draftTypedDocument(db, s, {
      documentTypeId: grnType,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId: vendorId,
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
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctxOf(s), { documentId: grn.documentId }),
    );

    // 2. A DELIVERY_ORDER of 6, through the order-to-delivery conversion — the only path that produces
    //    DELIVERY_ORDER movements, which is what `salesByItem` counts.
    const order = await draftTypedDocument(db, s, {
      documentTypeId: soType,
      series: "SO",
      effectiveDate: "2026-01-10",
      partyId: customerId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId,
          warehouseId: whHq,
          unitId,
          quantity: "6.000000",
          unitPrice: "9.0000",
          amount: "54.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await issueDocument(tx, ctxOf(s), { documentId: order.documentId });
      const { documentId } = await convertOrderToDelivery(tx, ctxOf(s), {
        sourceDocumentId: order.documentId,
        targetDocumentTypeId: doType,
        targetSeries: "DO",
        effectiveDate: "2026-01-11",
        warehouseId: whHq,
        fefo: true,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "6.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId });
      await postDocument(tx, ctxOf(s), { documentId });
    });

    // 3. A TRANSFER of 4 to WH-BR2, left UNRECEIVED: the corridor holds it, so WH-HQ is 20 − 6 − 4 = 10,
    //    WH-BR2-TR is 4, WH-BR2 has no row at all, and the company total is 14. That is the whole of the
    //    definition-of-done clause, read back through the report in the third case below.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const drafted = await draftTransfer(tx, ctxOf(s), {
        fromWarehouseId: whHq,
        toWarehouseId: whBr2,
        effectiveDate: "2026-01-15",
        series: "TRF",
        documentTypeId: trfType,
        lines: [{ itemId, unitId, quantity: "4.000000" }],
      });
      await issueDocument(tx, ctxOf(s), { documentId: drafted.documentId });
      await postDocument(tx, ctxOf(s), { documentId: drafted.documentId });
    });
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("stockOnHand excludes in-transit rows by default and reports the warehouse kind", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, limit: 50 }),
    );
    expect(rows.map((row) => [row.warehouseCode, row.quantity])).toEqual([["WH-HQ", "10.000000"]]);
    expect(rows.every((row) => row.warehouseKind === "stock")).toBe(true);
  });

  it("includeInTransit surfaces the corridor row", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, includeInTransit: true, limit: 50 }),
    );
    expect(rows.map((row) => [row.warehouseCode, row.warehouseKind, row.quantity])).toEqual([
      ["WH-BR2-TR", "in_transit", "4.000000"],
      ["WH-HQ", "stock", "10.000000"],
    ]);
  });

  it("THE DoD CLAUSE, from the report's own output: shelves 10, transit 4, total 14", async () => {
    const totals = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHandTotals(tx, { companyId: s.company, itemId }),
    );
    expect(totals).toEqual({ onShelves: "10.000000", inTransit: "4.000000", total: "14.000000" });
  });

  it("the destination warehouse has no on-hand row at all until the receipt leg posts", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, {
        companyId: s.company,
        warehouseId: whBr2,
        includeInTransit: true,
        limit: 50,
      }),
    );
    expect(rows).toEqual([]);
  });

  it("TIE-OUT 1 — Σ valuationAsOf value = the 1300 + 1310 ledger balances, to the cent", async () => {
    // Both sides are summed EXACTLY — the ledger side in SQL at numeric precision, returned as `::text`,
    // and the valuation side through `Money.add`. `rows.reduce((n, r) => n + Number(r.value), 0)` over many
    // `numeric(19,4)` values can differ from the exact total in the fourth decimal place, and `.toFixed(4)`
    // then rounds two accumulations to two different strings: a test whose stated contract is "to the cent"
    // must not be able to pass or fail on accumulation order.
    const { valued, ledger } = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await valuationAsOf(tx, {
        companyId: s.company,
        asOf: "2026-12-31",
        limit: 500,
      });
      const [balance] = await tx<{ bal: string }[]>`
        select coalesce(sum(e.base_debit) - sum(e.base_credit), 0)::text as bal
          from app.ledger_entry e
          join app.account a on a.tenant_id = e.tenant_id and a.id = e.account_id
         where a.code in ('1300', '1310') and e.company_id = ${s.company}`;
      return {
        valued: rows.reduce((money, row) => money.add(Money.of(row.value, MYR)), Money.zero(MYR)),
        ledger: Money.of(balance!.bal, MYR),
      };
    });
    expect(valued.toString()).toBe(ledger.toString());
    expect(valued.toString()).toBe("70.0000");
  });

  it("TIE-OUT 2 — salesByItem's cost = Σ cost_consumption on DELIVERY_ORDER movements = the 1250 balance", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
        limit: 50,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredQuantity).toBe("6.000000");
    expect(rows[0]!.cost).toBe("30.0000");
    const [account] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ bal: string }[]>`
      select (sum(e.base_debit) - sum(e.base_credit))::text as bal
        from app.ledger_entry e
        join app.account a on a.tenant_id = e.tenant_id and a.id = e.account_id
       where a.code = '1250' and e.company_id = ${s.company}`,
    );
    expect(account!.bal).toBe("30.0000");
  });

  it("salesByItem counts DELIVERY_ORDER movements only — a transfer or a write-off is not a sale", async () => {
    // The TRANSFER issued 4 units out of WH-HQ. If the report joined on `quantity < 0` alone it would
    // report 10 delivered. The join is on document_type.code = 'DELIVERY_ORDER'.
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
        limit: 50,
      }),
    );
    expect(rows[0]!.deliveredQuantity).toBe("6.000000");
  });

  it("salesByItem's range is on effective_date and is inclusive at both ends", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-01-10",
        limit: 50,
      }),
    );
    expect(before).toEqual([]);
    const onTheDay = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-11",
        toDate: "2026-01-11",
        limit: 50,
      }),
    );
    expect(onTheDay[0]!.deliveredQuantity).toBe("6.000000");
  });

  it("stockOnHand pages by (itemCode, warehouseCode, lotCode) and the cursor round-trips", async () => {
    const page1 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, { companyId: s.company, includeInTransit: true, limit: 1 }),
    );
    expect(page1.map((row) => row.warehouseCode)).toEqual(["WH-BR2-TR"]);
    const page2 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, {
        companyId: s.company,
        includeInTransit: true,
        limit: 1,
        cursor: {
          itemCode: page1[0]!.itemCode,
          warehouseCode: page1[0]!.warehouseCode,
          lotCode: page1[0]!.lotCode,
        },
      }),
    );
    expect(page2.map((row) => row.warehouseCode)).toEqual(["WH-HQ"]);
    const page3 = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      stockOnHand(tx, {
        companyId: s.company,
        includeInTransit: true,
        limit: 1,
        cursor: {
          itemCode: page2[0]!.itemCode,
          warehouseCode: page2[0]!.warehouseCode,
          lotCode: page2[0]!.lotCode,
        },
      }),
    );
    expect(page3).toEqual([]); // exhausted, and no row was returned twice
  });

  it("no report re-aggregates the movement table — the SQL reads the projection", () => {
    // The path is relative to `process.cwd()`, which is `packages/db`: every run of this suite is
    // `--cwd packages/db`. A repo-root-relative "packages/db/src/..." would resolve to
    // `packages/db/packages/db/src/...` and throw ENOENT.
    const source = readFileSync(join(process.cwd(), "src", "reports", "stock-on-hand.ts"), "utf8");
    expect(source).toMatch(/app\.stock_on_hand/);
    expect(source).not.toMatch(/from app\.inventory_movement/);
  });

  it("lintSchema still reports zero violations after 0042 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("migration 0042 leaves exactly one btree index on cost_consumption.movement_id", async () => {
    // The covering form REPLACES 3B's index rather than sitting beside it: two indexes on one key would be
    // write amplification on every posting transaction for no read the first does not already serve.
    const rows = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes
       where schemaname = 'app' and tablename = 'cost_consumption'
         and indexdef like '%(movement_id)%'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("INCLUDE");
  });
});

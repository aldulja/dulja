import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  Money,
  Quantity,
  currency,
  intlFormatters,
  renderReport,
  validateReportDefinition,
} from "@dulja/domain";
import { rebuildStockValuation, valuationAsOf } from "../../src/costing/valuation";
import { rebuildItemProfitability } from "../../src/projections/item-profitability";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { salesByItem } from "../../src/reports/sales-by-item";
import { stockOnHand } from "../../src/reports/stock-on-hand";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import {
  assertTieOut,
  readDefinition,
  readEnvelope,
  reportFixture,
  runDefinition,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";
import { postFromPack } from "../../../../tests/invariants/support/ar-ap";

/**
 * 7B Task 8 — 3D's three minimal-set codes re-expressed at `definitionVersion = 2` (§4.16.1, spec:2300).
 *
 * Amendment A2: 3D's (and 4A's) JSON routes, DTOs and read functions stand byte for byte. The definitions give
 * the codes a render path and a designer entry; the PARITY cases below prove the definition's rows equal
 * `stockOnHand` / `valuationAsOf` / `salesByItem` row for row and figure for figure, and 3D's own report test
 * is re-run unchanged.
 */
const MYR = currency("MYR");
const SOH = "inventory.stock_on_hand";
const VALUATION = "inventory.valuation";
const SALES = "inventory.sales_by_item";
const AS_OF = "2026-01-31";

describe("7B re-expresses 3D's three minimal-set codes (§4.16.1, spec:2300, amendment A2)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true, sales: true });
    // Both projections are asynchronous; their rebuilds are 3B's and 4B's own functions, run as the tenant's
    // system principal (hazard 20). This slice writes no projection row.
    await withTenant(db.rw, f.s.tenant, f.s.system, async (tx) => {
      await rebuildStockValuation(tx, { companyId: f.s.company, asOf: AS_OF });
      await rebuildItemProfitability(tx, { companyId: f.s.company });
    });
  }, 240_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const inv = () => {
    if (f.inventory === null) throw new Error("the fixture was built without { inventory: true }");
    return f.inventory;
  };
  const sohParams = (warehouseKinds: string) => ({
    companyId: f.s.company,
    warehouseKinds,
    itemId: null,
    warehouseId: null,
    hideQuantity: "0",
  });
  const valuationParams = () => ({
    companyId: f.s.company,
    asOf: AS_OF,
    itemId: inv().itemId,
    warehouseId: null,
  });

  it("all three are seeded at definitionVersion 2 with 3D's codes and permissions unchanged", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const [code, permission] of [
      [SOH, "inventory.stock.read"],
      [VALUATION, "inventory.cost.read"],
      [SALES, "inventory.stock.read"],
    ] as const) {
      const envelope = readEnvelope(code);
      expect(envelope.definitionVersion).toBe(2);
      expect(envelope.definition.version).toBe(1);
      expect(envelope.definition.code).toBe(code);
      expect(envelope.definition.permission).toBe(permission);
      expect(envelope.definition.module).toBe("inventory");
      const result = validateReportDefinition(envelope.definition, sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
    }
  });

  it("PARITY: stock_on_hand with warehouseKinds=stock is exactly the function's default answer", async () => {
    await read(async (tx) => {
      const fn = await stockOnHand(tx, { companyId: f.s.company, limit: 100 });
      const def = await runDefinition(tx, readDefinition(SOH), sohParams("stock"));
      // LEFT: the dataset's snake_case alias (A3). RIGHT: 3D's `StockOnHandReportRow` camelCase member.
      expect(
        def.map((r) => [
          String(r["item_code"]),
          String(r["warehouse_code"]),
          String(r["warehouse_kind"]),
          String(r["lot_code"]),
          r["expires_on"],
          Quantity.of(String(r["quantity"])).toString(),
        ]),
      ).toEqual(
        fn.map((r) => [
          r.itemCode,
          r.warehouseCode,
          r.warehouseKind,
          r.lotCode,
          r.lotExpiresOn,
          Quantity.of(r.quantity).toString(),
        ]),
      );
      expect(def.map((r) => String(r["warehouse_code"]))).toEqual(["WH-HQ"]);
    });
  });

  it("PARITY: warehouseKinds=stock,in_transit is exactly includeInTransit — the corridor row appears", async () => {
    await read(async (tx) => {
      const fn = await stockOnHand(tx, {
        companyId: f.s.company,
        includeInTransit: true,
        limit: 100,
      });
      const def = await runDefinition(tx, readDefinition(SOH), sohParams("stock,in_transit"));
      expect(
        def.map((r) => [
          String(r["warehouse_code"]),
          Quantity.of(String(r["quantity"])).toString(),
        ]),
      ).toEqual(fn.map((r) => [r.warehouseCode, Quantity.of(r.quantity).toString()]));
      expect(def.length).toBe(2);
      await assertTieOut(tx, readDefinition(SOH), {
        params: sohParams("stock,in_transit"),
        baseCurrency: MYR,
      });
    });
  });

  it("warehouseKinds is REQUIRED: a definition has no defaults, and an empty value would answer a different number", () => {
    const p = readDefinition(SOH).parameters.find((x) => x.name === "warehouseKinds");
    expect(p).toEqual({ name: "warehouseKinds", kind: "text", required: true });
    expect(readDefinition(SOH).dataset.filters).toContainEqual({
      field: "warehouse_kind",
      op: "in",
      param: "warehouseKinds",
    });
  });

  // 3D's `stockOnHand` reads `h.quantity <> 0`; the `stock_on_hand` dataset returns every projection row,
  // and a line received and then issued in full leaves a ZERO row behind. The definition carries 3D's
  // predicate as `quantity ne hideQuantity` with a REQUIRED one-option enum — a definition has no constants
  // and no defaults, so the run names the value, as it names `warehouseKinds`. Its own tenant: issuing the
  // rest of WH-HQ here would move every figure the cases above pin.
  it("PARITY with a zero row: a stock line issued in full is hidden by the function and by the definition", async () => {
    const z = await reportFixture(db, "Zero", { inventory: true });
    const zi = z.inventory!;
    // WH-HQ holds 30 after the chain (40 in, 6 delivered, 4 dispatched); deliver the other 30.
    await postFromPack(db, z.s, {
      code: "DELIVERY_ORDER",
      effectiveDate: "2026-01-20",
      partyId: zi.customerId,
      warehouseId: zi.whHq,
      lines: [
        {
          kind: "item",
          itemId: zi.itemId,
          warehouseId: zi.whHq,
          lotId: zi.lotId,
          unitId: zi.baseUnitId,
          quantity: "30.000000",
          unitPrice: "11.0000",
          amount: "330.0000",
        },
      ],
    });
    await withTenant(db.rw, z.s.tenant, z.reader, async (tx) => {
      const [zero] = await tx<{ quantity: string }[]>`
        select quantity::text as quantity from app.stock_on_hand
         where company_id = ${z.s.company} and warehouse_id = ${zi.whHq}`;
      expect(Quantity.of(zero!.quantity).toString(), "the projection keeps the zero row").toBe(
        Quantity.zero().toString(),
      );
      const params = {
        companyId: z.s.company,
        warehouseKinds: "stock,in_transit",
        itemId: null,
        warehouseId: null,
      };
      const fn = await stockOnHand(tx, {
        companyId: z.s.company,
        includeInTransit: true,
        limit: 100,
      });
      const def = await runDefinition(tx, readDefinition(SOH), { ...params, hideQuantity: "0" });
      expect(
        def.map((r) => [
          String(r["warehouse_code"]),
          Quantity.of(String(r["quantity"])).toString(),
        ]),
      ).toEqual(fn.map((r) => [r.warehouseCode, Quantity.of(r.quantity).toString()]));
      expect(def.map((r) => String(r["warehouse_code"]))).toEqual(["WH-TR"]);
      // Without the clause the dataset answers the zero row too — the gap the parameter closes.
      const unfiltered = await runDefinition(tx, readDefinition(SOH), params);
      expect(unfiltered.map((r) => String(r["warehouse_code"])).toSorted()).toEqual([
        "WH-HQ",
        "WH-TR",
      ]);
      await assertTieOut(tx, readDefinition(SOH), {
        params: { ...params, hideQuantity: "0" },
        baseCurrency: MYR,
      });
    });
  });

  it("hideQuantity is REQUIRED and offers exactly 0: 3D's `quantity <> 0`, named by every run", () => {
    const p = readDefinition(SOH).parameters.find((x) => x.name === "hideQuantity");
    expect(p).toEqual({ name: "hideQuantity", kind: "enum", required: true, options: ["0"] });
    expect(readDefinition(SOH).dataset.filters).toContainEqual({
      field: "quantity",
      op: "ne",
      param: "hideQuantity",
    });
  });

  it("PARITY: inventory.valuation's snapshot rows equal valuationAsOf, warehouse for warehouse", async () => {
    await read(async (tx) => {
      const fn = await valuationAsOf(tx, {
        companyId: f.s.company,
        asOf: AS_OF,
        itemId: inv().itemId,
        limit: 50,
      });
      const def = await runDefinition(tx, readDefinition(VALUATION), valuationParams());
      expect(def.map((r) => String(r["warehouse_code"]))).toEqual(fn.map((r) => r.warehouseCode));
      const byWarehouse = new Map(def.map((r) => [String(r["warehouse_code"]), r]));
      for (const row of fn) {
        const got = byWarehouse.get(row.warehouseCode);
        expect(got, `the snapshot is missing ${row.warehouseCode}`).toBeDefined();
        expect(Money.of(String(got!["value"]), MYR).toString()).toBe(
          Money.of(row.value, MYR).toString(),
        );
        expect(Quantity.of(String(got!["quantity"])).toString()).toBe(
          Quantity.of(row.quantity).toString(),
        );
      }
      expect(fn.map((r) => [r.warehouseCode, r.value])).toEqual([
        ["WH-HQ", "150.0000"],
        ["WH-TR", "20.0000"],
      ]);
      // No unit-cost comparison: the `stock_valuation` dataset has no `unit_cost` column (A3), and a
      // per-warehouse unit cost is `value / quantity`, a division whose one home is 3B's engine (LEGACY-009).
      await assertTieOut(tx, readDefinition(VALUATION), {
        params: valuationParams(),
        baseCurrency: MYR,
        asOf: AS_OF,
      });
    });
  });

  it("an as-of with no snapshot answers no rows — the report reads the snapshot, it never values on read", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(VALUATION), {
        ...valuationParams(),
        asOf: "2026-01-30",
      });
      expect(rows).toEqual([]);
    });
  });

  it("PARITY: sales_by_item's per-period definition equals salesByItem over that period's own dates (A14)", async () => {
    await read(async (tx) => {
      const [period] = await tx<{ starts_on: string; ends_on: string }[]>`
        select starts_on::text, ends_on::text from app.fiscal_period where id = ${f.s.period}`;
      const fn = await salesByItem(tx, {
        companyId: f.s.company,
        fromDate: period!.starts_on,
        toDate: period!.ends_on,
        limit: 100,
      });
      const def = await runDefinition(tx, readDefinition(SALES), {
        companyId: f.s.company,
        fiscalPeriodId: f.s.period,
        itemId: null,
      });
      expect(def.length).toBe(fn.length);
      expect(def.length).toBe(1);
      // LEFT: the `item_profitability` dataset's snake_case aliases (A3). RIGHT: 3D's/4A's `SalesByItemRow`
      // camelCase members. The two vocabularies meet in these lines and nowhere else in the file.
      expect(String(def[0]!["item_code"])).toBe(fn[0]!.itemCode);
      expect(Quantity.of(String(def[0]!["quantity_sold"])).toString()).toBe(
        Quantity.of(fn[0]!.deliveredQuantity).toString(),
      );
      expect(Money.of(String(def[0]!["cogs_base"]), MYR).toString()).toBe(
        Money.of(fn[0]!.cost, MYR).toString(),
      );
      expect(Money.of(String(def[0]!["revenue_base"]), MYR).toString()).toBe(
        Money.of(fn[0]!.revenue, MYR).toString(),
      );
      expect(Money.of(String(def[0]!["margin_base"]), MYR).toString()).toBe(
        Money.of(fn[0]!.margin, MYR).toString(),
      );
      // The figures, so a reader can check them by hand: 6 delivered, 30.0000 cost, 66 − 11 = 55.0000
      // revenue, 25.0000 margin.
      expect([fn[0]!.deliveredQuantity, fn[0]!.cost, fn[0]!.revenue, fn[0]!.margin]).toEqual([
        "6.000000",
        "30.0000",
        "55.0000",
        "25.0000",
      ]);
      await assertTieOut(tx, readDefinition(SALES), {
        params: { companyId: f.s.company, fiscalPeriodId: f.s.period, itemId: null },
        baseCurrency: MYR,
      });
    });
  });

  it("inventory.valuation is gated inventory.cost.read and stock_on_hand is not — the cost/quantity split", () => {
    expect(readDefinition(VALUATION).permission).toBe("inventory.cost.read");
    expect(readDefinition(SOH).permission).toBe("inventory.stock.read");
    // spec:2159's clerk reads stock and not costs; a valuation gated `inventory.stock.read` would hand every
    // cost to that role through the report catalogue.
    const fields = readDefinition(SOH).columns.map((c) => c.field);
    expect(fields).not.toContain("value");
    expect(fields).not.toContain("unit_cost");
  });

  it("all three render in English and Arabic", async () => {
    await read(async (tx) => {
      const runs: [string, Record<string, string | null>][] = [
        [SOH, sohParams("stock,in_transit")],
        [VALUATION, valuationParams()],
        [SALES, { companyId: f.s.company, fiscalPeriodId: f.s.period, itemId: null }],
      ];
      for (const [code, params] of runs) {
        const rows = await runDefinition(tx, readDefinition(code), params);
        expect(rows.length, code).toBeGreaterThan(0);
        for (const lang of ["en", "ar"] as const) {
          const r = renderReport(readDefinition(code), rows, {
            format: "csv",
            lang,
            formatters: intlFormatters(lang, { currency: "MYR" }),
            generatedAt: "2026-11-05T00:00:00Z",
          });
          expect(r.rowCount, `${code} ${lang}`).toBe(rows.length);
          expect(r.dir).toBe(lang === "ar" ? "rtl" : "ltr");
        }
      }
    });
  });
});

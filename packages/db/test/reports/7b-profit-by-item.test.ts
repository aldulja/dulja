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
import { valuationAsOf } from "../../src/costing/valuation";
import {
  itemProfitabilityRows,
  rebuildItemProfitability,
} from "../../src/projections/item-profitability";
import { reportDefinitionSets } from "../../src/reports/definition-store";
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

/**
 * 7B Task 7 — `inventory.profit_by_item` reads 4B's `item_profitability` projection and recomputes nothing
 * (§4.16.1, amendment A14), and test 7's revenue-bearing re-run.
 *
 * The fixture's arithmetic (`{ inventory: true, sales: true }`): 6 delivered out of a 40-unit layer at 5.0000
 * and invoiced at 11.0000, 1 credited back. 4B's attribution gives quantity_sold 6.000000 (the delivery's
 * issue; the financial-only credit note moves no stock), revenue 66.0000 − 11.0000 = 55.0000, cost 30.0000
 * (the delivery's consumptions) and margin 25.0000 — every one of them the projection's, never this report's.
 */
const MYR = currency("MYR");
const PROFIT = "inventory.profit_by_item";
const AGEING = "inventory.stock_ageing";
const AS_OF = "2026-01-31";

describe("7B inventory.profit_by_item over item_profitability (§4.16.1, test 7 re-run)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true, sales: true });
    // The projection is asynchronous (spec:1204). Its rebuild is 4B's function, run as the tenant's system
    // principal exactly as the pg-boss handler runs it (hazard 20) — this slice writes no projection row.
    await withTenant(db.rw, f.s.tenant, f.s.system, (tx) =>
      rebuildItemProfitability(tx, { companyId: f.s.company }),
    );
  }, 240_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const params = () => ({ companyId: f.s.company, fiscalPeriodId: f.s.period, itemId: null });

  it("validates, is gated inventory.cost.read, and reads the projection — not the ledger, not the layers", async () => {
    const d = readDefinition(PROFIT);
    const result = validateReportDefinition(d, await reportDefinitionSets(db.admin));
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(readEnvelope(PROFIT).definitionVersion).toBe(1);
    expect(d.module).toBe("inventory");
    expect(d.permission).toBe("inventory.cost.read");
    expect(d.dataset.source).toBe("item_profitability");
    expect(d.tieOut).toEqual({ kind: "projection", projection: "item_profitability" });
    // A14: the per-fiscal-period view, `fiscalPeriodId` OPTIONAL, grouped by the period's code.
    expect(d.parameters.map((p) => [p.name, p.required])).toEqual([
      ["fiscalPeriodId", false],
      ["itemId", false],
    ]);
    expect(d.groups.map((g) => g.field)).toEqual(["fiscal_period_code"]);
  });

  it("every figure in the report is the projection's, to the cent", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PROFIT), { params: params(), baseCurrency: MYR });
      const stored = await itemProfitabilityRows(tx, { companyId: f.s.company });
      expect(stored.length).toBe(1);
      expect(Quantity.of(stored[0]!.quantitySold).toString()).toBe("6.000000");
      expect(Money.of(stored[0]!.revenueBase, MYR).toString()).toBe("55.0000");
      expect(Money.of(stored[0]!.cogsBase, MYR).toString()).toBe("30.0000");
      expect(Money.of(stored[0]!.marginBase, MYR).toString()).toBe("25.0000");
    });
  });

  it("without a period the report is every period's rows, and still ties to the whole projection", async () => {
    await read(async (tx) => {
      const all = { companyId: f.s.company, fiscalPeriodId: null, itemId: null };
      await assertTieOut(tx, readDefinition(PROFIT), { params: all, baseCurrency: MYR });
      const rows = await runDefinition(tx, readDefinition(PROFIT), all);
      expect(rows.map((r) => String(r["fiscal_period_code"]))).toEqual(["2026-01"]);
    });
  });

  it("the report's own columns carry those four figures, and no margin percentage", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PROFIT), params());
      expect(rows.length).toBe(1);
      expect(Money.of(String(rows[0]!["margin_base"]), MYR).toString()).toBe("25.0000");
      const d = readDefinition(PROFIT);
      const formats = new Map(d.columns.map((c) => [c.field, c.format]));
      expect(formats.get("revenue_base")).toBe("money");
      expect(formats.get("cogs_base")).toBe("money");
      expect(formats.get("margin_base")).toBe("money");
      expect(formats.get("quantity_sold")).toBe("quantity");
      // `YYYY-MM` is not a calendar date, so the period renders as text.
      expect(formats.get("fiscal_period_code")).toBe("text");
      // A percentage of a Money is a derived number with a rounding policy and no source field on the
      // projection; the core definition states only figures the projection stores (spec:2041).
      expect(d.columns.map((c) => c.field)).not.toContain("margin_percent");
    });
  });

  it("TEST 7's REVENUE-BEARING RE-RUN: valuation plus recognised cost equals every layer ever created", async () => {
    // spec:2425: "Stock valuation and profit reports tie to the cent". 3D owns the whole scenario and its file
    // is re-run unchanged. What this slice adds is the revenue-bearing half over the two reports that now read
    // the same stored facts: the item's layers created (the 1300 debits) equal what is still on hand (stock
    // ageing over BOTH warehouses, the in-transit one included, valued by valuationAsOf) plus what has been
    // recognised as cost (profit by item). Three readers, one identity, no recomputation anywhere.
    await read(async (tx) => {
      const itemId = f.inventory!.itemId;
      const ageing = await runDefinition(tx, readDefinition(AGEING), {
        companyId: f.s.company,
        itemId,
        warehouseId: null,
      });
      const valuation = await valuationAsOf(tx, {
        companyId: f.s.company,
        asOf: AS_OF,
        itemId,
        limit: 50,
      });
      const onHandValue = valuation.reduce(
        (a, v) => a.add(Money.of(v.value, MYR)),
        Money.zero(MYR),
      );
      expect(new Set(ageing.map((r) => String(r["warehouse_code"])))).toEqual(
        new Set(valuation.map((v) => v.warehouseCode)),
      );
      const profit = await runDefinition(tx, readDefinition(PROFIT), params());
      const recognisedCost = profit.reduce(
        (a, r) => a.add(Money.of(String(r["cogs_base"]), MYR)),
        Money.zero(MYR),
      );
      const [ledger] = await tx<{ total: string }[]>`
        select coalesce(sum(le.base_debit), 0)::numeric(19,4)::text as total
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${f.s.company} and a.code = '1300'`;
      expect(onHandValue.toString()).toBe("170.0000");
      expect(recognisedCost.toString()).toBe("30.0000");
      expect(ledger!.total).toBe("200.0000");
      expect(onHandValue.add(recognisedCost).toString()).toBe(
        Money.of(ledger!.total, MYR).toString(),
      );
      // The ageing report's own tie-out is what binds it to that valuation, so the identity above is a
      // statement about three READERS of one set of stored facts, not about three computations.
      await assertTieOut(tx, readDefinition(AGEING), {
        params: { companyId: f.s.company, itemId, warehouseId: null },
        baseCurrency: MYR,
        asOf: AS_OF,
      });
    });
  });

  it("a period with no sales reports no row rather than a zero row", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PROFIT), {
        companyId: f.s.company,
        fiscalPeriodId: f.s.lockedPeriod,
        itemId: null,
      });
      expect(rows).toEqual([]);
    });
  });

  it("renders in English and Arabic, and the margin total is the projection's", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PROFIT), params());
      for (const lang of ["en", "ar"] as const) {
        const r = renderReport(readDefinition(PROFIT), rows, {
          format: "csv",
          lang,
          formatters: intlFormatters(lang, { currency: "MYR" }),
          generatedAt: "2026-11-05T00:00:00Z",
        });
        expect(r.rowCount).toBe(1);
        expect(r.dir).toBe(lang === "ar" ? "rtl" : "ltr");
        const total = r.rows
          .filter((row) => row.kind === "total")
          .at(-1)!
          .cells.find((c) => c.field === "margin_base")!.raw;
        expect(Money.of(String(total), MYR).toString()).toBe("25.0000");
      }
    });
  });
});

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
import { openLayersOf, valuationAsOf } from "../../src/costing/valuation";
import { reportDefinitionSets } from "../../src/reports/definition-store";
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

/**
 * 7B Task 5 — stock ageing over the layers (SAH-055: read, never recomputed), the movement register and the
 * expiry list (§4.16.1).
 *
 * The fixture (`reportFixture(…, { inventory: true })`): 40 received at 5.0000 into WH-HQ on 2026-01-06, 6
 * delivered on 2026-01-14, 4 dispatched on 2026-01-16 towards WH-BR2 through branch two's corridor WH-TR and
 * not received. So two open layers — 30 remaining at WH-HQ and 4 at WH-TR — valued 150.0000 and 20.0000.
 */
const MYR = currency("MYR");
const AGEING = "inventory.stock_ageing";
const MOVEMENTS = "inventory.movement_register";
const EXPIRY = "inventory.expiry_list";
/** The TIE-OUT's as-of, not the report's: `inventory.stock_ageing` declares no `asOf` parameter (A13), and
 *  this value reaches `valuationAsOf` through `TieOutOptions.asOf` alone. */
const AS_OF = "2026-01-31";

describe("7B stock ageing, movement register and expiry list (§4.16.1, SAH-055)", () => {
  let db: Db;
  let f: ReportFixture;

  beforeAll(async () => {
    db = await startDb();
    f = await reportFixture(db, "Alpha", { inventory: true });
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
  const ageingParams = () => ({
    companyId: f.s.company,
    itemId: inv().itemId,
    warehouseId: null,
  });
  const movementParams = () => ({
    companyId: f.s.company,
    fromDate: "2020-01-01",
    toDate: "2030-12-31",
    itemId: null,
    warehouseId: null,
    documentTypeCode: null,
  });

  it("all three validate at definitionVersion 1 and carry the permissions §4.16.1 assigns them", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of [AGEING, MOVEMENTS, EXPIRY]) {
      const result = validateReportDefinition(readDefinition(code), sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(readEnvelope(code).definitionVersion).toBe(1);
      expect(readDefinition(code).module).toBe("inventory");
    }
    expect(readDefinition(AGEING).permission).toBe("inventory.cost.read");
    expect(readDefinition(MOVEMENTS).permission).toBe("inventory.stock.read");
    expect(readDefinition(EXPIRY).permission).toBe("inventory.stock.read");
  });

  it("inventory.stock_ageing requires itemId, declares NO asOf, and reads cost_layer (amendment A13)", () => {
    const d = readDefinition(AGEING);
    expect(d.dataset.source).toBe("cost_layer");
    expect(d.parameters.filter((p) => p.required).map((p) => p.name)).toEqual(["itemId"]);
    // 7A computes `age_days` from `current_date` and the dataset takes no as-of of any kind, so a definition
    // offering one would be a parameter that silently does nothing (A13). The tie-out's own as-of is
    // `TieOutOptions.asOf`, which is the harness's and never the report's.
    expect(d.parameters.map((p) => p.name)).toEqual(["itemId", "warehouseId"]);
    expect(d.tieOut).toEqual({ kind: "projection", projection: "stock_valuation" });
    // The layer's money is the harness's per-layer residue (A5), never a column of the report: `value` on this
    // dataset is the RECEIPT value at qty_in (migration 0118), and rendering it would mislabel the residue.
    expect(d.columns.map((c) => c.field)).not.toContain("value");
    expect(d.columns.map((c) => c.field)).not.toContain("age_bucket");
  });

  it("SAH-055: the ageing rows ARE the layers — every row's residue is a layer's qty_remaining", async () => {
    await read(async (tx) => {
      // LEFT of every comparison is a `DatasetRow`'s snake_case alias (A3); RIGHT is 3B's camelCase
      // `CostLayerRow` member. `openLayersOf` takes an `asOf`; the REPORT does not.
      const layers = await openLayersOf(tx, {
        companyId: f.s.company,
        itemId: inv().itemId,
        asOf: AS_OF,
        limit: 100,
      });
      const rows = await runDefinition(tx, readDefinition(AGEING), ageingParams());
      expect(rows.map((r) => String(r["layer_id"])).toSorted()).toEqual(
        layers.map((l) => l.layerId).toSorted(),
      );
      const byLayer = new Map(layers.map((l) => [l.layerId, l]));
      for (const r of rows) {
        const layer = byLayer.get(String(r["layer_id"]))!;
        expect(Quantity.of(String(r["qty_remaining"])).toString()).toBe(
          Quantity.of(layer.qtyRemaining).toString(),
        );
        expect(Money.of(String(r["unit_cost"]), MYR).toString()).toBe(
          Money.of(layer.unitCost, MYR).toString(),
        );
        expect(String(r["warehouse_id"])).toBe(layer.warehouseId);
      }
      // The fixture's two layers: 30 remaining at WH-HQ and 4 at WH-TR, both at 5.0000.
      expect(rows.length).toBe(2);
      expect(
        rows.map((r) => [
          String(r["warehouse_code"]),
          Quantity.of(String(r["qty_remaining"])).toString(),
        ]),
      ).toEqual([
        ["WH-HQ", "30.000000"],
        ["WH-TR", "4.000000"],
      ]);
    });
  });

  it("inventory.stock_ageing ties to valuationAsOf per warehouse, the figure stock_valuation stores", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(AGEING), {
        params: ageingParams(),
        baseCurrency: MYR,
        asOf: AS_OF,
      });
      const valuation = await valuationAsOf(tx, {
        companyId: f.s.company,
        asOf: AS_OF,
        itemId: inv().itemId,
        limit: 50,
      });
      expect(valuation.map((v) => [v.warehouseCode, v.value])).toEqual([
        ["WH-HQ", "150.0000"],
        ["WH-TR", "20.0000"],
      ]);
    });
  });

  it("a stock_valuation tie-out refuses a run without itemId (A13: per item, never the whole catalogue)", async () => {
    await read(async (tx) => {
      await expect(
        assertTieOut(tx, readDefinition(AGEING), {
          params: { companyId: f.s.company, itemId: null, warehouseId: null },
          baseCurrency: MYR,
          asOf: AS_OF,
        }),
      ).rejects.toThrow(/needs the itemId parameter/);
    });
  });

  it("every layer's age is its OWN effective_at in days, and there is no bucket column (A3)", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(AGEING), ageingParams());
      for (const r of rows) {
        expect(
          Number.isInteger(r["age_days"]),
          `age_days is an int: ${String(r["age_days"])}`,
        ).toBe(true);
        expect(Number(r["age_days"])).toBeGreaterThanOrEqual(0);
      }
      // Received 2026-01-06 into WH-HQ, dispatched to transit 2026-01-16 — two DIFFERENT layer dates, so the
      // corridor layer is strictly the younger. `age_days` runs from `current_date`, which moves, so the
      // assertion is on the ORDER and the DIFFERENCE, never on an absolute day count.
      const byWarehouse = new Map(
        rows.map((r) => [String(r["warehouse_code"]), Number(r["age_days"])]),
      );
      expect(byWarehouse.get("WH-HQ")! - byWarehouse.get("WH-TR")!).toBe(10);
      expect(rows.map((r) => String(r["effective_at"]))).toEqual(["2026-01-06", "2026-01-16"]);
    });
  });

  it("the warehouseId parameter narrows the ageing to one warehouse's layers", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(AGEING), {
        ...ageingParams(),
        warehouseId: inv().whTransit,
      });
      expect(rows.map((r) => String(r["warehouse_code"]))).toEqual(["WH-TR"]);
    });
  });

  it("inventory.movement_register ties to stock_on_hand once the range covers every movement", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(MOVEMENTS), {
        params: movementParams(),
        baseCurrency: MYR,
      });
      const rows = await runDefinition(tx, readDefinition(MOVEMENTS), movementParams());
      // receipt 40 in, delivery 6 out, transfer 4 out of WH-HQ and 4 into WH-TR — four movements, and the
      // transfer's TWO are why `movement_no` exists (§4.7.3).
      expect(rows.length).toBe(4);
      expect(rows.map((r) => String(r["document_type_code"]))).toEqual([
        "GOODS_RECEIPT",
        "DELIVERY_ORDER",
        "TRANSFER",
        "TRANSFER",
      ]);
      const soh = await stockOnHand(tx, {
        companyId: f.s.company,
        includeInTransit: true,
        limit: 50,
      });
      expect(soh.map((r) => [r.warehouseCode, r.quantity])).toEqual([
        ["WH-HQ", "30.000000"],
        ["WH-TR", "4.000000"],
      ]);
    });
  });

  it("the movement register's documentTypeCode narrows it, and the value column is the movement's own", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(MOVEMENTS), {
        ...movementParams(),
        documentTypeCode: "TRANSFER",
      });
      expect(
        rows.map((r) => [
          String(r["warehouse_code"]),
          Quantity.of(String(r["quantity"])).toString(),
        ]),
      ).toEqual([
        ["WH-HQ", "-4.000000"],
        ["WH-TR", "4.000000"],
      ]);
      // The transfer moves value between warehouses and creates none: its two legs net to zero.
      const net = rows.reduce((a, r) => a.add(Money.of(String(r["value"]), MYR)), Money.zero(MYR));
      expect(net.toString()).toBe("0.0000");
    });
  });

  it("inventory.expiry_list is a lot list with a row witness — the `lot` dataset carries no quantity (A3)", async () => {
    await read(async (tx) => {
      // `tieOut.kind` is `none`, so the harness REQUIRES a row witness (A5). The witness is `app.lot` itself,
      // keyed on the dataset's own aliases — the lot's code is `code`, not `lot_code`, so a witness naming
      // `lot_code` would project every row to "||" and pass for the wrong reason.
      await assertTieOut(tx, readDefinition(EXPIRY), {
        params: { companyId: f.s.company, beforeDate: "2026-12-31", itemId: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "item_code", "expires_on"],
          rows: (t) => t<{ code: string; item_code: string; expires_on: string }[]>`
            select l.code, i.code as item_code, l.expires_on::text as expires_on
              from app.lot l join app.item i on i.id = l.item_id
             where l.company_id = ${f.s.company}
               and l.expires_on is not null and l.expires_on <= date '2026-12-31'`,
        },
      });
      const rows = await runDefinition(tx, readDefinition(EXPIRY), {
        companyId: f.s.company,
        beforeDate: "2026-12-31",
        itemId: null,
      });
      // The item's sentinel lot carries no expiry, so the `expires_on lte` filter excludes it.
      expect(rows.map((r) => String(r["code"]))).toEqual(["LOT-A"]);
      // `days_to_expiry` is measured from the database's `current_date` — read the same clock, never the host's.
      const [clock] = await tx<
        { days: number }[]
      >`select (date '2026-06-30' - current_date)::int as days`;
      expect(rows[0]!["days_to_expiry"]).toBe(clock!.days);
      // No quantity here, deliberately: `inventory.stock_on_hand` reports quantity with `expires_on`, and a
      // second differently-derived quantity on the lot list is the two-spellings failure §4.16.1 prevents.
      const fields = readDefinition(EXPIRY).columns.map((c) => c.field);
      expect(fields).not.toContain("quantity");
      expect(fields).not.toContain("quantity_on_hand");
    });
  });

  it("a lot whose expiry is beyond the parameter is not reported (the filter is the report's whole job)", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(EXPIRY), {
        companyId: f.s.company,
        beforeDate: "2026-01-01",
        itemId: null,
      });
      expect(rows).toEqual([]);
    });
  });

  it("all three render in English and Arabic — dates, integers, quantities and the unit cost", async () => {
    await read(async (tx) => {
      const runs: [string, Record<string, string | null>][] = [
        [AGEING, ageingParams()],
        [MOVEMENTS, movementParams()],
        [EXPIRY, { companyId: f.s.company, beforeDate: "2026-12-31", itemId: null }],
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
      const total = renderReport(
        readDefinition(AGEING),
        await runDefinition(tx, readDefinition(AGEING), ageingParams()),
        { format: "csv", lang: "en", formatters: intlFormatters("en", { currency: "MYR" }) },
      )
        .rows.filter((row) => row.kind === "total")
        .at(-1)!
        .cells.find((c) => c.field === "qty_remaining")!.raw;
      expect(Quantity.of(String(total)).toString()).toBe("34.000000");
    });
  });
});

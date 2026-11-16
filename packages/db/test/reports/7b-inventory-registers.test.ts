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
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { startDb, withTenant, type Db } from "../harness";
// §4.17.1's 7B harness, reachable from packages/db/test/** through 3B's amendment A21(c).
import { packApproval } from "../../../../tests/invariants/support/ar-ap";
import {
  assertTieOut,
  readDefinition,
  readEnvelope,
  reportFixture,
  runDefinition,
  type ReportFixture,
} from "../../../../tests/invariants/support/reports";

/**
 * 7B Task 6 — the four catalogue and adjustment registers (§4.16.1): two master-data lists tied by a row
 * witness, the transfer register tied to the in-transit warehouse's on-hand, and the count register tied to
 * the ledger's own debits for its own documents.
 *
 * Neither master-data list carries a date window. `price_list.valid_from` / `valid_to` and
 * `promotion.starts_at` / `ends_at` are NULLABLE ("always valid"), §4.11.1's filter grammar has no null-aware
 * operator, and every comparison drops a NULL row — so an `onDate lte` clause would hide exactly the lists and
 * offers that are valid every day. The window is rendered instead, and a null-aware operator is a raise
 * against 7A's grammar (the same one the stock ageing's `invalidated_at` needs).
 */
const MYR = currency("MYR");
const PRICES = "inventory.price_list";
const PROMOS = "inventory.promotion_register";
const TRANSFERS = "inventory.transfer_register";
const COUNTS = "inventory.count_register";

describe("7B price list, promotions, transfer register, count register (§4.16.1)", () => {
  let db: Db;
  let f: ReportFixture;
  const catalogue = () => {
    if (f.catalogue === null) throw new Error("the fixture was built without { catalogue: true }");
    return f.catalogue;
  };

  beforeAll(async () => {
    db = await startDb();
    // `{ catalogue: true }` is Task 1's: the price list, the promotion and one posted STOCK_COUNT, in the one
    // place that posts a count (hazard 9 — Task 11's roll-up needs the same three rows).
    f = await reportFixture(db, "Alpha", { inventory: true, catalogue: true });
    expect(packApproval("STOCK_COUNT").required, "the fixture's count needs the approval hop").toBe(
      true,
    );
  }, 240_000);
  afterAll(async () => {
    await db?.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    withTenant(db.rw, f.s.tenant, f.reader, fn);
  const transferParams = () => ({
    companyId: f.s.company,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    transferTypes: "TRANSFER,TRANSFER_RECEIPT",
    itemId: null,
    warehouseId: null,
  });
  const countParams = () => ({
    companyId: f.s.company,
    fromDate: "2026-01-01",
    toDate: "2026-01-31",
    countTypes: "STOCK_COUNT",
    branchId: null,
    status: "posted",
  });

  it("all four validate at definitionVersion 1; the two master-data lists are gated inventory.item.read", async () => {
    const sets = await reportDefinitionSets(db.admin);
    for (const code of [PRICES, PROMOS, TRANSFERS, COUNTS]) {
      const result = validateReportDefinition(readDefinition(code), sets);
      expect(result.errors, `${code}: ${JSON.stringify(result.errors)}`).toEqual([]);
      expect(readEnvelope(code).definitionVersion).toBe(1);
      expect(readDefinition(code).module).toBe("inventory");
    }
    expect(readDefinition(PRICES).permission).toBe("inventory.item.read");
    expect(readDefinition(PROMOS).permission).toBe("inventory.item.read");
    expect(readDefinition(TRANSFERS).permission).toBe("inventory.stock.read");
    expect(readDefinition(COUNTS).permission).toBe("inventory.stock.read");
  });

  it("the type restriction of each register is a REQUIRED parameter — never optional, so never absent", () => {
    // §4.11.1's filter clauses always name a parameter, so a definition cannot carry a constant restriction. An
    // optional type parameter left empty would turn the transfer register into the movement register and the
    // count register into the document register under another code; required, the runs route refuses that.
    const transferTypes = readDefinition(TRANSFERS).parameters.find(
      (p) => p.name === "transferTypes",
    );
    // `text`, not `enum`: the runs route checks an enum value against `options` WHOLE, and the clause is an
    // `in` over a comma-separated list, so "TRANSFER,TRANSFER_RECEIPT" would be refused as an enum.
    expect(transferTypes).toEqual({ name: "transferTypes", kind: "text", required: true });
    const countTypes = readDefinition(COUNTS).parameters.find((p) => p.name === "countTypes");
    expect(countTypes).toEqual({
      name: "countTypes",
      kind: "enum",
      required: true,
      options: ["STOCK_COUNT"],
    });
  });

  it("inventory.price_list's witness is app.price_list_line itself, row for row", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PRICES), {
        params: { companyId: f.s.company, priceListId: catalogue().priceListId, itemId: null },
        baseCurrency: MYR,
        // The witness columns are aliased to the DATASET's snake_case fields (A3): `assertTieOut` projects one
        // key list over both sides.
        witness: {
          key: ["price_list_code", "item_code", "min_quantity", "unit_price"],
          rows: (t) => t<
            {
              price_list_code: string;
              item_code: string;
              min_quantity: string;
              unit_price: string;
            }[]
          >`
            select pl.code as price_list_code, i.code as item_code,
                   l.min_quantity::text as min_quantity, l.unit_price::text as unit_price
              from app.price_list_line l
              join app.price_list pl on pl.id = l.price_list_id
              join app.item i on i.id = l.item_id
             where pl.company_id = ${f.s.company}`,
        },
      });
      const rows = await runDefinition(tx, readDefinition(PRICES), {
        companyId: f.s.company,
        priceListId: catalogue().priceListId,
        itemId: null,
      });
      expect(
        rows.map((r) => [
          String(r["item_code"]),
          Money.of(String(r["unit_price"]), MYR).toString(),
        ]),
      ).toEqual([["ITEM-1", "11.0000"]]);
    });
  });

  it("a null-bounded price list is reported — the validity window is rendered, never filtered", async () => {
    await read(async (tx) => {
      const rows = await runDefinition(tx, readDefinition(PRICES), {
        companyId: f.s.company,
        priceListId: null,
        itemId: f.inventory!.itemId,
      });
      // `seedPriceList` leaves valid_from / valid_to null, which means "always valid".
      expect(rows.length).toBe(1);
      expect(rows[0]!["valid_from"]).toBeNull();
      expect(rows[0]!["valid_to"]).toBeNull();
      const fields = readDefinition(PRICES).columns.map((c) => c.field);
      expect(fields).toContain("valid_from");
      expect(fields).toContain("valid_to");
      // A replaced line is archived, never deleted (3A's replacePriceListLines), and the grammar cannot
      // exclude it — so the stamp is a column a reader sees.
      expect(fields).toContain("archived_at");
      expect(readDefinition(PRICES).dataset.filters.map((c) => c.field)).not.toContain(
        "valid_from",
      );
    });
  });

  it("inventory.promotion_register's witness is app.promotion, and the rule body is not a column", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(PROMOS), {
        params: { companyId: f.s.company, kind: null },
        baseCurrency: MYR,
        witness: {
          key: ["code", "kind", "starts_at", "ends_at"],
          rows: (t) => t<{ code: string; kind: string; starts_at: string; ends_at: string }[]>`
            select code, kind,
                   to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at,
                   to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ends_at
              from app.promotion where company_id = ${f.s.company}`,
        },
      });
      const other = await runDefinition(tx, readDefinition(PROMOS), {
        companyId: f.s.company,
        kind: "bundle",
      });
      expect(other).toEqual([]);
    });
    const fields = readDefinition(PROMOS).columns.map((c) => c.field);
    expect(fields).not.toContain("definition");
    // The window is an instant pair, rendered as the stored UTC text: 7A's `date` format reads a calendar date.
    const formats = new Map(readDefinition(PROMOS).columns.map((c) => [c.field, c.format]));
    expect(formats.get("starts_at")).toBe("text");
    expect(formats.get("ends_at")).toBe("text");
  });

  it("inventory.transfer_register ties to the in-transit warehouse's on-hand — 3D's DoD clause", async () => {
    const inv = f.inventory!;
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(TRANSFERS), {
        params: transferParams(),
        baseCurrency: MYR,
        projectionKeys: [`${inv.itemId}|${inv.whTransit}|${inv.lotId}`],
      });
      const rows = await runDefinition(tx, readDefinition(TRANSFERS), transferParams());
      // Two movements from one transfer line: −4 out of WH-HQ, +4 into WH-TR (§4.7.3's movement_no).
      expect(rows.length).toBe(2);
      const byWarehouse = new Map(
        rows.map((r) => [
          String(r["warehouse_code"]),
          Quantity.of(String(r["quantity"])).toString(),
        ]),
      );
      expect(byWarehouse.get("WH-HQ")).toBe("-4.000000");
      expect(byWarehouse.get("WH-TR")).toBe("4.000000");
      expect(
        rows.every((r) =>
          ["TRANSFER", "TRANSFER_RECEIPT"].includes(String(r["document_type_code"])),
        ),
      ).toBe(true);
    });
  });

  it("projectionKeys cannot quietly compare nothing: a key the projection does not hold is refused", async () => {
    const inv = f.inventory!;
    await read(async (tx) => {
      await expect(
        assertTieOut(tx, readDefinition(TRANSFERS), {
          params: transferParams(),
          baseCurrency: MYR,
          projectionKeys: [`${inv.itemId}|${inv.whBranch}|${inv.lotId}`],
        }),
      ).rejects.toThrow(/projectionKeys names .* which stock_on_hand does not hold/);
      // And WH-HQ is NOT a key the register is complete for: its on-hand (29 after the count) is not −4.
      await expect(
        assertTieOut(tx, readDefinition(TRANSFERS), {
          params: transferParams(),
          baseCurrency: MYR,
          projectionKeys: [`${inv.itemId}|${inv.whHq}|${inv.lotId}`],
        }),
      ).rejects.toThrow(/stock_on_hand says 29\.000000/);
    });
  });

  it("inventory.count_register's amount total equals the ledger's own debits for its documents", async () => {
    await read(async (tx) => {
      await assertTieOut(tx, readDefinition(COUNTS), {
        params: countParams(),
        baseCurrency: MYR,
        window: {
          fromDate: "2026-01-01",
          toDate: "2026-01-31",
          documentTypeCodes: ["STOCK_COUNT"],
        },
      });
      const rows = await runDefinition(tx, readDefinition(COUNTS), countParams());
      expect(rows.map((r) => String(r["document_id"]))).toEqual([catalogue().countDocumentId]);
      expect(Money.of(String(rows[0]!["base_total"]), MYR).toString()).toBe("5.0000");
    });
  });

  it("the shortage landed on 5110, which is the accounting claim the arithmetic tie cannot make", async () => {
    await read(async (tx) => {
      const legs = await tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, le.base_debit::text as debit, le.base_credit::text as credit
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${catalogue().countDocumentId} order by a.code`;
      expect(legs).toEqual([
        { code: "1300", debit: "0.0000", credit: "5.0000" },
        { code: "5110", debit: "5.0000", credit: "0.0000" },
      ]);
    });
  });

  it("all four render in English and Arabic", async () => {
    await read(async (tx) => {
      const runs: [string, Record<string, string | null>][] = [
        [PRICES, { companyId: f.s.company, priceListId: catalogue().priceListId, itemId: null }],
        [PROMOS, { companyId: f.s.company, kind: null }],
        [TRANSFERS, transferParams()],
        [COUNTS, countParams()],
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

import { describe, expect, it } from "vitest";
import { costingEngine, currency } from "@dulja/domain";
import {
  accountLoader,
  assertAccountMap,
  clearAccountMap,
  moneyOf,
  setAccountMap,
} from "@dulja/importer";
import { costingContext } from "./support/costing";

const ctx = costingContext("007"); // ← this file's own SAH number

describe("SAH-007 Value-less movements NULL-poison a material's cost — 3B", () => {
  // first proven by spec:264, spec:1226
  it("a receipt with no value is refused by the engine, and value is NOT NULL on the table", () => {
    expect(() => costingEngine.cost(ctx.valuelessReceipt())).toThrow(/ERR_COST_VALUE_MISSING/);
  });
  it("value is NOT NULL in the database, so no path can store one", async () => {
    const { db } = await ctx.inventory();
    const [col] = await db.admin<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'inventory_movement' and column_name = 'value'`;
    expect(col!.is_nullable).toBe("NO");
  });
});

describe("SAH-007 NULL-poisoned balances read as zero — 9B", () => {
  const MYR = currency("MYR");

  it("moneyOf refuses a NULL legacy amount instead of returning zero", () => {
    expect(() => moneyOf({ AMT: null }, "AMT", MYR, "ACCTOTALS/1")).toThrow(
      /ERR_VALIDATION_FAILED: ACCTOTALS\/1: AMT is NULL; a NULL legacy amount is never read as zero \(SAH-007, SAH-011\)/,
    );
    expect(moneyOf({ AMT: "0.0000" }, "AMT", MYR, "ACCTOTALS/1").toString()).toBe("0.0000");
  });

  // 2026-11-15 review, HRP-21: the account loader reads no amount, so a NULL stored ACCOPENBAL no longer stops the link
  // (which sent that account's real AccTotals balance to 3900); the NULL guard is moneyOf's, on the amounts the
  // trial-balance opening does read (the case above).
  it("the account loader links a legacy account whose unused stored balance is NULL; no amount is read from it", async () => {
    setAccountMap(
      assertAccountMap(
        {
          generatedFrom: "sah-007",
          entries: [
            {
              legacyCode: "1101",
              code: "1000",
              nameEn: "Cash",
              type: "asset",
              treatment: "balance",
            },
            {
              legacyCode: "1301",
              code: "1200",
              nameEn: "AR",
              type: "asset",
              treatment: "ar_control",
            },
            {
              legacyCode: "2101",
              code: "2100",
              nameEn: "AP",
              type: "liability",
              treatment: "ap_control",
            },
          ],
        },
        "sah-007",
      ),
    );
    try {
      const row = { ACCID: "100", ACCCODE: "1101", ACCNAME: "Cash", ACCOPENBAL: null };
      expect(await accountLoader.map(row, { byLegacyRef: async () => null })).toEqual({
        legacyKey: "100",
        legacyCode: "1101",
        code: "1000",
      });
    } finally {
      clearAccountMap();
    }
  });
});

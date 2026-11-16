import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { costingEngine, currency, MIN_MEANINGFUL_QTY, Money, Quantity, round } from "@dulja/domain";
import { costingContext } from "./support/costing";

const MYR = currency("MYR");
const ctx = costingContext("008"); // ← this file's own SAH number

describe("SAH-008 weighted-average cost precision — 0D", () => {
  it("uses exact money arithmetic where double precision does not", () => {
    expect(Money.of("0.1", MYR).add(Money.of("0.2", MYR)).toString()).toBe("0.3000");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("cannot amplify a nonexistent residue through division", () => {
    const value = Money.of("100.0000", MYR).subtract(Money.of("99.9999", MYR));
    expect(value.toString()).toBe("0.0001");
    expect(value.divide("0.0001", "HALF_AWAY_FROM_ZERO").toString()).toBe("1.0000");
    expect((100 - 99.9999) / 0.0001).not.toBe(1);
  });

  it("offers no supported Money-to-number conversion", () => {
    const money = Money.of("1.0000", MYR) as unknown as Record<string, unknown>;
    expect(typeof money["toNumber"]).toBe("undefined");
    expect(money["valueOf"]).toBe(Object.prototype.valueOf);
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(money))
        .filter((key) => key.startsWith("to"))
        .toSorted(),
    ).toEqual(["toDecimal", "toJSON", "toString"]);
  });

  it("does not drift after 10^6 rounds", () => {
    let value = new Decimal("1234.56785");
    for (let iteration = 0; iteration < 1_000_000; iteration += 1)
      value = round(value, 4, "HALF_AWAY_FROM_ZERO");
    expect(value.toFixed(4)).toBe("1234.5679");
  });

  it("represents negative costs without hiding them", () => {
    expect(Money.of("-1.0000", MYR).isNegative()).toBe(true);
    expect(Money.of("-1.0000", MYR).add(Money.of("1.0000", MYR)).isZero()).toBe(true);
  });
});

describe("SAH-008 Weighted-average cost can go negative, explode 10,000x, or be wiped — 3B", () => {
  it("a residue cannot even be expressed as a quantity, so no divisor can explode a cost", () => {
    // Two guards, and the first is the reason the second is unreachable. `Quantity` is fixed at six decimal
    // places and `Quantity.of` throws above them (0d:1034-1039), so the 0.0001-scale residue that gave the
    // old system a divisor of −0.0001 and a stored unit cost of 500,020.00 has no representation here.
    // MIN_MEANINGFUL_QTY is therefore the smallest expressible non-zero quantity, and the engine's refusal
    // below it (amendment A22 — refused, not clamped) guards a future scale change rather than an input.
    expect(() => Quantity.of("0.0000005")).toThrow(/at most 6 decimal places/);
    expect(MIN_MEANINGFUL_QTY.toString()).toBe("0.000001");
  });
  it("a wash line — the zero-quantity arm of SAH-008 — is refused, never costed at zero", () => {
    // This is the arm a runtime input can still present: a landed-cost or reconciliation line of zero
    // quantity. The old system set Cost = 0 and every later sale booked zero COGS.
    expect(() => costingEngine.cost(ctx.washLineIssue())).toThrow(
      /ERR_COST_VALUE_MISSING.*quantity is zero/s,
    );
  });
  it("negative unit_cost and negative qty_remaining are CHECKs, not conventions", async () => {
    const { db } = await ctx.inventory();
    const checks = await db.admin<{ constraint_name: string }[]>`
      select con.conname as constraint_name from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
       where rel.relname = 'cost_layer' and con.contype = 'c' order by 1`;
    expect(checks.map((c) => c.constraint_name)).toEqual(
      expect.arrayContaining(["cost_layer_qty_remaining_check", "cost_layer_unit_cost_check"]),
    );
  });
});

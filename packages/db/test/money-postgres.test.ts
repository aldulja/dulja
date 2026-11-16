import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, D, Money, MONEY_SCALE, round, toBase, type ExchangeRate } from "@dulja/domain";
import { startDb, type Db } from "./harness";

const MYR = currency("MYR");
const USD = currency("USD");
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("toBase agrees with PostgreSQL numeric rounding", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb({ migrate: false });
  });
  afterAll(async () => {
    await db.stop();
  });
  it("matches 10^4 deterministic amount/rate pairs", async () => {
    const random = lcg(20_260_905);
    const values: string[] = [];
    const rates: string[] = [];
    for (let index = 0; index < 10_000; index++) {
      values.push(
        `${random() < 0.5 ? "-" : ""}${Math.floor(random() * 1_000_000)}.${String(Math.floor(random() * 10_000)).padStart(4, "0")}`,
      );
      rates.push(
        `${Math.floor(random() * 20)}.${String(Math.floor(random() * 100_000_000)).padStart(8, "0")}`,
      );
      if (rates[index] === "0.00000000") rates[index] = "0.00000001";
    }
    const rows = await db.admin<
      { i: string; base: string }[]
    >`select t.i::text as i, round(t.v * t.r, 4)::text as base from unnest(${values}::numeric[], ${rates}::numeric[]) with ordinality as t(v, r, i) order by t.i`;
    expect(rows).toHaveLength(10_000); // without this the loop below is vacuous on an empty result
    const mismatches: string[] = [];
    for (const row of rows) {
      const index = Number(row.i) - 1;
      const rate: ExchangeRate = {
        from: USD,
        to: MYR,
        rate: rates[index]!,
        effectiveFrom: "2026-01-01",
        source: "test",
      };
      const theirs = row.base === "-0.0000" ? "0.0000" : row.base;
      if (toBase(Money.of(values[index]!, USD), rate).toString() !== theirs)
        mismatches.push(`${values[index]} x ${rates[index]}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("proves HALF_EVEN would not satisfy the ledger CHECK", async () => {
    // The plan reached for 2.50005 x 1 here, but Money.of refuses a fifth decimal place and
    // 2.5 + 0.0001 is exactly 2.5001, so nothing was ever rounded and no mode could have differed.
    // A real tie has to come out of the product: 1.0001 x 2.5 = 2.500250, half-way at the fourth
    // place with an even digit in front of it, which is exactly where the two modes part company.
    const amount = Money.of("1.0001", USD);
    const rate: ExchangeRate = {
      from: USD,
      to: MYR,
      rate: "2.50000000",
      effectiveFrom: "2026-01-01",
      source: "test",
    };
    const ours = toBase(amount, rate).toString();
    const bankers = round(amount.toDecimal().times(new D(rate.rate)), MONEY_SCALE, "HALF_EVEN");
    expect([ours, bankers.toFixed(MONEY_SCALE)]).toEqual(["2.5003", "2.5002"]);

    // app.ledger_entry checks base_debit = round(debit * exchange_rate, 4). Only one of the two answers
    // satisfies it, so the mode is a correctness choice, not a preference.
    const [row] = await db.admin<{ base: string; ours_ok: boolean; bankers_ok: boolean }[]>`
      select round(1.0001::numeric * 2.50000000::numeric, 4)::text as base,
             ${ours}::numeric = round(1.0001::numeric * 2.50000000::numeric, 4) as ours_ok,
             ${bankers.toFixed(MONEY_SCALE)}::numeric = round(1.0001::numeric * 2.50000000::numeric, 4) as bankers_ok`;
    expect(row).toEqual({ base: "2.5003", ours_ok: true, bankers_ok: false });
  });
});

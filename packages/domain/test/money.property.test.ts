import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, it } from "vitest";
import {
  currency,
  Money,
  Quantity,
  rational,
  round,
  toBase,
  type ExchangeRate,
  type RoundingMode,
} from "../src/index";

const MYR = currency("MYR");
const MODES: readonly RoundingMode[] = [
  "HALF_AWAY_FROM_ZERO",
  "HALF_EVEN",
  "TOWARD_ZERO",
  "AWAY_FROM_ZERO",
];
const amount = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 999_999_999_999_999n }),
    fc.integer({ min: 0, max: 9999 }),
  )
  .map(
    ([negative, whole, fraction]) =>
      `${negative ? "-" : ""}${whole}.${String(fraction).padStart(4, "0")}`,
  );
const money = amount.map((value) => Money.of(value, MYR));

describe("Money property tests — spec §5.0 row 0.9", () => {
  // The explicit timeout overrides `vitest.config.ts`'s 60s default for this one case, and the run
  // count is deliberately not reduced to fit inside it: 10^6 pairs is what spec §5.0 row 0.9 is
  // recorded as resting on, and trading the property away to satisfy a harness limit would quietly
  // weaken the claim rather than the clock. Measured at 2,986 ms on the development machine; CI blew
  // the 60s default (run 35203267981) because `turbo run test` executes all twelve workspaces
  // concurrently and this CPU-bound case competes with the Testcontainers suites starting Postgres.
  // 300s is a ceiling for a pathological runner, not an expectation — if it is ever approached,
  // something is wrong that a longer timeout should not hide.
  it("a + b - b = a, over 10^6 pairs", () => {
    fc.assert(
      fc.property(money, money, (a, b) => a.add(b).subtract(b).equals(a)),
      {
        numRuns: 1_000_000,
        verbose: false,
      },
    );
  }, 300_000);

  it("addition is commutative and associative, and zero is its identity", () => {
    fc.assert(
      fc.property(money, money, (a, b) => a.add(b).equals(b.add(a))),
      { numRuns: 20_000 },
    );
    fc.assert(
      fc.property(money, money, money, (a, b, c) =>
        a
          .add(b)
          .add(c)
          .equals(a.add(b.add(c))),
      ),
      { numRuns: 20_000 },
    );
    fc.assert(
      fc.property(money, (a) => a.add(Money.zero(MYR)).equals(a)),
      { numRuns: 20_000 },
    );
  });

  it("negate is an involution and a - a is zero", () => {
    fc.assert(
      fc.property(money, (a) => a.negate().negate().equals(a) && a.subtract(a).isZero()),
      { numRuns: 20_000 },
    );
  });

  it("allocate sums back to the input exactly, for any weights", () => {
    const weights = fc
      .array(fc.bigInt({ min: 0n, max: 1_000_000n }), { minLength: 1, maxLength: 12 })
      .filter((values) => values.reduce((left, right) => left + right, 0n) > 0n);
    fc.assert(
      fc.property(money, weights, (a, values) => {
        const parts = a.allocate(values, "HALF_AWAY_FROM_ZERO");
        return (
          parts.length === values.length &&
          parts.reduce((left, right) => left.add(right), Money.zero(MYR)).equals(a)
        );
      }),
      { numRuns: 50_000 },
    );
  });

  it("toString round-trips through of()", () => {
    fc.assert(
      fc.property(money, (a) => Money.of(a.toString(), MYR).equals(a)),
      { numRuns: 50_000 },
    );
  });

  it("round is idempotent at its own scale and never moves a value by a whole unit", () => {
    fc.assert(
      fc.property(amount, fc.constantFrom(...MODES), (value, mode) => {
        const once = round(new Decimal(value), 2, mode);
        return (
          round(once, 2, mode).equals(once) &&
          once.minus(new Decimal(value)).abs().lessThan(new Decimal("0.01"))
        );
      }),
      { numRuns: 50_000 },
    );
  });

  it("toBase is sign-preserving for a positive rate", () => {
    const rate: ExchangeRate = {
      from: MYR,
      to: currency("USD"),
      rate: "0.21367521",
      effectiveFrom: "2026-01-01",
      source: "unit test",
    };
    fc.assert(
      fc.property(money, (a) => {
        const converted = toBase(a, rate);
        return a.isZero()
          ? converted.isZero()
          : a.isNegative() === converted.isNegative() || converted.isZero();
      }),
      { numRuns: 50_000 },
    );
  });

  it("Quantity.convert by r then 1/r returns the original when exact", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.bigInt({ min: 1n, max: 1000n }),
        (n, divisor) => {
          const quantity = Quantity.of(`${n}.000000`);
          return (
            quantity.convert(rational(divisor, 1n)).convert(rational(1n, divisor)).toString() ===
            quantity.toString()
          );
        },
      ),
      { numRuns: 20_000 },
    );
  });
});

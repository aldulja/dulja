import { describe, expect, it } from "vitest";
import { currency, Money } from "../src/index";

const myr = Money.of("1.0000", currency("MYR"));
const usd = Money.of("1.0000", currency("USD"));
const typecheckOnly = (): boolean => false;

if (typecheckOnly()) {
  // @ts-expect-error — Money<CurrencyCode & "USD"> is not assignable to Money<CurrencyCode & "MYR">
  myr.add(usd);
  // @ts-expect-error — the same rule holds for subtract
  myr.subtract(usd);
  // @ts-expect-error — and for compare
  myr.compare(usd);
}

describe("adding two currencies is a type error — spec §5.0 row 0.9", () => {
  it("is proved by bun run typecheck, not by this assertion", () => {
    expect(myr.currency).toBe("MYR");
    expect(usd.currency).toBe("USD");
  });

  it("the same-currency operations still compile and are exact", () => {
    expect(myr.add(Money.of("2.0000", currency("MYR"))).toString()).toBe("3.0000");
  });
});

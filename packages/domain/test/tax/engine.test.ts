import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src";
import { producesNoTax, TaxError, taxEngine, type TaxCodeDef, type TaxRegime } from "../../src/tax";

const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);

const REGIME: TaxRegime = {
  id: "r-1",
  code: "SYNTH-MY-v1",
  jurisdiction: "MY",
  version: 1,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};
/** Every figure below is invented. No published Malaysian rate, code name or box name appears anywhere in
 *  this slice (hazard 1, §2.6's card): 0.11 and 0.045 are chosen so they cannot be mistaken for one. */
const code = (over: Partial<TaxCodeDef> = {}): TaxCodeDef => ({
  id: "c-1",
  regimeId: REGIME.id,
  code: "SYN-OUT-STD",
  rate: "0.11000000",
  kind: "output",
  roundingMode: "HALF_AWAY_FROM_ZERO",
  outputAccountId: "a-out",
  inputAccountId: null,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  ...over,
});

describe("taxEngine.compute (§4.9.1, spec:2227-2228)", () => {
  it("exclusive: tax = round(amount x rate) with the CODE's mode; base is the entered amount", () => {
    const [r] = taxEngine.compute(REGIME, [
      { lineNo: 1, amount: m("300.0000"), taxCode: code(), inclusive: false },
    ]);
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("33.0000"); // 300 x 0.11
    expect(r!.taxCode.code).toBe("SYN-OUT-STD");
  });

  // MON-12 (2026-11-15 full review). The code's mode is the TAX's mode on an inclusive line too: rounding the
  // base in that mode and subtracting rounded the tax the other way for the two directed modes.
  it("inclusive: a directed mode rounds the TAX in that direction, as its exclusive twin does", () => {
    const at = (roundingMode: TaxCodeDef["roundingMode"]) =>
      taxEngine.compute(REGIME, [
        { lineNo: 1, amount: m("10.0000"), taxCode: code({ roundingMode }), inclusive: true },
      ])[0]!;
    // The true tax is 10 x 0.11 / 1.11 = 0.990990…
    expect(at("TOWARD_ZERO").tax.toString()).toBe("0.9909");
    expect(at("TOWARD_ZERO").base.toString()).toBe("9.0091");
    expect(at("AWAY_FROM_ZERO").tax.toString()).toBe("0.9910");
    expect(at("AWAY_FROM_ZERO").base.toString()).toBe("9.0090");
    expect(at("HALF_AWAY_FROM_ZERO").tax.toString()).toBe("0.9910");
    // Symmetric across sign: a credit note's line is the exact negation.
    const neg = taxEngine.compute(REGIME, [
      {
        lineNo: 1,
        amount: m("-10.0000"),
        taxCode: code({ roundingMode: "TOWARD_ZERO" }),
        inclusive: true,
      },
    ])[0]!;
    expect(neg.tax.toString()).toBe("-0.9909");
    expect(neg.base.toString()).toBe("-9.0091");
  });

  it("inclusive: base = amount / (1 + rate); base + tax === amount EXACTLY, with no residue", () => {
    const [r] = taxEngine.compute(REGIME, [
      { lineNo: 1, amount: m("333.0000"), taxCode: code(), inclusive: true },
    ]);
    expect(r!.base.add(r!.tax).toString()).toBe("333.0000");
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("33.0000");
  });

  it("the rounding MODE is the code's, not the engine's — SAH-019's whole finding", () => {
    // 100.05 x 0.045 = 4.50225. HALF_AWAY_FROM_ZERO -> 4.5023 (fourth dp); TOWARD_ZERO -> 4.5022.
    const away = taxEngine.compute(REGIME, [
      {
        lineNo: 1,
        amount: m("100.0500"),
        taxCode: code({ rate: "0.04500000", roundingMode: "HALF_AWAY_FROM_ZERO" }),
        inclusive: false,
      },
    ]);
    const toward = taxEngine.compute(REGIME, [
      {
        lineNo: 1,
        amount: m("100.0500"),
        taxCode: code({ rate: "0.04500000", roundingMode: "TOWARD_ZERO" }),
        inclusive: false,
      },
    ]);
    expect(away[0]!.tax.toString()).toBe("4.5023");
    expect(toward[0]!.tax.toString()).toBe("4.5022");
  });

  it("rounding is SYMMETRIC across sign — SAH-019's +6 -> 10 / -6 -> -5 asymmetry cannot recur", () => {
    const pos = taxEngine.compute(REGIME, [
      { lineNo: 1, amount: m("100.0500"), taxCode: code({ rate: "0.04500000" }), inclusive: false },
    ]);
    const neg = taxEngine.compute(REGIME, [
      {
        lineNo: 1,
        amount: m("-100.0500"),
        taxCode: code({ rate: "0.04500000" }),
        inclusive: false,
      },
    ]);
    expect(neg[0]!.tax.toString()).toBe(`-${pos[0]!.tax.toString()}`);
    expect(neg[0]!.base.toString()).toBe("-100.0500");
  });

  it("a credit note's negative amount yields negative tax, and the sign is kept (§4.4.2 A9's exception)", () => {
    const [r] = taxEngine.compute(REGIME, [
      { lineNo: 1, amount: m("-300.0000"), taxCode: code(), inclusive: false },
    ]);
    expect(r!.tax.toString()).toBe("-33.0000");
    expect(r!.tax.isNegative()).toBe(true);
  });

  it("exempt, zero and out_of_scope produce zero tax and the full base — never a null", () => {
    for (const kind of ["exempt", "zero", "out_of_scope"] as const) {
      expect(producesNoTax(kind)).toBe(true);
      const [r] = taxEngine.compute(REGIME, [
        {
          lineNo: 1,
          amount: m("300.0000"),
          taxCode: code({ kind, rate: "0.00000000", outputAccountId: null }),
          inclusive: false,
        },
      ]);
      expect(r!.tax.toString(), kind).toBe("0.0000");
      expect(r!.base.toString(), kind).toBe("300.0000");
    }
    expect(producesNoTax("output")).toBe(false);
    expect(producesNoTax("input")).toBe(false);
  });

  it("a zero-rated code entered INCLUSIVE still yields base === amount", () => {
    const [r] = taxEngine.compute(REGIME, [
      {
        lineNo: 1,
        amount: m("300.0000"),
        taxCode: code({ kind: "zero", rate: "0.00000000", outputAccountId: null }),
        inclusive: true,
      },
    ]);
    expect(r!.base.toString()).toBe("300.0000");
    expect(r!.tax.toString()).toBe("0.0000");
  });

  it("a code from another regime is REFUSED, not silently applied (SAH-020, spec:2444)", () => {
    const foreign = code({ id: "c-9", regimeId: "r-OTHER", code: "SYN-OTHER" });
    try {
      taxEngine.compute(REGIME, [
        { lineNo: 4, amount: m("1.0000"), taxCode: foreign, inclusive: false },
      ]);
      throw new Error("compute should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(TaxError);
      expect((e as TaxError).code).toBe("ERR_TAX_REGIME_MISMATCH");
      // The message names the LINE and BOTH regimes — SAH-020's failure was silence.
      expect((e as TaxError).detail).toBe(
        "line 4: tax code SYN-OTHER belongs to regime r-OTHER, not to SYNTH-MY-v1 v1 (r-1)",
      );
    }
  });

  it("a code outside the regime's WINDOW is refused — and the upper bound is open when effectiveTo is null", () => {
    // A CLOSED regime refuses a code that starts after it ended.
    const closed: TaxRegime = { ...REGIME, effectiveTo: "2026-12-31" };
    const late = code({ effectiveFrom: "2027-01-01" });
    expect(() =>
      taxEngine.compute(closed, [
        { lineNo: 2, amount: m("1.0000"), taxCode: late, inclusive: false },
      ]),
    ).toThrow(
      /line 2: tax code SYN-OUT-STD is effective since 2027-01-01, after regime SYNTH-MY-v1 v1 ended \(2026-12-31\)/,
    );
    // Either regime refuses a code that lapsed before it opened.
    const lapsed = code({ effectiveTo: "2025-12-31" });
    expect(() =>
      taxEngine.compute(REGIME, [
        { lineNo: 3, amount: m("1.0000"), taxCode: lapsed, inclusive: false },
      ]),
    ).toThrow(/line 3: tax code SYN-OUT-STD lapsed on 2025-12-31/);
  });

  it("a code effective MID-regime is accepted — spec:2227's rate-effective-date table needs it", () => {
    // `SYNTH-MY-v1` has `effectiveTo: null`, and a live regime runs indefinitely. A second rate arrives as
    // a new code at a new `effective_from` INSIDE that window — the `unique (company_id, code,
    // effective_from)` shape of 0053 — and refusing it would make every rate change a new REGIME, which is
    // the thing SAH-020's hardcoded literal was the alternative to. T11 Step 1 posts exactly this case.
    const later = code({ code: "SYN-OUT-STD-2", effectiveFrom: "2026-07-01", rate: "0.20000000" });
    const [r] = taxEngine.compute(REGIME, [
      { lineNo: 1, amount: m("1000.0000"), taxCode: later, inclusive: false },
    ]);
    expect(r!.tax.toString()).toBe("200.0000");
  });

  it("compute is pure: the same input twice gives the identical figures, and inputs are not mutated", () => {
    const line = {
      lineNo: 1,
      amount: m("123.4500"),
      taxCode: code({ rate: "0.04500000" }),
      inclusive: false,
    };
    const a = taxEngine.compute(REGIME, [line]);
    const b = taxEngine.compute(REGIME, [line]);
    expect(a[0]!.tax.toString()).toBe(b[0]!.tax.toString());
    expect(line.amount.toString()).toBe("123.4500");
    expect(line.taxCode.rate).toBe("0.04500000");
  });

  it("property: base + tax === amount for every inclusive line, at every rate (10^4 cases)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9_999_999, max: 9_999_999 }),
        fc.integer({ min: 0, max: 40_000_000 }),
        (cents, rateE8) => {
          const amount = Money.of((cents / 10_000).toFixed(4), MYR);
          const rate = (rateE8 / 100_000_000).toFixed(8);
          const [r] = taxEngine.compute(REGIME, [
            { lineNo: 1, amount, taxCode: code({ rate }), inclusive: true },
          ]);
          return r!.base.add(r!.tax).equals(amount);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("property: an exclusive line's base is the entered amount, untouched, at every rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9_999_999, max: 9_999_999 }),
        fc.integer({ min: 0, max: 40_000_000 }),
        (cents, rateE8) => {
          const amount = Money.of((cents / 10_000).toFixed(4), MYR);
          const [r] = taxEngine.compute(REGIME, [
            {
              lineNo: 1,
              amount,
              taxCode: code({ rate: (rateE8 / 100_000_000).toFixed(8) }),
              inclusive: false,
            },
          ]);
          return r!.base.equals(amount);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it("an empty line list is an empty result, not a throw", () => {
    expect(taxEngine.compute(REGIME, [])).toEqual([]);
  });
});

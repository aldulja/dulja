import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src/index";
import {
  PayrollCalculationError,
  RateTableValidationError,
  calculators,
  type PayPeriod,
  type RateTable,
} from "../../payroll/index";

// Every figure below is invented for this test and is NOT any authority's (hazard 1, spec:2080). The two
// non-SYNTH tables are in-memory objects and never reach a seed file.
const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const PERIOD: PayPeriod = {
  start: "2026-01-01",
  end: "2026-01-31",
  payDate: "2026-02-05",
  prorationRule: "calendar_days",
};

/** The synthetic table of §4.12.4, as an object. Bands, not rates: nothing here resembles any authority's. */
const BANDED: RateTable = {
  schema_version: 1,
  scheme: "SYNTH",
  version: 1,
  kind: "banded_contribution",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "none",
    url: "https://example.invalid/synth",
    retrieved_on: "2026-01-01",
  },
  verification: {
    verified_by: "Dulja test fixture",
    verified_on: "2026-01-01",
    method: "synthetic_test",
  },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  table: {
    bands: [
      { from: "0", to: "1000", employee: "10.0000", employer: "20.0000" },
      { from: "1000", to: "5000", employee: "50.0000", employer: "100.0000" },
      { from: "5000", to: null, employee: "250.0000", employer: "500.0000" },
    ],
  },
};

const PERCENTAGE: RateTable = {
  schema_version: 1,
  scheme: "SYNTH_PCT",
  version: 1,
  kind: "percentage_with_ceiling",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "none",
    url: "https://example.invalid/pct",
    retrieved_on: "2026-01-01",
  },
  rounding_mode: "HALF_AWAY_FROM_ZERO",
  table: { employee_rate: "0.1", employer_rate: "0.2", ceiling: "2000.0000", floor: "100.0000" },
};

const PROGRESSIVE: RateTable = {
  schema_version: 1,
  scheme: "SYNTH_PRG",
  version: 1,
  kind: "progressive_schedule",
  effective_from: "2026-01-01",
  effective_to: null,
  source: {
    authority: "Dulja test fixture",
    publication: "none",
    url: "https://example.invalid/prg",
    retrieved_on: "2026-01-01",
  },
  rounding_mode: "HALF_EVEN",
  required_profile_fields: ["child_relief_count"],
  table: {
    brackets: [
      { from: "0", to: "1000", rate: "0", cumulative: "0" },
      { from: "1000", to: "3000", rate: "0.1", cumulative: "0" },
      { from: "3000", to: null, rate: "0.2", cumulative: "200.0000" },
    ],
    reliefs: { child_relief_count: "100.0000" },
  },
};

const input = (base: string, profile: Record<string, string | number | boolean | null> = {}) => ({
  base: m(base),
  profile,
  ytd: {},
  period: PERIOD,
});

describe("SchemeCalculator — three kinds, and not one rate in code (spec:2080, hazard 1)", () => {
  it("banded_contribution reads the band containing the base, half-open [from, to)", () => {
    const c = calculators.banded_contribution;
    expect(c.compute(BANDED, input("999.9999"))).toEqual({
      employeeShare: m("10.0000"),
      employerShare: m("20.0000"),
    });
    expect(c.compute(BANDED, input("1000.0000"))).toEqual({
      employeeShare: m("50.0000"),
      employerShare: m("100.0000"),
    });
    expect(c.compute(BANDED, input("999999.0000"))).toEqual({
      employeeShare: m("250.0000"),
      employerShare: m("500.0000"),
    });
  });

  it("banded_contribution REFUSES a base no band covers rather than returning zero (SAH-011)", () => {
    const gap: RateTable = {
      ...BANDED,
      table: { bands: [{ from: "1000", to: "5000", employee: "1.0000", employer: "2.0000" }] },
    };
    expect(() => calculators.banded_contribution.compute(gap, input("10.0000"))).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "rate table SYNTH v1 has no band covering a base of 10.0000; a contribution base outside every band is a gap in the table, never a zero contribution",
      ),
    );
  });

  it("percentage_with_ceiling caps at the ceiling and floors at the floor, then applies the declared mode", () => {
    const c = calculators.percentage_with_ceiling;
    expect(c.compute(PERCENTAGE, input("1000.0000"))).toEqual({
      employeeShare: m("100.0000"),
      employerShare: m("200.0000"),
    });
    // Above the ceiling: the ceiling is the base.
    expect(c.compute(PERCENTAGE, input("9999.0000"))).toEqual({
      employeeShare: m("200.0000"),
      employerShare: m("400.0000"),
    });
    // Below the floor: the floor is the base.
    expect(c.compute(PERCENTAGE, input("1.0000"))).toEqual({
      employeeShare: m("10.0000"),
      employerShare: m("20.0000"),
    });
  });

  it("percentage_with_ceiling applies the TABLE's declared rounding mode, and the two modes DISAGREE here (SAH-019)", () => {
    // The rate is chosen so the product is exactly `0.33325` — a tie at the fourth decimal whose preceding
    // digit is EVEN. That is the only input shape on which the two modes differ, and a case where they agree
    // would pass even if the calculators ignored `rounding_mode` entirely.
    const halfUp: RateTable = {
      ...PERCENTAGE,
      rounding_mode: "HALF_AWAY_FROM_ZERO",
      table: { employee_rate: "0.33325", employer_rate: "0", ceiling: null, floor: null },
    };
    const halfEven: RateTable = { ...halfUp, rounding_mode: "HALF_EVEN" };
    const c = calculators.percentage_with_ceiling;
    expect(c.compute(halfUp, input("1.0000")).employeeShare).toEqual(m("0.3333"));
    expect(c.compute(halfEven, input("1.0000")).employeeShare).toEqual(m("0.3332"));
  });

  it("progressive_schedule subtracts reliefs by the profile's multiplier, then walks the brackets", () => {
    const c = calculators.progressive_schedule;
    // chargeable 3200 − (2 × 100) = 3000 → bracket 3 → 200 + (3000 − 3000) × 0.2 = 200.
    expect(c.compute(PROGRESSIVE, input("3200.0000", { child_relief_count: 2 }))).toEqual({
      employeeShare: m("200.0000"),
      employerShare: Money.zero(MYR),
    });
    // chargeable 2000 − 0 = 2000 → bracket 2 → 0 + (2000 − 1000) × 0.1 = 100.
    expect(c.compute(PROGRESSIVE, input("2000.0000", { child_relief_count: 0 }))).toEqual({
      employeeShare: m("100.0000"),
      employerShare: Money.zero(MYR),
    });
  });

  it("progressive_schedule NEVER returns a negative charge — relief beyond the chargeable amount floors at zero", () => {
    expect(
      calculators.progressive_schedule.compute(
        PROGRESSIVE,
        input("50.0000", { child_relief_count: 9 }),
      ).employeeShare,
    ).toEqual(Money.zero(MYR));
  });

  it("progressive_schedule REFUSES a missing required profile field, naming it (SAH-011, test 33)", () => {
    expect(() =>
      calculators.progressive_schedule.compute(
        PROGRESSIVE,
        input("3200.0000", { child_relief_count: null }),
      ),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "rate table SYNTH_PRG v1 requires statutory input 'child_relief_count' and the value is null",
      ),
    );
    // A field the table declares in `required_profile_fields` refuses even when no relief reads it.
    const declared: RateTable = { ...PROGRESSIVE, required_profile_fields: ["residency_category"] };
    expect(() =>
      calculators.progressive_schedule.compute(
        declared,
        input("3200.0000", { child_relief_count: 1 }),
      ),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "rate table SYNTH_PRG v1 requires statutory input 'residency_category' and the value is absent",
      ),
    );
  });

  it("a table whose `table` shape does not match its `kind` is refused, never read as zero", () => {
    // The schema's `table` is a oneOf independent of `kind`, so a mismatched definition validates; the
    // calculator is where the pair is checked.
    const mismatched: RateTable = { ...PERCENTAGE, kind: "banded_contribution" };
    expect(() => calculators.banded_contribution.compute(mismatched, input("10.0000"))).toThrow(
      RateTableValidationError,
    );
  });

  it("`calculators` covers exactly the three kinds the §4.12.3 schema admits, and no fourth", () => {
    expect(Object.keys(calculators).toSorted()).toEqual([
      "banded_contribution",
      "percentage_with_ceiling",
      "progressive_schedule",
    ]);
    for (const [kind, c] of Object.entries(calculators)) expect(c.kind).toBe(kind);
  });
});

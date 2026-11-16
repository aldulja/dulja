import { describe, expect, it } from "vitest";
import { Money, currency } from "../../src/index";
import {
  eligibleDays,
  payrollCalculator,
  periodDays,
  prorationFactor,
  type EmployeePeriodInput,
  type PayPeriod,
  type RateTableRef,
} from "../../payroll/index";

// ⚠️ OD-28 (spec:2086) — docs/owner/od-28-proration-rule.md. Every figure is invented (hazard 1).
const MYR = currency("MYR");
const CAL: PayPeriod = {
  start: "2026-01-01",
  end: "2026-01-31",
  payDate: "2026-02-05",
  prorationRule: "calendar_days",
};
const WRK: PayPeriod = { ...CAL, prorationRule: "working_days" };

describe("OD-28 — proration is CONFIGURATION, never a statutory claim (spec:2086)", () => {
  it("calendar_days counts every day of the period, inclusive of both ends", () => {
    expect(periodDays(CAL)).toBe(31);
    expect(eligibleDays(CAL, "2026-01-17", null)).toBe(15);
    expect(eligibleDays(CAL, "2025-01-01", "2026-01-10")).toBe(10);
    // February of a non-leap year, and of a leap year.
    expect(periodDays({ ...CAL, start: "2026-02-01", end: "2026-02-28" })).toBe(28);
    expect(periodDays({ ...CAL, start: "2028-02-01", end: "2028-02-29" })).toBe(29);
  });

  it("working_days counts Monday–Friday and nothing else", () => {
    // January 2026: the 1st is a Thursday, so the month holds 22 weekdays.
    expect(periodDays(WRK)).toBe(22);
    // Hired Saturday the 17th: the eligible window is the 17th..31st, of which 10 are weekdays.
    expect(eligibleDays(WRK, "2026-01-17", null)).toBe(10);
    // A leaver on Sunday the 4th worked the 1st and 2nd (Thursday, Friday) only.
    expect(eligibleDays(WRK, "2025-01-01", "2026-01-04")).toBe(2);
  });

  it("public holidays are NOT subtracted, and that is the open half of OD-28", () => {
    // app.public_holiday is 8D's table (§4.6.1); whether a holiday reduces a working-day denominator is the
    // accountant's answer, not this plan's. The working-day count of a month is its weekday count, whatever falls in it.
    expect(periodDays(WRK)).toBe(22);
  });

  it("both sides of the window use ONE rule — a joiner and a leaver are prorated identically", () => {
    expect(prorationFactor(CAL, { hiredOn: "2026-01-16", terminatedOn: null })).toEqual({
      numerator: 16,
      denominator: 31,
    });
    expect(prorationFactor(CAL, { hiredOn: "2025-01-01", terminatedOn: "2026-01-16" })).toEqual({
      numerator: 16,
      denominator: 31,
    });
  });

  it("a period in which the rule counts no day is refused rather than divided by zero", () => {
    // Saturday 3 to Sunday 4 January 2026 holds no weekday.
    const weekend: PayPeriod = { ...WRK, start: "2026-01-03", end: "2026-01-04" };
    expect(periodDays(weekend)).toBe(0);
    expect(() => prorationFactor(weekend, { hiredOn: "2025-01-01", terminatedOn: null })).toThrow(
      RangeError,
    );
  });

  it("the two rules give DIFFERENT figures on the same employee, which is why the answer matters", () => {
    const ref: RateTableRef = {
      schemeId: "s",
      schemeCode: "SYNTH",
      version: 1,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      verified: true,
      definition: {
        schema_version: 1,
        scheme: "SYNTH",
        version: 1,
        kind: "banded_contribution",
        effective_from: "2026-01-01",
        effective_to: null,
        source: {
          authority: "Dulja test fixture",
          publication: "none",
          url: "https://example.invalid/s",
          retrieved_on: "2026-01-01",
        },
        table: { bands: [{ from: "0", to: null, employee: "1.0000", employer: "1.0000" }] },
      },
    };
    const employee: EmployeePeriodInput = {
      employeeId: "emp-1",
      branchId: "b",
      hiredOn: "2026-01-17",
      terminatedOn: null,
      statutoryProfile: {},
      compensation: [
        {
          componentId: "c",
          kind: "earning",
          amount: Money.of("3100.0000", MYR),
          quantity: null,
          schemeIds: ["s"],
        },
      ],
      manualOverrides: [],
    };
    const cal = payrollCalculator.calculate({
      period: CAL,
      employees: [employee],
      rateTables: [ref],
      ytdBefore: {},
    });
    const wrk = payrollCalculator.calculate({
      period: WRK,
      employees: [employee],
      rateTables: [ref],
      ytdBefore: {},
    });
    expect(cal.employees[0]!.gross).toEqual(Money.of("1500.0000", MYR)); // 3100 × 15/31
    expect(wrk.employees[0]!.gross).toEqual(Money.of("1409.0909", MYR)); // 3100 × 10/22
    expect(cal.employees[0]!.gross.equals(wrk.employees[0]!.gross)).toBe(false);
  });

  // ⚠️ OD-28. The gate is visible in test output rather than in a comment nobody runs. When the accountant's
  // confirmation arrives, un-skip exactly ONE of the two below, delete the other, give it the assertion its row in
  // docs/owner/od-28-proration-rule.md names, and record the answer as an addendum to ADR 0074.
  it.skip("OD-28 CONFIRMED calendar_days — the seeded company_hr_setting.proration_rule is 'calendar_days'", () => {
    expect(CAL.prorationRule).toBe("calendar_days");
  });
  it.skip("OD-28 CONFIRMED working_days — the seeded company_hr_setting.proration_rule is 'working_days'", () => {
    expect(WRK.prorationRule).toBe("working_days");
  });
});

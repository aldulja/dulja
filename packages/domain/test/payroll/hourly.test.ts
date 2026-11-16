import { describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "../../src/index";
import { payrollCalculator, type PayPeriod } from "../../payroll/index";

// ⚠️ OD-14 item 3 (spec:2093) — docs/owner/od-14-hr-facts.md. Every figure is invented (hazard 1).
const MYR = currency("MYR");
const PERIOD: PayPeriod = {
  start: "2026-01-01",
  end: "2026-01-31",
  payDate: "2026-02-05",
  prorationRule: "calendar_days",
};

describe("OD-14 item 3 — hourly and part-time staff (spec:2093)", () => {
  // Un-skip if and only if the owner answers item 3 "yes". The quantity path it exercises is live and tested
  // unconditionally in calculator.test.ts ("a quantity-based component is amount × quantity and is NOT prorated");
  // this case is the acceptance for an HOURLY earning component, which is not seeded until the answer arrives.
  it.skip("OD-14 CONFIRMED hourly — an HOURLY component is hours × rate and is NOT prorated", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [
        {
          employeeId: "emp-hourly",
          branchId: "b",
          // Joined mid-month: the proration factor is 15/31 and must NOT touch the hourly line, because the hours
          // already say how much of the period was worked. Prorating it would halve a real figure.
          hiredOn: "2026-01-17",
          terminatedOn: null,
          statutoryProfile: {},
          compensation: [
            {
              componentId: "cmp-hourly",
              kind: "earning",
              amount: Money.of("12.5000", MYR),
              quantity: Quantity.of("64.000000"),
              schemeIds: [],
            },
          ],
          manualOverrides: [],
        },
      ],
      rateTables: [],
      ytdBefore: {},
    });
    expect(out.employees[0]!.gross).toEqual(Money.of("800.0000", MYR)); // 12.50 × 64, unprorated
    expect(out.employees[0]!.net).toEqual(Money.of("800.0000", MYR));
  });
});

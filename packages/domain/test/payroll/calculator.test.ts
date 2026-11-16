import { describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "../../src/index";
import {
  PayrollCalculationError,
  payrollCalculator,
  prorationFactor,
  schemeYtdKey,
  ytdKey,
  type EmployeePeriodInput,
  type PayPeriod,
  type RateTable,
  type RateTableRef,
} from "../../payroll/index";

// Every figure is invented (hazard 1): the SYNTH table of §4.12.4, never any authority's.
const MYR = currency("MYR");
const m = (v: string) => Money.of(v, MYR);
const PERIOD: PayPeriod = {
  start: "2026-01-01",
  end: "2026-01-31",
  payDate: "2026-02-05",
  prorationRule: "calendar_days",
};

const SYNTH: RateTable = {
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

const REF = (over: Partial<RateTableRef> = {}): RateTableRef => ({
  schemeId: "scheme-synth",
  schemeCode: "SYNTH",
  version: 1,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  definition: SYNTH,
  verified: true,
  ...over,
});

const EMPLOYEE = (over: Partial<EmployeePeriodInput> = {}): EmployeePeriodInput => ({
  employeeId: "emp-1",
  branchId: "branch-hq",
  hiredOn: "2025-01-01",
  terminatedOn: null,
  statutoryProfile: {},
  compensation: [
    {
      componentId: "cmp-basic",
      kind: "earning",
      amount: m("2000.0000"),
      quantity: null,
      schemeIds: ["scheme-synth"],
    },
  ],
  manualOverrides: [],
  ...over,
});

const run = (employees: EmployeePeriodInput[], rateTables: RateTableRef[] = [REF()]) =>
  payrollCalculator.calculate({ period: PERIOD, employees, rateTables, ytdBefore: {} });

describe("payrollCalculator.calculate (§4.12.1)", () => {
  it("gross, scheme shares and net are the arithmetic spec:2101 describes, and nothing more", () => {
    const out = run([EMPLOYEE()]);
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("2000.0000"));
    expect(e.earnings).toEqual([{ componentId: "cmp-basic", amount: m("2000.0000") }]);
    expect(e.schemes).toEqual([
      {
        schemeId: "scheme-synth",
        schemeCode: "SYNTH",
        rateTableVersion: 1,
        employeeShare: m("50.0000"),
        employerShare: m("100.0000"),
        base: m("2000.0000"),
        roundingMode: "HALF_AWAY_FROM_ZERO",
      },
    ]);
    // net = gross − deductions − employee shares. The EMPLOYER share never touches net.
    expect(e.net).toEqual(m("1950.0000"));
    expect(out.pinnedTables).toEqual([{ schemeId: "scheme-synth", version: 1 }]);
  });

  it("a deduction reduces net and an employer share does not", () => {
    const out = run([
      EMPLOYEE({
        compensation: [
          {
            componentId: "cmp-basic",
            kind: "earning",
            amount: m("2000.0000"),
            quantity: null,
            schemeIds: ["scheme-synth"],
          },
          {
            componentId: "cmp-adv",
            kind: "deduction",
            amount: m("300.0000"),
            quantity: null,
            schemeIds: [],
          },
        ],
      }),
    ]);
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("2000.0000")); // gross is EARNINGS only
    expect(e.deductions).toEqual([{ componentId: "cmp-adv", amount: m("300.0000") }]);
    expect(e.net).toEqual(m("1650.0000")); // 2000 − 300 − 50
  });

  it("the contribution BASE is the earnings joined to that scheme, never the whole gross (RC-3, spec:2079)", () => {
    const out = run([
      EMPLOYEE({
        compensation: [
          {
            componentId: "cmp-basic",
            kind: "earning",
            amount: m("900.0000"),
            quantity: null,
            schemeIds: ["scheme-synth"],
          },
          {
            componentId: "cmp-bonus",
            kind: "earning",
            amount: m("900.0000"),
            quantity: null,
            schemeIds: [],
          },
        ],
      }),
    ]);
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("1800.0000"));
    expect(e.schemes[0]!.base).toEqual(m("900.0000")); // the bonus is not joined to the scheme
    expect(e.schemes[0]!.employeeShare).toEqual(m("10.0000")); // band 1, because 900 < 1000
  });

  // HRP-03 (review 2026-11-15): a deduction joined to a scheme reduces that scheme's base. Before the fix the base was
  // the joined earnings alone, so unpaid leave linked to a scheme left every share charged on the unreduced salary.
  it("a DEDUCTION joined to a scheme reduces that scheme's base (HRP-03, RC-3)", () => {
    const out = run([
      EMPLOYEE({
        compensation: [
          {
            componentId: "cmp-basic",
            kind: "earning",
            amount: m("3000.0000"),
            quantity: null,
            schemeIds: ["scheme-synth"],
          },
          {
            componentId: "cmp-unpaid",
            kind: "deduction",
            amount: m("1000.0000"),
            quantity: null,
            schemeIds: ["scheme-synth"],
          },
        ],
      }),
    ]);
    const e = out.employees[0]!;
    expect(e.gross).toEqual(m("3000.0000")); // gross stays the earnings
    expect(e.schemes[0]!.base).toEqual(m("2000.0000")); // 3000 − 1000
    expect(e.net).toEqual(m("1950.0000")); // 3000 − 1000 − 50 (band 2 on 2000)
    // The scheme order is still the order the EARNINGS named them, whatever the deduction's code sorts as.
    expect(e.schemes.map((s) => s.schemeId)).toEqual(["scheme-synth"]);
  });

  it("joined deductions that exceed the joined earnings refuse, naming the employee — never a negative base", () => {
    const attempt = () =>
      run([
        EMPLOYEE({
          compensation: [
            {
              componentId: "cmp-basic",
              kind: "earning",
              amount: m("500.0000"),
              quantity: null,
              schemeIds: ["scheme-synth"],
            },
            {
              componentId: "cmp-unpaid",
              kind: "deduction",
              amount: m("600.0000"),
              quantity: null,
              schemeIds: ["scheme-synth"],
            },
          ],
        }),
      ]);
    expect(attempt).toThrow(PayrollCalculationError);
    expect(attempt).toThrow(/emp-1.*scheme-synth.*-100\.0000/);
  });

  it("a deduction joined to a scheme NO earning feeds refuses rather than inventing a contribution", () => {
    const attempt = () =>
      run([
        EMPLOYEE({
          compensation: [
            {
              componentId: "cmp-basic",
              kind: "earning",
              amount: m("2000.0000"),
              quantity: null,
              schemeIds: [],
            },
            {
              componentId: "cmp-unpaid",
              kind: "deduction",
              amount: m("100.0000"),
              quantity: null,
              schemeIds: ["scheme-synth"],
            },
          ],
        }),
      ]);
    expect(attempt).toThrow(/emp-1.*scheme-synth/);
  });

  it("a quantity-based component is amount × quantity and is NOT prorated", () => {
    const out = run(
      [
        EMPLOYEE({
          hiredOn: "2026-01-17",
          compensation: [
            {
              componentId: "cmp-basic",
              kind: "earning",
              amount: m("3100.0000"),
              quantity: null,
              schemeIds: [],
            },
            {
              componentId: "cmp-unpaid",
              kind: "deduction",
              amount: m("100.0000"),
              quantity: Quantity.of("3.000000"),
              schemeIds: [],
            },
          ],
        }),
      ],
      [],
    );
    // The fixed line is prorated 15/31; the quantity line is not.
    expect(out.employees[0]!.earnings).toEqual([
      { componentId: "cmp-basic", amount: m("1500.0000") },
    ]);
    expect(out.employees[0]!.deductions).toEqual([
      { componentId: "cmp-unpaid", amount: m("300.0000") },
    ]);
    expect(out.employees[0]!.net).toEqual(m("1200.0000"));
  });

  it("a quantity-based component with NO per-unit amount refuses, naming the employee (SAH-011)", () => {
    expect(() =>
      run(
        [
          EMPLOYEE({
            compensation: [
              {
                componentId: "cmp-unpaid",
                kind: "deduction",
                amount: null,
                quantity: Quantity.of("3.000000"),
                schemeIds: [],
              },
            ],
          }),
        ],
        [],
      ),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1 has a quantity of 3.000000 on component cmp-unpaid and no per-unit amount; a quantity without a rate is not a zero line",
      ),
    );
  });

  it("a component with neither an amount nor a quantity refuses, naming both", () => {
    expect(() =>
      run(
        [
          EMPLOYEE({
            compensation: [
              {
                componentId: "cmp-basic",
                kind: "earning",
                amount: null,
                quantity: null,
                schemeIds: [],
              },
            ],
          }),
        ],
        [],
      ),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1 has component cmp-basic with neither an amount nor a quantity",
      ),
    );
  });

  it("an employee with NO compensation at all refuses too, and with the OTHER message", () => {
    // The two refusals are ordered: the component gate runs before the currency is derived, so the case above gets
    // the message naming its component and this one gets the currency message. If either case reports the other's
    // message, the two are running in the wrong order and SAH-011's diagnosis is the thing lost.
    expect(() => run([EMPLOYEE({ compensation: [] })], [])).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1 has no compensation line carrying an amount; a run cannot compute a currency out of nothing",
      ),
    );
  });

  it("an UNVERIFIED table refuses the whole run, naming the scheme and version (test 29, spec:2080)", () => {
    expect(() => run([EMPLOYEE()], [REF({ verified: false })])).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
        "rate table SYNTH v1 is not verified; a payroll run cannot pin an unverified table (spec:2080)",
      ),
    );
    // The gate runs before a single figure: an employee whose OWN input is broken still gets the table refusal.
    expect(() => run([EMPLOYEE({ compensation: [] })], [REF({ verified: false })])).toThrow(
      /ERR_PAYROLL_RATE_TABLE_UNVERIFIED/,
    );
  });

  it("a table whose effective range does not COVER the period refuses (test 29, SAH-020)", () => {
    expect(() =>
      run([EMPLOYEE()], [REF({ effectiveFrom: "2026-01-15", effectiveTo: null })]),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
        "rate table SYNTH v1 is effective 2026-01-15..open and does not cover the pay period 2026-01-01..2026-01-31",
      ),
    );
    expect(() =>
      run([EMPLOYEE()], [REF({ effectiveFrom: "2025-01-01", effectiveTo: "2026-01-20" })]),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
        "rate table SYNTH v1 is effective 2025-01-01..2026-01-20 and does not cover the pay period 2026-01-01..2026-01-31",
      ),
    );
    // Both ends inclusive: a table effective exactly over the period covers it.
    expect(() =>
      run([EMPLOYEE()], [REF({ effectiveFrom: "2026-01-01", effectiveTo: "2026-01-31" })]),
    ).not.toThrow();
  });

  it("a scheme a component names with NO table refuses rather than skipping the contribution", () => {
    expect(() => run([EMPLOYEE()], [])).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
        "employee emp-1 contributes to scheme scheme-synth and no rate table was supplied for it covering 2026-01-01..2026-01-31",
      ),
    );
  });

  it("a scheme's own refusal names the employee as well as the table (test 33)", () => {
    const required: RateTable = { ...SYNTH, required_profile_fields: ["child_relief_count"] };
    expect(() =>
      run(
        [EMPLOYEE({ statutoryProfile: { child_relief_count: null } })],
        [REF({ definition: required })],
      ),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1: rate table SYNTH v1 requires statutory input 'child_relief_count' and the value is null",
      ),
    );
  });

  it("a manual override REPLACES the computed share and the run still balances (spec:2087)", () => {
    const out = run([
      EMPLOYEE({
        manualOverrides: [
          {
            schemeId: "scheme-synth",
            share: "employee",
            amount: m("77.0000"),
            reason: "authority letter on file",
          },
        ],
      }),
    ]);
    const e = out.employees[0]!;
    expect(e.schemes[0]!.employeeShare).toEqual(m("77.0000"));
    expect(e.schemes[0]!.employerShare).toEqual(m("100.0000")); // untouched
    expect(e.net).toEqual(m("1923.0000")); // 2000 − 77
    // The table is STILL pinned: an override changes a figure, never what the run was computed against.
    expect(out.pinnedTables).toEqual([{ schemeId: "scheme-synth", version: 1 }]);
  });

  it("a manual override on a scheme the employee does not contribute to refuses, never vanishes", () => {
    expect(() =>
      run([
        EMPLOYEE({
          manualOverrides: [
            {
              schemeId: "scheme-other",
              share: "employer",
              amount: m("5.0000"),
              reason: "authority letter on file",
            },
          ],
        }),
      ]),
    ).toThrow(
      new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        "employee emp-1 has a manual employer override on scheme scheme-other and no earning feeding that scheme; remove the override or join a component to the scheme",
      ),
    );
  });

  it("a mid-month joiner is prorated by calendar days, exactly", () => {
    // Hired on the 17th of a 31-day month → 15 eligible days (17th..31st inclusive).
    expect(prorationFactor(PERIOD, { hiredOn: "2026-01-17", terminatedOn: null })).toEqual({
      numerator: 15,
      denominator: 31,
    });
    const out = run([EMPLOYEE({ hiredOn: "2026-01-17" })]);
    // 2000 × 15/31 = 967.741935… → HALF_AWAY_FROM_ZERO at 4 dp.
    expect(out.employees[0]!.gross).toEqual(m("967.7419"));
  });

  it("a leaver mid-month is prorated on the other side, and someone hired and gone inside the period gets both", () => {
    expect(prorationFactor(PERIOD, { hiredOn: "2025-01-01", terminatedOn: "2026-01-10" })).toEqual({
      numerator: 10,
      denominator: 31,
    });
    expect(prorationFactor(PERIOD, { hiredOn: "2026-01-06", terminatedOn: "2026-01-10" })).toEqual({
      numerator: 5,
      denominator: 31,
    });
    expect(prorationFactor(PERIOD, { hiredOn: "2026-02-01", terminatedOn: null })).toEqual({
      numerator: 0,
      denominator: 31,
    });
  });

  it("an impossible date or an inverted period is refused, never rolled over", () => {
    expect(() => prorationFactor(PERIOD, { hiredOn: "2026-02-30", terminatedOn: null })).toThrow(
      RangeError,
    );
    expect(() =>
      prorationFactor(
        { ...PERIOD, start: "2026-01-31", end: "2026-01-01" },
        {
          hiredOn: "2025-01-01",
          terminatedOn: null,
        },
      ),
    ).toThrow(RangeError);
  });

  it("ytdAfter adds this run to ytdBefore under one key space (8C and 8D read it)", () => {
    const out = payrollCalculator.calculate({
      period: PERIOD,
      employees: [EMPLOYEE()],
      rateTables: [REF()],
      ytdBefore: {
        "emp-1": {
          [ytdKey("gross")]: m("4000.0000"),
          [schemeYtdKey("SYNTH", "employee")]: m("100.0000"),
        },
      },
    });
    const y = out.employees[0]!.ytdAfter;
    expect(y[ytdKey("gross")]).toEqual(m("6000.0000"));
    expect(y[ytdKey("net")]).toEqual(m("1950.0000"));
    expect(y[schemeYtdKey("SYNTH", "employee")]).toEqual(m("150.0000"));
    expect(y[schemeYtdKey("SYNTH", "employer")]).toEqual(m("100.0000"));
  });

  it("the calculator is PURE — two calls on the same input are byte-identical (test 33's mechanism)", () => {
    const input = { period: PERIOD, employees: [EMPLOYEE()], rateTables: [REF()], ytdBefore: {} };
    expect(JSON.stringify(payrollCalculator.calculate(input))).toBe(
      JSON.stringify(payrollCalculator.calculate(input)),
    );
  });
});

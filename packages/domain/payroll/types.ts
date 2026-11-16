// §4.12.1 verbatim, plus the RateTable narrowings the calculators need.
import type { Money, Quantity, RoundingMode } from "../src/index";
import type { RateTable } from "./rate-table";

// Re-exported for callers INSIDE payroll/ only. `index.ts` must NOT forward it — 8A's barrel line already exports
// `RateTable` from "./rate-table", and a second export of the name from one barrel is TS2308.
export type { RateTable } from "./rate-table";

export type RateTableKind = RateTable["kind"];
/** The three `table` shapes the schema's `oneOf` admits, narrowed for the three calculators. */
export type BandedTable = Extract<RateTable["table"], { bands: unknown }>;
export type PercentageTable = Extract<RateTable["table"], { employee_rate: unknown }>;
export type ProgressiveTable = Extract<RateTable["table"], { brackets: unknown }>;

export interface EmployeePeriodInput {
  employeeId: string;
  branchId: string;
  hiredOn: string;
  terminatedOn: string | null;
  /** The §4.12.3 `required_profile_fields` a scheme declares are looked up here. ⚠️ OD-28 fixes the list. */
  statutoryProfile: Record<string, string | number | boolean | null>;
  compensation: {
    componentId: string;
    kind: "earning" | "deduction";
    /** For a quantity-based component this is the PER-UNIT rate; for a fixed one, the period amount. */
    amount: Money | null;
    quantity: Quantity | null;
    /** The schemes this component feeds, from `pay_component_scheme` — never a "subject to X" boolean (RC-3). An
     *  earning adds to each scheme's base and a deduction reduces it (HRP-03). */
    schemeIds: string[];
  }[];
  manualOverrides: {
    schemeId: string;
    share: "employee" | "employer";
    amount: Money;
    reason: string;
  }[];
}

export interface PayPeriod {
  start: string;
  end: string;
  payDate: string;
  prorationRule: "calendar_days" | "working_days";
}

export interface RateTableRef {
  schemeId: string;
  schemeCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  definition: RateTable;
  verified: boolean;
}

export interface SchemeResult {
  schemeId: string;
  schemeCode: string;
  rateTableVersion: number;
  employeeShare: Money;
  employerShare: Money;
  base: Money;
  roundingMode: RoundingMode;
}

export interface EmployeeResult {
  employeeId: string;
  gross: Money;
  earnings: { componentId: string; amount: Money }[];
  deductions: { componentId: string; amount: Money }[];
  schemes: SchemeResult[];
  net: Money;
  /**
   * The running totals AFTER this run. Key space, fixed here so 8C's `employee_ytd` and 8D's statements read one
   * vocabulary: `"gross"`, `"net"`, and `"<schemeCode>.employee"` / `"<schemeCode>.employer"` per scheme.
   */
  ytdAfter: Record<string, Money>;
}

export interface PayrollCalculator {
  /**
   * Pure. Refuses (`ERR_PAYROLL_RATE_TABLE_UNVERIFIED`) any table with `verified = false` or whose
   * `[effectiveFrom, effectiveTo]` does not cover the pay period; refuses (`ERR_PAYROLL_INPUT_MISSING`, naming
   * `employeeId` and the field) any NULL statutory input a scheme's definition declares required; applies each
   * scheme's declared rounding mode; **never contains a rate, threshold or ceiling.**
   */
  calculate(input: {
    period: PayPeriod;
    employees: EmployeePeriodInput[];
    rateTables: RateTableRef[];
    ytdBefore: Record<string, Record<string, Money>>;
  }): { employees: EmployeeResult[]; pinnedTables: { schemeId: string; version: number }[] };
}

export interface SchemeCalculator {
  readonly kind: RateTableKind;
  compute(
    table: RateTable,
    input: {
      base: Money;
      profile: EmployeePeriodInput["statutoryProfile"];
      ytd: Record<string, Money>;
      period: PayPeriod;
    },
  ): { employeeShare: Money; employerShare: Money };
}

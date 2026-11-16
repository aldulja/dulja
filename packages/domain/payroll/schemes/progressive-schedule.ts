import type Decimal from "decimal.js";
import { D, MONEY_SCALE, Money } from "../../src/index";
import { PayrollCalculationError } from "../errors";
import type { EmployeePeriodInput, RateTable, SchemeCalculator } from "../types";
import { assertRequiredInputs, missingInput, modeOf, nameOf, shapeMismatch, within } from "./shape";

/**
 * The multiplier a profile value contributes to its relief. Total and explicit, so a profile shape nobody
 * anticipated becomes a refusal rather than a silent zero.
 */
function multiplier(
  table: RateTable,
  key: string,
  value: EmployeePeriodInput["statutoryProfile"][string] | undefined,
): Decimal {
  if (value === undefined || value === null) throw missingInput(table, key, value);
  if (typeof value === "number") return new D(value);
  if (typeof value === "boolean") return new D(value ? 1 : 0);
  // A string profile value is a category, not a count: present and non-empty means the relief applies once.
  return new D(value.length > 0 ? 1 : 0);
}

/**
 * `chargeable = base − Σ reliefs`, then the bracket containing `chargeable`:
 * `charge = cumulative + (chargeable − from) × rate`, floored at zero, rounded once with the declared mode.
 *
 * **It computes on the PERIOD's chargeable amount as supplied in `base` and makes no annualisation claim.**
 * spec:2080 forbids this repository from stating a method; if the accountant's verified method annualises (OD-23,
 * OD-28), the rate table gains a fourth `kind` through §4.12.3 and its own calculator, and this one is untouched.
 * `ytd` is in the frozen `SchemeCalculator` signature and is deliberately unread here for the same reason.
 */
export const progressiveSchedule: SchemeCalculator = {
  kind: "progressive_schedule",
  compute(table, { base, profile }) {
    if (!("brackets" in table.table)) throw shapeMismatch(table, "brackets");
    assertRequiredInputs(table, profile);
    const t = table.table;
    const mode = modeOf(table);

    let relief = new D(0);
    for (const [key, amount] of Object.entries(t.reliefs)) {
      relief = relief.plus(new D(amount).times(multiplier(table, key, profile[key])));
    }
    let chargeable = base.toDecimal().minus(relief);
    if (chargeable.isNegative()) chargeable = new D(0);

    const bracket = t.brackets.find((b) => within(chargeable, b));
    if (bracket === undefined) {
      throw new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `${nameOf(table)} has no bracket covering a chargeable amount of ${chargeable.toFixed(MONEY_SCALE)}; ` +
          "a chargeable amount outside every bracket is a gap in the table, never a zero charge",
      );
    }
    let charge = new D(bracket.cumulative).plus(
      chargeable.minus(new D(bracket.from)).times(new D(bracket.rate)),
    );
    if (charge.isNegative()) charge = new D(0);

    return {
      employeeShare: Money.fromDecimal(charge, base.currency, mode),
      employerShare: Money.zero(base.currency),
    };
  },
};

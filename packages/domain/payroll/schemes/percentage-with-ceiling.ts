import { D, Money } from "../../src/index";
import type { SchemeCalculator } from "../types";
import { assertRequiredInputs, modeOf, shapeMismatch } from "./shape";

/**
 * `share = clamp(base, floor, ceiling) × rate`, rounded once with the table's declared mode.
 *
 * The clamp happens BEFORE the multiplication and the rounding happens ONCE, at the end — SAH-019's fix is "one
 * rounding function, explicit mode, applied at persist time", and rounding an intermediate would give two
 * implementations two answers.
 */
export const percentageWithCeiling: SchemeCalculator = {
  kind: "percentage_with_ceiling",
  compute(table, { base, profile }) {
    if (!("employee_rate" in table.table)) throw shapeMismatch(table, "employee_rate");
    assertRequiredInputs(table, profile);
    const t = table.table;
    const mode = modeOf(table);
    let value = base.toDecimal();
    if (t.floor !== null && t.floor !== undefined && value.lessThan(new D(t.floor))) {
      value = new D(t.floor);
    }
    if (t.ceiling !== null && value.greaterThan(new D(t.ceiling))) value = new D(t.ceiling);
    return {
      employeeShare: Money.fromDecimal(value.times(new D(t.employee_rate)), base.currency, mode),
      employerShare: Money.fromDecimal(value.times(new D(t.employer_rate)), base.currency, mode),
    };
  },
};

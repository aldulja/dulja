import { D, Money } from "../../src/index";
import { PayrollCalculationError } from "../errors";
import type { SchemeCalculator } from "../types";
import { assertRequiredInputs, modeOf, nameOf, shapeMismatch, within } from "./shape";

/**
 * A table of bands, each carrying the employee and employer amount for a base inside it. The band is half-open
 * `[from, to)`; `to: null` is the open top band. **Every figure comes out of `table`.**
 */
export const bandedContribution: SchemeCalculator = {
  kind: "banded_contribution",
  compute(table, { base, profile }) {
    if (!("bands" in table.table)) throw shapeMismatch(table, "bands");
    assertRequiredInputs(table, profile);
    const value = base.toDecimal();
    const band = table.table.bands.find((b) => within(value, b));
    if (band === undefined) {
      // A gap in the table is a gap, never a zero contribution. SAH-011 is exactly the failure where an absent
      // input becomes 0 and the figure is wrong for ever.
      throw new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `${nameOf(table)} has no band covering a base of ${base.toString()}; ` +
          "a contribution base outside every band is a gap in the table, never a zero contribution",
      );
    }
    const mode = modeOf(table);
    return {
      employeeShare: Money.fromDecimal(new D(band.employee), base.currency, mode),
      employerShare: Money.fromDecimal(new D(band.employer), base.currency, mode),
    };
  },
};

import type Decimal from "decimal.js";
import { D, type RoundingMode } from "../../src/index";
import { PayrollCalculationError } from "../errors";
import { RateTableValidationError } from "../validate";
import type { EmployeePeriodInput, RateTable } from "../types";

/**
 * The mode a table that omits the optional `rounding_mode` is rounded with — §4.2.1's base-conversion mode, so a
 * contribution rounds the way a base amount does (hazard 23). The run service copies the scheme row's own
 * `rounding_mode` into a definition that omits it, so this default is reached only by a direct caller.
 */
export const DEFAULT_ROUNDING_MODE: RoundingMode = "HALF_AWAY_FROM_ZERO";

export function modeOf(table: RateTable): RoundingMode {
  return table.rounding_mode ?? DEFAULT_ROUNDING_MODE;
}

/** `rate table SYNTH v1` — how every refusal names the table it was computing against. */
export function nameOf(table: RateTable): string {
  return `rate table ${table.scheme} v${table.version}`;
}

/**
 * The schema's `table` is a `oneOf` that does not depend on `kind`, so a definition whose `kind` and `table` disagree
 * validates. The calculator is where the pair is checked, and a mismatch is a refusal, never a read of `undefined`.
 */
export function shapeMismatch(table: RateTable, member: string): RateTableValidationError {
  return new RateTableValidationError([
    {
      path: "/table",
      message: `${nameOf(table)} is kind '${table.kind}' and its table has no '${member}'`,
    },
  ]);
}

/** A profile input the table needs, refused when null or absent — SAH-011: an absent input is never a zero. */
export function missingInput(
  table: RateTable,
  key: string,
  value: EmployeePeriodInput["statutoryProfile"][string] | undefined,
): PayrollCalculationError {
  return new PayrollCalculationError(
    "ERR_PAYROLL_INPUT_MISSING",
    `${nameOf(table)} requires statutory input '${key}' and the value is ${value === undefined ? "absent" : "null"}`,
  );
}

/** Every field the table declares in `required_profile_fields` (§4.12.3) must be present and non-null. */
export function assertRequiredInputs(
  table: RateTable,
  profile: EmployeePeriodInput["statutoryProfile"],
): void {
  for (const key of table.required_profile_fields ?? []) {
    const value = profile[key];
    if (value === undefined || value === null) throw missingInput(table, key, value);
  }
}

/** `[from, to)`, with `to: null` the open top — the one interval rule bands and brackets share. */
export function within(value: Decimal, range: { from: string; to: string | null }): boolean {
  return (
    value.greaterThanOrEqualTo(new D(range.from)) &&
    (range.to === null || value.lessThan(new D(range.to)))
  );
}

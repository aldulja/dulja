/**
 * `packages/db` may not import `@dulja/contracts` (contracts §3.1), so it cannot throw `AppError`.
 * This is the same declared exception `PostingError` is (§4.2.4): a named class carrying an existing
 * ErrCode string, which the route layer rethrows as an `AppError`. It introduces no new error code.
 */
export class ItemAccountUnresolvedError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(
    readonly accountCode: string,
    readonly companyId: string,
  ) {
    super(
      `account ${accountCode} is not in company ${companyId}'s chart: it is a §4.15 item default seeded ` +
        `by 0C's packages/db/seed/my/chart-of-accounts/0c-base.json — run \`bun run seed --tenant <id> ` +
        `--only chart-of-accounts\` before creating items`,
    );
    this.name = "ItemAccountUnresolvedError";
  }
}

/**
 * Raised when a line names a unit that has no conversion to the item's base unit (LEGACY-066). Declared HERE and
 * nowhere else: Task 6 raises it from `inventory/units.ts` and **imports** it from this module. One class, one
 * barrel line — a second `export class` of the same name re-exported from `packages/db/src/index.ts` is TS2308
 * at `bun run typecheck`.
 *
 * The message text is asserted verbatim by Task 6's `unit-conversion.test.ts` — the regular expression
 * `no unit conversion for item <dot-star> and unit <dot-star>` — so it is fixed here and the two never
 * drift. (The literal pattern is not spelled out with its metacharacters because `.` `*` `/` in that
 * order closes this block comment.)
 */
export class UnitConversionMissingError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(
    readonly itemId: string,
    readonly unitId: string,
  ) {
    super(
      `no unit conversion for item ${itemId} and unit ${unitId}, and it is not the item's base unit`,
    );
    this.name = "UnitConversionMissingError";
  }
}

export class ItemTaxCodeInvalidError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor() {
    super("Item tax code must be active and effective in this company.");
    this.name = "ItemTaxCodeInvalidError";
  }
}

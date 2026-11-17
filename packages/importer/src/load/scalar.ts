import {
  D,
  isCalendarDate,
  Money,
  MONEY_SCALE,
  Quantity,
  QUANTITY_SCALE,
  rational,
  round,
  type CurrencyCode,
  type Rational,
} from "@dulja/domain";
import type { LegacyRow } from "../legacy/types";
import { LoadError } from "./types";

/**
 * The ONE boundary between legacy text and Dulja types (9B plan N5). 9A's renderer casts every numeric and temporal
 * column to `varchar`, so a value arrives as exact text or NULL (§4.13.1); this is where it becomes `Money`,
 * `Quantity` or a calendar date, or is refused with the column and the value named.
 *
 * A decimal is a plain signed decimal with any number of fraction digits, or the same with an exponent — the form
 * Firebird gives when a `float` column (§4.13.1's `LegacyColumnKind`) is cast to `varchar`. decimal.js reads both
 * exactly; neither ever passes through a JavaScript `number` (spec:2041).
 */
const DECIMAL = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;
/** `YYYY-MM-DD` and `YYYY-MM-DD HH:MM:SS[.fraction]` — the two shapes a Firebird `date`/`timestamp` cast produces. */
const DATE = /^(\d{4}-\d{2}-\d{2})([T ]\d{2}:\d{2}:\d{2}(\.\d+)?)?$/;
/** numeric(19,4) holds fifteen integer digits. */
const MONEY_LIMIT = new D("1e15");

function text(row: LegacyRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "1" : "0";
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function decimal(row: LegacyRow, column: string, site: string, what: string) {
  const value = text(row, column);
  if (value === null)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is NULL; a NULL legacy ${what} is never read as zero (LEGACY-007, LEGACY-011)`,
    );
  if (!DECIMAL.test(value))
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${JSON.stringify(value)}, which is not a decimal`,
    );
  return { value, parsed: new D(value) };
}

/** A required text value, trimmed. Empty and NULL are both refused: the loader never guesses a value. */
export function requireText(row: LegacyRow, column: string, site: string): string {
  const value = text(row, column);
  if (value === null)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is empty; the loader will not guess a value (LEGACY-007)`,
    );
  return value;
}

/** An optional text value, trimmed; empty reads as NULL. */
export function optionalText(row: LegacyRow, column: string): string | null {
  return text(row, column);
}

/**
 * spec:2041 — a legacy amount becomes `Money` here or nowhere. A NULL is REFUSED, never coerced to zero: LEGACY-007 and
 * LEGACY-011 are exactly the defect of reading a NULL balance or cost as a zero one. A loader whose source may genuinely
 * lack the amount checks `optionalText` first and returns `{ skip }`, so the row reaches the skip register.
 *
 * Rounded once, at scale 4 and HALF_AWAY_FROM_ZERO, through the domain's one rounding function (LEGACY-019); the source
 * hash covers the raw text, so nothing is lost to the rounding. `currencyCode` is the COMPANY's base currency —
 * `baseCurrency()` inside a run — never a literal, so the `Money` a `map` mints and the `Money.zero` its `load` adds it
 * to are one type.
 */
export function moneyOf<C extends CurrencyCode>(
  row: LegacyRow,
  column: string,
  currencyCode: C,
  site: string,
): Money<C> {
  const { value, parsed } = decimal(row, column, site, "amount");
  const rounded = round(parsed, MONEY_SCALE, "HALF_AWAY_FROM_ZERO");
  if (rounded.abs().gte(MONEY_LIMIT))
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${value}, which does not fit numeric(19,4)`,
    );
  return Money.of(rounded.toFixed(MONEY_SCALE), currencyCode);
}

/** The same rule for a quantity, at scale 6 (numeric(19,6)). */
export function quantityOf(row: LegacyRow, column: string, site: string): Quantity {
  const { value, parsed } = decimal(row, column, site, "quantity");
  try {
    return Quantity.of(
      round(parsed, QUANTITY_SCALE, "HALF_AWAY_FROM_ZERO").toFixed(QUANTITY_SCALE),
    );
  } catch {
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${value}, which does not fit numeric(19,6)`,
    );
  }
}

function calendarDate(value: string, column: string, site: string): string {
  const match = DATE.exec(value);
  const day = match?.[1];
  // A shape check alone would take 2026-02-30; the domain's one calendar check does not (§3.2).
  if (day === undefined || !isCalendarDate(day))
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${JSON.stringify(value)}, which is not a YYYY-MM-DD date`,
    );
  return day;
}

/** The date half of a legacy `date` or `timestamp` — the calendar date as stored, never shifted by a time zone. */
export function dateOf(row: LegacyRow, column: string, site: string): string {
  return calendarDate(requireText(row, column, site), column, site);
}

export function optionalDateOf(row: LegacyRow, column: string, site: string): string | null {
  const value = text(row, column);
  return value === null ? null : calendarDate(value, column, site);
}

const TRUE_FLAGS: ReadonlySet<string> = new Set(["1", "T", "TRUE", "Y", "YES"]);
const FALSE_FLAGS: ReadonlySet<string> = new Set(["0", "F", "FALSE", "N", "NO"]);

/**
 * A legacy flag — a Firebird `D_BOOLEAN` or smallint cast to text (dossier §3.1: `IsCustomer`, `IsService`, …). NULL or
 * an absent column answers `null`, so the caller states its own default; any value outside the two closed sets is
 * REFUSED, never read as false — a flag of `2` silently turning a service into a product is LEGACY-007's shape.
 */
export function flagOf(row: LegacyRow, column: string, site: string): boolean | null {
  const value = text(row, column);
  if (value === null) return null;
  const upper = value.toUpperCase();
  if (TRUE_FLAGS.has(upper)) return true;
  if (FALSE_FLAGS.has(upper)) return false;
  throw new LoadError(
    "ERR_VALIDATION_FAILED",
    `${site}: ${column} is ${JSON.stringify(value)}, which is not a flag (1/0, T/F, Y/N, TRUE/FALSE, YES/NO)`,
  );
}

/** `app.unit_conversion`'s two `bigint` columns (0028). */
const BIGINT_MAX = 9_223_372_036_854_775_807n;
/** Beyond this many decimal places no factor can fit a bigint ratio; checked before any power of ten is built. */
const RATIO_SCALE_LIMIT = 40;

/**
 * LEGACY-066 — `MatUnits.Exchange` is `double precision` in the source while quantities are numeric(18,4), and nothing
 * rejected `Exchange = 0` or NULL. A legacy factor becomes Dulja's exact `Rational` (spec:2043; `app.unit_conversion`'s
 * `bigint` numerator and denominator) HERE and nowhere else, and never `Money` or a JavaScript `number`.
 *
 * The decimal text Firebird prints for the float is converted EXACTLY — `0.333333333333333` is
 * `333333333333333/10^15`, not `1/3`: the stored float is what the source holds, and recovering the ratio the operator
 * meant is a guess this boundary refuses to make (the owner enters the true ratio after cut-over). A NULL is refused,
 * never read as `1` (a silent identity is LEGACY-066 with a different sign); so is zero, a negative factor, and one whose
 * reduced ratio does not fit `bigint`. The scale, the comparison and the reduction are all `bigint` arithmetic.
 *
 * Not yet called by a registered loader: no MatUnits loader is registered until OD-17 names the table's material and
 * unit reference columns (9B Task 4 decisions). The rule is fixed now so that loader cannot choose another.
 */
export function rationalOf(row: LegacyRow, column: string, site: string): Rational {
  const value = text(row, column);
  if (value === null)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is NULL; a missing conversion factor is never read as 1 (LEGACY-066)`,
    );
  const parts = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!parts)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${JSON.stringify(value)}, which is not a decimal`,
    );
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = parts;
  const digits = BigInt(`${whole}${fraction}`);
  if (sign === "-" || digits === 0n)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is ${value}; a unit conversion factor must be positive (LEGACY-066)`,
    );
  const tooWide = new LoadError(
    "ERR_VALIDATION_FAILED",
    `${site}: ${column} is ${value}, which does not fit a bigint ratio (app.unit_conversion)`,
  );
  // value = digits × 10^(−scale)
  const scale = fraction.length - Number.parseInt(exponent, 10);
  if (Math.abs(scale) > RATIO_SCALE_LIMIT) throw tooWide;
  const ten = 10n ** BigInt(Math.abs(scale));
  const ratio = scale >= 0 ? rational(digits, ten) : rational(digits * ten, 1n);
  if (ratio.numerator > BIGINT_MAX || ratio.denominator > BIGINT_MAX) throw tooWide;
  return ratio;
}

/**
 * 9B T8 — `moneyOf` for a PAY figure (a year-to-date total, a payslip amount): the same rule — NULL refused, decimal
 * text only, rounded once at scale 4, numeric(19,4) or a refusal — with the value NEVER in the message. A refused
 * salary figure would otherwise be printed into `load-failed.json`, the job log and the operator's terminal; the row
 * and column are named, and the operator reads the figure in the legacy payroll.
 */
export function payMoneyOf<C extends CurrencyCode>(
  row: LegacyRow,
  column: string,
  currencyCode: C,
  site: string,
): Money<C> {
  const value = text(row, column);
  if (value === null)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is NULL; a NULL legacy pay figure is never read as zero (LEGACY-007)`,
    );
  const refused = new LoadError(
    "ERR_VALIDATION_FAILED",
    `${site}: ${column} is not a decimal numeric(19,4) can hold; it is a pay figure and is not printed — read it in the legacy payroll`,
  );
  if (!DECIMAL.test(value)) throw refused;
  const rounded = round(new D(value), MONEY_SCALE, "HALF_AWAY_FROM_ZERO");
  if (rounded.abs().gte(MONEY_LIMIT)) throw refused;
  return Money.of(rounded.toFixed(MONEY_SCALE), currencyCode);
}

/** The longest value 8A's sensitive text fields accept (`EmployeeSensitiveSchema`'s `z.string().max(120)`). */
export const SENSITIVE_TEXT_LIMIT = 120;

/**
 * 9B T8 — an optional value bound for 8A's `employee_sensitive` (§4.12.5). `date` takes a legacy `date` or `timestamp`
 * and answers its calendar date (the wire's `DateSchema`); `text` takes at most `SENSITIVE_TEXT_LIMIT` characters (the
 * wire's limit), so a value the HR screen could never read back is refused here rather than sealed. A refusal names
 * the row and the column and NEVER the value (spec:2076, acceptance test 32): a national id or a date of birth in an
 * error message would reach `load-failed.json`, the job log and the terminal.
 */
export function sensitiveOf(
  row: LegacyRow,
  column: string,
  site: string,
  shape: "text" | "date",
): string | null {
  const value = text(row, column);
  if (value === null) return null;
  if (shape === "date") {
    const day = DATE.exec(value)?.[1];
    if (day === undefined || !isCalendarDate(day))
      throw new LoadError(
        "ERR_VALIDATION_FAILED",
        `${site}: ${column} is not a YYYY-MM-DD date; it is a sensitive field (§4.12.5) and is not printed`,
      );
    return day;
  }
  if (value.length > SENSITIVE_TEXT_LIMIT)
    throw new LoadError(
      "ERR_VALIDATION_FAILED",
      `${site}: ${column} is longer than ${SENSITIVE_TEXT_LIMIT} characters; it is a sensitive field (§4.12.5) and is not printed`,
    );
  return value;
}

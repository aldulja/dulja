import type Decimal from "decimal.js";
import { D } from "./decimal";
import type { Rational } from "./rational";
import { QUANTITY_SCALE, round, type RoundingMode } from "./rounding";

const AMOUNT = /^-?\d+(\.\d{1,6})?$/;
const MAX_VALUE = new D("9999999999999.999999");

/** Opaque quantity at QUANTITY_SCALE, in the item's base unit (spec §3.9). */
export class Quantity {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    if (!value.isFinite() || value.abs().greaterThan(MAX_VALUE)) {
      throw new RangeError("Quantity: value is outside numeric(19,6)");
    }
    this.value = new D(value);
    Object.freeze(this);
  }

  static of(value: string): Quantity {
    if (!AMOUNT.test(value)) {
      throw new RangeError(
        `Quantity.of(): '${value}' is not a decimal with at most ${QUANTITY_SCALE} decimal places`,
      );
    }
    return new Quantity(new D(value).toDecimalPlaces(QUANTITY_SCALE));
  }

  static zero(): Quantity {
    return new Quantity(new D(0));
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.value.plus(other.value));
  }
  subtract(other: Quantity): Quantity {
    return new Quantity(this.value.minus(other.value));
  }
  negate(): Quantity {
    return new Quantity(this.value.negated());
  }

  multiply(factor: Rational | Decimal | string, mode: RoundingMode): Quantity {
    const decimal =
      typeof factor === "string"
        ? new D(factor)
        : "numerator" in factor
          ? new D(factor.numerator.toString()).div(new D(factor.denominator.toString()))
          : new D(factor);
    if (!decimal.isFinite()) {
      throw new RangeError("Quantity.multiply(): factor must be finite");
    }
    return new Quantity(round(this.value.times(decimal), QUANTITY_SCALE, mode));
  }

  /** Exact conversion, rounded HALF_EVEN to six decimal places only at the end (spec §3.9). */
  convert(conversion: Rational): Quantity {
    const exact = this.value
      .times(new D(conversion.numerator.toString()))
      .div(new D(conversion.denominator.toString()));
    return new Quantity(round(exact, QUANTITY_SCALE, "HALF_EVEN"));
  }

  compare(other: Quantity): -1 | 0 | 1 {
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }
  isZero(): boolean {
    return this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }
  toDecimal(): Decimal {
    return new D(this.value);
  }
  /** Fixed 6 dp — the SQL literal. */
  toString(): string {
    return this.value.toFixed(QUANTITY_SCALE);
  }
  /** Wire form: a string (§4.2.8 QuantitySchema). */
  toJSON(): string {
    return this.toString();
  }
}

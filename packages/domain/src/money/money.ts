import type Decimal from "decimal.js";
import { D } from "./decimal";
import type { Rational } from "./rational";
import { MONEY_SCALE, round, type RoundingMode } from "./rounding";

/** ISO 4217 code, upper case, exactly three letters. */
export type CurrencyCode = string & { readonly __brand: "CurrencyCode" };

export class MoneyCurrencyInvalidError extends Error {
  readonly code = "ERR_MONEY_CURRENCY_INVALID" as const;

  constructor(code: string) {
    super(`ERR_MONEY_CURRENCY_INVALID: '${code}' is not a three-letter upper-case ISO 4217 code`);
    this.name = "MoneyCurrencyInvalidError";
  }
}

export class MoneyCurrencyMismatchError extends Error {
  readonly code = "ERR_MONEY_CURRENCY_MISMATCH" as const;

  constructor(left: string, right: string) {
    super(`ERR_MONEY_CURRENCY_MISMATCH: cannot combine ${left} with ${right}`);
    this.name = "MoneyCurrencyMismatchError";
  }
}

export class MoneyScaleError extends Error {
  readonly code = "ERR_MONEY_SCALE" as const;

  constructor(amount: string) {
    super(
      `ERR_MONEY_SCALE: '${amount}' is not a decimal amount with at most ${MONEY_SCALE} decimal places`,
    );
    this.name = "MoneyScaleError";
  }
}

/** Preserves a literal currency code for compile-time currency separation. */
export function currency<const S extends string>(code: S): CurrencyCode & S {
  if (!/^[A-Z]{3}$/.test(code)) throw new MoneyCurrencyInvalidError(code);
  return code as CurrencyCode & S;
}

/** Amounts on the wire and in SQL literals: an optional sign, digits, an optional fraction of at most 4 places. */
const AMOUNT = /^-?\d+(\.\d{1,4})?$/;

/** Opaque, immutable, always at MONEY_SCALE. `C` is the currency literal when known at compile time. */
export class Money<C extends CurrencyCode = CurrencyCode> {
  readonly currency: C;

  private constructor(
    code: C,
    private readonly value: Decimal,
  ) {
    this.currency = code;
    Object.freeze(this);
  }

  static of<C extends CurrencyCode>(amount: string, code: C): Money<C> {
    if (!AMOUNT.test(amount)) throw new MoneyScaleError(amount);
    return new Money(code, new D(amount).toDecimalPlaces(MONEY_SCALE));
  }

  static zero<C extends CurrencyCode>(code: C): Money<C> {
    return new Money(code, new D(0));
  }

  static fromDecimal<C extends CurrencyCode>(
    value: Decimal,
    code: C,
    mode: RoundingMode,
  ): Money<C> {
    return new Money(code, round(value, MONEY_SCALE, mode));
  }

  static fromJSON(json: { amount: string; currency: string }): Money {
    return Money.of(json.amount, currency(json.currency));
  }

  private same(other: Money<C>): void {
    if ((this.currency as string) !== (other.currency as string)) {
      throw new MoneyCurrencyMismatchError(this.currency as string, other.currency as string);
    }
  }

  private with(value: Decimal): Money<C> {
    return new Money(this.currency, value);
  }

  add(other: Money<C>): Money<C> {
    this.same(other);
    return this.with(this.value.plus(other.value));
  }

  subtract(other: Money<C>): Money<C> {
    this.same(other);
    return this.with(this.value.minus(other.value));
  }

  negate(): Money<C> {
    return this.with(this.value.negated());
  }
  abs(): Money<C> {
    return this.with(this.value.abs());
  }

  /** Explicit rounding, never implicit (ADR 0008). */
  multiply(factor: Decimal | Rational | string, mode: RoundingMode): Money<C> {
    return this.with(round(this.value.times(toDecimal(factor)), MONEY_SCALE, mode));
  }

  divide(divisor: Decimal | Rational | string, mode: RoundingMode): Money<C> {
    const decimal = toDecimal(divisor);
    if (decimal.isZero()) throw new RangeError("Money.divide(): divisor is zero");
    return this.with(round(this.value.div(decimal), MONEY_SCALE, mode));
  }

  /** Largest-remainder allocation (ADR 0008). Σ result === this, exactly, for every input. */
  allocate(weights: readonly bigint[], mode: RoundingMode): Money<C>[] {
    if (weights.length === 0) throw new RangeError("Money.allocate(): weights must not be empty");
    if (weights.some((weight) => weight < 0n))
      throw new RangeError("Money.allocate(): a weight cannot be negative");
    const total = weights.reduce((left, right) => left + right, 0n);
    if (total === 0n) throw new RangeError("Money.allocate(): the weights sum to zero");

    const sum = new D(total.toString());
    const exact = weights.map((weight) => this.value.times(new D(weight.toString())).div(sum));
    const shares = exact.map((value) => round(value, MONEY_SCALE, mode));
    const unit = new D(1).div(new D(10).pow(MONEY_SCALE));
    let residue = this.value.minus(shares.reduce((left, right) => left.plus(right), new D(0)));
    const step = residue.isNegative() ? unit.negated() : unit;
    const order = exact
      .map((value, index) => ({ index, remainder: value.minus(shares[index]!) }))
      .toSorted(
        (left, right) =>
          (residue.isNegative()
            ? left.remainder.comparedTo(right.remainder)
            : right.remainder.comparedTo(left.remainder)) || left.index - right.index,
      )
      .map(({ index }) => index);

    for (let index = 0; !residue.isZero(); index += 1) {
      const share = order[index % order.length]!;
      shares[share] = shares[share]!.plus(step);
      residue = residue.minus(step);
    }
    return shares.map((share) => this.with(share));
  }

  compare(other: Money<C>): -1 | 0 | 1 {
    this.same(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Money<C>): boolean {
    return (
      (this.currency as string) === (other.currency as string) && this.value.equals(other.value)
    );
  }

  isZero(): boolean {
    return this.value.isZero();
  }
  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }
  toDecimal(): Decimal {
    return new D(this.value);
  }
  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }
  toJSON(): { amount: string; currency: C } {
    return { amount: this.toString(), currency: this.currency };
  }
}

function toDecimal(value: Decimal | Rational | string): Decimal {
  if (typeof value === "string") return new D(value);
  if (typeof value === "object" && "numerator" in value) {
    return new D(value.numerator.toString()).div(new D(value.denominator.toString()));
  }
  return new D(value);
}

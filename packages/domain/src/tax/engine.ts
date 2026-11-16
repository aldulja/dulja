// packages/domain/src/tax/engine.ts
import Decimal from "decimal.js";
import { Money } from "../money/money";
import { rational, type Rational } from "../money/rational";
import type { RoundingMode } from "../money/rounding";

/** Contracts §4.9.1, verbatim. */
export interface TaxRegime {
  readonly id: string;
  readonly code: string;
  readonly jurisdiction: "MY";
  readonly version: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** Contracts §4.9.1, verbatim. A field-for-field superset of §4.4.2's `TaxCodeRef`, which it therefore
 *  satisfies STRUCTURALLY — `loadSnapshot` puts these objects straight into `snapshot.refs.taxCodes` and
 *  nothing converts between the two (§4.4.2's closing note). */
export interface TaxCodeDef {
  readonly id: string;
  readonly regimeId: string;
  readonly code: string;
  /** Decimal fraction at RATE_SCALE (8 dp), represented as a decimal string rather than a number —
   *  `no-number-money` (§3.7.5) matches /rate|tax/i and a float rate is LEGACY-019's arithmetic. */
  readonly rate: string;
  readonly kind: "output" | "input" | "exempt" | "zero" | "out_of_scope";
  readonly roundingMode: RoundingMode;
  readonly outputAccountId: string | null;
  readonly inputAccountId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface TaxLineInput {
  readonly lineNo: number;
  /** Excl. or incl. of tax per `inclusive`. Signed: a credit note's line is negative. */
  readonly amount: Money;
  readonly taxCode: TaxCodeDef;
  readonly inclusive: boolean;
}
export interface TaxLineResult {
  readonly lineNo: number;
  readonly base: Money;
  readonly tax: Money;
  readonly taxCode: TaxCodeDef;
}

export interface TaxEngine {
  /** Pure. Applies each code's rate with its own declared rounding mode (spec:2228) and refuses a code whose
   *  regime is not the document's regime, or whose effective range falls outside the regime's window —
   *  which has an OPEN upper bound while `regime.effectiveTo` is null, so successive rates inside one live
   *  regime are accepted and only a code past a CLOSED regime's end is refused (LEGACY-020, spec:2227). */
  compute(regime: TaxRegime, lines: TaxLineInput[]): TaxLineResult[];
}

export class TaxError extends Error {
  constructor(
    readonly code: "ERR_TAX_REGIME_MISMATCH",
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TaxError";
  }
}

/** `exempt`, `zero` and `out_of_scope` produce no tax. Exported because the RETURN needs the distinction —
 *  an exempt supply has its own box and an out-of-scope one has none — and two spellings of this predicate
 *  would put one sale in two boxes. */
export function producesNoTax(kind: TaxCodeDef["kind"]): boolean {
  return kind === "exempt" || kind === "zero" || kind === "out_of_scope";
}

/** `rate / (1 + rate)` as an exact fraction. A rate is a decimal string at RATE_SCALE (8 dp), so it is
 *  `n / 10^k` and the fraction is `n / (10^k + n)` — no division happens before `Money.multiply`'s one rounding
 *  call, which is what lets a directed mode round the tax and nothing else. */
function inclusiveTaxFraction(rate: string): Rational {
  const [whole, frac = ""] = rate.split(".");
  const scale = 10n ** BigInt(frac.length);
  const n = BigInt(`${whole}${frac}`);
  return rational(n, scale + n);
}

function assertRegime(regime: TaxRegime, line: TaxLineInput): void {
  const c = line.taxCode;
  if (c.regimeId !== regime.id) {
    throw new TaxError(
      "ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} belongs to regime ${c.regimeId}, ` +
        `not to ${regime.code} v${regime.version} (${regime.id})`,
    );
  }
  // A code must fall INSIDE the regime's window: not starting after the window CLOSES, and not lapsed
  // before it opens. Dates are ISO `YYYY-MM-DD`, so a lexicographic comparison IS a chronological one.
  //
  // The upper bound is OPEN when `effectiveTo` is null, and that is the whole point of spec:2227's
  // "versioned regimes with rate-effective-date tables": a live regime runs indefinitely and a rate change
  // is a NEW code at a NEW `effective_from` inside it — which is what `unique (company_id, code,
  // effective_from)` (0053) exists for and what makes January's return unmovable after February's rate
  // lands (T11 Step 1). Comparing against `effectiveTo ?? effectiveFrom` would collapse an open regime's
  // window to its first day and refuse every code effective after it, so `SYNTH-MY-v1` — whose
  // `effective_to` IS null — could never carry a second rate at all.
  const until = regime.effectiveTo;
  if (until !== null && c.effectiveFrom > until) {
    throw new TaxError(
      "ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} is effective since ${c.effectiveFrom}, after regime ${regime.code} v${regime.version} ended (${until})`,
    );
  }
  if (c.effectiveTo !== null && c.effectiveTo < regime.effectiveFrom) {
    throw new TaxError(
      "ERR_TAX_REGIME_MISMATCH",
      `line ${line.lineNo}: tax code ${c.code} lapsed on ${c.effectiveTo}, ` +
        `before regime ${regime.code} v${regime.version} (${regime.effectiveFrom})`,
    );
  }
}

/**
 * The ONE tax computation in the system.
 *
 * Exclusive: `base` is the entered amount and `tax = round(base x rate, 4, code.roundingMode)`.
 * Inclusive: `tax = round(amount x rate / (1 + rate), 4, code.roundingMode)` and `base = amount - tax`, so
 * `base + tax === amount` EXACTLY at 4 dp for every rate, and the declared mode rounds the TAX in its own
 * direction, as on an exclusive line (MON-12; ADR 0050's 2026-11-15 amendment). Rounding both halves
 * independently would leave a residue on every line, which is what makes an inclusive invoice fail to balance.
 *
 * `Money.multiply` / `Money.divide` require an explicit `RoundingMode` (§4.2.1) and are symmetric across
 * sign, so LEGACY-019's `+6 -> 10 / -6 -> -5` asymmetry cannot recur and a negative credit-note line produces
 * exactly the negated figures of its positive twin.
 */
export function computeTaxLine(line: TaxLineInput): TaxLineResult {
  const c = line.taxCode;
  const rate = new Decimal(c.rate);
  if (producesNoTax(c.kind) || rate.isZero()) {
    return {
      lineNo: line.lineNo,
      base: line.amount,
      tax: Money.zero(line.amount.currency),
      taxCode: c,
    };
  }
  if (line.inclusive) {
    // MON-12: the code's mode rounds the TAX — `amount x rate / (1 + rate)` — and the base is the remainder.
    // Rounding the base in that mode instead rounded the tax the other way for TOWARD_ZERO and
    // AWAY_FROM_ZERO. `rateFraction` is exact (no division before the one rounding call).
    const tax = line.amount.multiply(inclusiveTaxFraction(c.rate), c.roundingMode);
    return { lineNo: line.lineNo, base: line.amount.subtract(tax), tax, taxCode: c };
  }
  return {
    lineNo: line.lineNo,
    base: line.amount,
    tax: line.amount.multiply(rate, c.roundingMode),
    taxCode: c,
  };
}

export const taxEngine: TaxEngine = {
  compute(regime, lines) {
    return lines.map((line) => {
      assertRegime(regime, line);
      return computeTaxLine(line);
    });
  },
};

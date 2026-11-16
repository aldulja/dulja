import { D, Money, type CurrencyCode } from "../src/index";
import { PayrollCalculationError } from "./errors";
import { eligibleDays, periodDays } from "./period";
import { calculators } from "./schemes";
import { modeOf } from "./schemes/shape";
import type {
  EmployeePeriodInput,
  EmployeeResult,
  PayPeriod,
  PayrollCalculator,
  RateTableRef,
  SchemeResult,
} from "./types";

/** The base-conversion mode of §4.2.1, reused so a prorated amount rounds the way a base amount does (hazard 23). */
const PRORATION_MODE = "HALF_AWAY_FROM_ZERO" as const;

/** The `ytdBefore` / `ytdAfter` key space, as two functions so 8C's projection and 8D's statements agree. */
export function ytdKey(part: "gross" | "net"): string {
  return part;
}
export function schemeYtdKey(schemeCode: string, share: "employee" | "employer"): string {
  return `${schemeCode}.${share}`;
}

export { eligibleDays, periodDays };

/**
 * The exact proration factor as a numerator/denominator pair — never a float (spec:2043's discipline). A period in
 * which the rule counts no day at all (a weekend under `working_days`) is refused: there is nothing to divide by.
 */
export function prorationFactor(
  period: PayPeriod,
  e: Pick<EmployeePeriodInput, "hiredOn" | "terminatedOn">,
): { numerator: number; denominator: number } {
  const denominator = periodDays(period);
  if (denominator === 0) {
    throw new RangeError(
      `pay period ${period.start}..${period.end} holds no day under the ${period.prorationRule} rule`,
    );
  }
  return { numerator: eligibleDays(period, e.hiredOn, e.terminatedOn), denominator };
}

function coversPeriod(ref: RateTableRef, period: PayPeriod): boolean {
  // ISO dates compare lexically; both ends of the table's range are inclusive.
  return (
    ref.effectiveFrom <= period.start && (ref.effectiveTo === null || ref.effectiveTo >= period.end)
  );
}

/**
 * The one payroll calculator. Pure: no clock, no I/O, no randomness, and **not one rate** (spec:2080).
 *
 * Order of operations, fixed here because a golden fixture pins it (test 33):
 *   1. every supplied rate table is checked for `verified` and for covering the period — the WHOLE run refuses on
 *      the first failure, because a run that computed some employees and refused others would leave a half-payroll;
 *   2. per employee: every component's inputs, then the currency, then the proration factor; each earning and
 *      deduction resolved to a period amount;
 *   3. per scheme the employee's earnings feed: the base is the sum of the EARNINGS joined to that scheme less the
 *      DEDUCTIONS joined to it (RC-3, spec:2079 — never a "subject to X" boolean and never the whole gross; HRP-03);
 *   4. the scheme's calculator computes the two shares from its table; a refusal there is re-raised naming the
 *      employee (test 33);
 *   5. a manual override replaces the computed share for that (scheme, share) and nothing else (spec:2087); an
 *      override on a scheme the employee does not contribute to refuses rather than vanishing;
 *   6. net = gross − deductions − employee shares. The employer share never touches net;
 *   7. `ytdAfter` = `ytdBefore` + this run, under `ytdKey` / `schemeYtdKey`.
 */
export const payrollCalculator: PayrollCalculator = {
  calculate({ period, employees, rateTables, ytdBefore }) {
    // ── 1. the table gate, before a single figure is computed ────────────────────────────────────────────────────
    for (const ref of rateTables) {
      if (!ref.verified) {
        throw new PayrollCalculationError(
          "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
          `rate table ${ref.schemeCode} v${ref.version} is not verified; a payroll run cannot pin an unverified table (spec:2080)`,
        );
      }
      if (!coversPeriod(ref, period)) {
        throw new PayrollCalculationError(
          "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
          `rate table ${ref.schemeCode} v${ref.version} is effective ${ref.effectiveFrom}..${ref.effectiveTo ?? "open"} ` +
            `and does not cover the pay period ${period.start}..${period.end}`,
        );
      }
    }
    const bySchemeId = new Map(rateTables.map((r) => [r.schemeId, r]));

    const results: EmployeeResult[] = [];
    const pinned = new Map<string, number>();

    for (const e of employees) {
      // The per-component input gate runs BEFORE the currency is derived, and the order is load-bearing: an
      // employee whose only line is a quantity with no per-unit rate has no amount to take a currency from, so the
      // other order raises the generic refusal and BURIES the one SAH-011 asks for — naming the component.
      assertComponentInputs(e);
      const currency = firstCurrency(e);
      const zero = Money.zero(currency);
      const { numerator, denominator } = prorationFactor(period, e);
      const factor = new D(numerator).dividedBy(new D(denominator));

      // ── 2. earnings and deductions ───────────────────────────────────────────────────────────────────────────
      const earnings: { componentId: string; amount: Money }[] = [];
      const deductions: { componentId: string; amount: Money }[] = [];
      const baseByScheme = new Map<string, Money>();

      for (const c of e.compensation) {
        // Unreachable after `assertComponentInputs`; it narrows `c.amount` and keeps a caller that skips the gate
        // refusing rather than computing on a null.
        if (c.amount === null) throw missingInput(e, c);
        // A quantity-based component: `amount` is the PER-UNIT rate and the quantity is the input (days of unpaid
        // leave, hours). It is NOT prorated — the quantity already says how much of the period it covers.
        const amount =
          c.quantity === null
            ? c.amount.multiply(factor, PRORATION_MODE)
            : c.amount.multiply(c.quantity.toDecimal(), PRORATION_MODE);

        if (c.kind === "earning") {
          earnings.push({ componentId: c.componentId, amount });
          for (const schemeId of c.schemeIds) {
            baseByScheme.set(schemeId, (baseByScheme.get(schemeId) ?? zero).add(amount));
          }
        } else {
          deductions.push({ componentId: c.componentId, amount });
        }
      }

      // A DEDUCTION joined to a scheme reduces that scheme's base (HRP-03): the join table says which components a
      // scheme is computed on, of either kind (RC-3), so unpaid leave joined to a scheme is charged on the reduced
      // wage. Applied after every earning, so the scheme order stays the order the EARNINGS named them. A deduction
      // joined to a scheme no earning feeds, or joined deductions exceeding the joined earnings, refuse naming the
      // employee: the engine never invents a contribution and never computes on a negative base (spec:2087).
      for (const d of deductions) {
        const joined = e.compensation.find((c) => c.componentId === d.componentId)?.schemeIds ?? [];
        for (const schemeId of joined) {
          const base = baseByScheme.get(schemeId);
          if (base === undefined) {
            throw new PayrollCalculationError(
              "ERR_PAYROLL_INPUT_MISSING",
              `employee ${e.employeeId} has deduction ${d.componentId} joined to scheme ${schemeId} and no earning ` +
                "feeding that scheme; join an earning to the scheme or remove the deduction's join",
            );
          }
          baseByScheme.set(schemeId, base.subtract(d.amount));
        }
      }
      for (const [schemeId, base] of baseByScheme) {
        if (base.isNegative()) {
          throw new PayrollCalculationError(
            "ERR_PAYROLL_INPUT_MISSING",
            `employee ${e.employeeId}'s base for scheme ${schemeId} is ${base.toString()}: the deductions joined to ` +
              "it exceed the earnings joined to it",
          );
        }
      }

      for (const o of e.manualOverrides) {
        if (!baseByScheme.has(o.schemeId)) {
          throw new PayrollCalculationError(
            "ERR_PAYROLL_INPUT_MISSING",
            `employee ${e.employeeId} has a manual ${o.share} override on scheme ${o.schemeId} and no earning ` +
              "feeding that scheme; remove the override or join a component to the scheme",
          );
        }
      }

      const gross = earnings.reduce((acc, x) => acc.add(x.amount), zero);

      // ── 3–5. schemes, in the order the employee's components named them ──────────────────────────────────────
      const schemes: SchemeResult[] = [];
      for (const [schemeId, base] of baseByScheme) {
        const ref = bySchemeId.get(schemeId);
        if (ref === undefined) {
          throw new PayrollCalculationError(
            "ERR_PAYROLL_RATE_TABLE_UNVERIFIED",
            `employee ${e.employeeId} contributes to scheme ${schemeId} and no rate table was supplied for it ` +
              `covering ${period.start}..${period.end}`,
          );
        }
        let { employeeShare, employerShare } = computeScheme(e, ref, base, period, ytdBefore);
        for (const o of e.manualOverrides) {
          if (o.schemeId !== schemeId) continue;
          if (o.share === "employee") employeeShare = o.amount;
          else employerShare = o.amount;
        }
        schemes.push({
          schemeId,
          schemeCode: ref.schemeCode,
          rateTableVersion: ref.version,
          employeeShare,
          employerShare,
          base,
          roundingMode: modeOf(ref.definition),
        });
        pinned.set(schemeId, ref.version);
      }

      // ── 6. net ───────────────────────────────────────────────────────────────────────────────────────────────
      const deducted = deductions.reduce((acc, x) => acc.add(x.amount), zero);
      const employeeShares = schemes.reduce((acc, s) => acc.add(s.employeeShare), zero);
      const net = gross.subtract(deducted).subtract(employeeShares);

      // ── 7. ytdAfter ──────────────────────────────────────────────────────────────────────────────────────────
      const ytdAfter: Record<string, Money> = { ...ytdBefore[e.employeeId] };
      const bump = (key: string, by: Money): void => {
        ytdAfter[key] = (ytdAfter[key] ?? Money.zero(by.currency)).add(by);
      };
      bump(ytdKey("gross"), gross);
      bump(ytdKey("net"), net);
      for (const s of schemes) {
        bump(schemeYtdKey(s.schemeCode, "employee"), s.employeeShare);
        bump(schemeYtdKey(s.schemeCode, "employer"), s.employerShare);
      }

      results.push({
        employeeId: e.employeeId,
        gross,
        earnings,
        deductions,
        schemes,
        net,
        ytdAfter,
      });
    }

    return {
      employees: results,
      // Deterministic order: the map preserves insertion, which is the order employees named their schemes, and a
      // golden fixture byte-compares this array (test 29).
      pinnedTables: [...pinned].map(([schemeId, version]) => ({ schemeId, version })),
    };
  },
};

/** One scheme's two shares from its table. A refusal inside the scheme calculator names the table and the field; it
 *  is re-raised here naming the employee too, because test 33's clause is "fails the run naming the employee". */
function computeScheme(
  e: EmployeePeriodInput,
  ref: RateTableRef,
  base: Money,
  period: PayPeriod,
  ytdBefore: Record<string, Record<string, Money>>,
): { employeeShare: Money; employerShare: Money } {
  try {
    return calculators[ref.definition.kind].compute(ref.definition, {
      base,
      profile: e.statutoryProfile,
      ytd: ytdBefore[e.employeeId] ?? {},
      period,
    });
  } catch (error) {
    if (error instanceof PayrollCalculationError) {
      throw new PayrollCalculationError(error.code, `employee ${e.employeeId}: ${error.detail}`);
    }
    throw error;
  }
}

type CompensationLine = EmployeePeriodInput["compensation"][number];

/**
 * The exact `ERR_PAYROLL_INPUT_MISSING` message for a component with no usable amount (SAH-011, test 33). ONE
 * function, so the pre-pass and the narrowing throw inside the loop cannot spell one refusal two ways.
 */
function missingInput(e: EmployeePeriodInput, c: CompensationLine): PayrollCalculationError {
  return c.quantity === null
    ? new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `employee ${e.employeeId} has component ${c.componentId} with neither an amount nor a quantity`,
      )
    : new PayrollCalculationError(
        "ERR_PAYROLL_INPUT_MISSING",
        `employee ${e.employeeId} has a quantity of ${c.quantity.toString()} on component ${c.componentId} ` +
          "and no per-unit amount; a quantity without a rate is not a zero line",
      );
}

/** Every component of one employee, checked before any figure — including the currency — is derived. */
function assertComponentInputs(e: EmployeePeriodInput): void {
  for (const c of e.compensation) if (c.amount === null) throw missingInput(e, c);
}

/**
 * The currency every figure of one employee is in. v1 payroll is single-currency (spec:2094 puts multi-currency
 * payroll out of v1), but `Money` carries its currency and a zero has to be minted in SOME currency, so it is taken
 * from the first compensation line rather than assumed. After `assertComponentInputs` its refusal is reachable only
 * for an employee with no compensation at all.
 */
function firstCurrency(e: EmployeePeriodInput): CurrencyCode {
  const withAmount = e.compensation.find((c) => c.amount !== null);
  if (withAmount?.amount == null) {
    throw new PayrollCalculationError(
      "ERR_PAYROLL_INPUT_MISSING",
      `employee ${e.employeeId} has no compensation line carrying an amount; a run cannot compute a currency out of nothing`,
    );
  }
  return withAmount.amount.currency;
}

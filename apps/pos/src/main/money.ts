import { Money, Quantity, type CurrencyCode, currency } from "@dulja/domain";

/**
 * The ONE place a `TEXT` column becomes a domain value and back, at the till.
 *
 * It exists because `no-number-money` (§3.7.5) scans `apps/**` and because SQLite has no decimal type: a
 * money column is `TEXT` at fixed 4 dp, a quantity `TEXT` at fixed 6 dp, a revision `TEXT` holding a
 * decimal integer. Two spellings of these six functions would be two chances to drop a digit.
 */
export function moneyToText(m: Money): string {
  return m.toString();
} // fixed 4 dp
export function textToMoney(t: string, c: CurrencyCode): Money {
  return Money.of(t, c);
}
export function quantityToText(q: Quantity): string {
  return q.toString();
} // fixed 6 dp
export function textToQuantity(t: string): Quantity {
  return Quantity.of(t);
}

/** A revision is a decimal string, never an SQLite INTEGER (ADR 0057, A8b). */
export function revisionToText(r: bigint): string {
  if (r < 0n || r > 9223372036854775807n)
    throw new RangeError("revision outside PostgreSQL bigint range");
  return r.toString(10);
}
export function textToRevision(t: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(t)) throw new RangeError(`not a revision: ${JSON.stringify(t)}`);
  const revision = BigInt(t);
  revisionToText(revision);
  return revision;
}

/** The wire form of §4.10.1: `{ amount, currency }`, which is `Money.toJSON()`. */
export function moneyJson(m: Money): { amount: string; currency: string } {
  return m.toJSON();
}
export function fromMoneyJson(j: { amount: string; currency: string }): Money {
  return Money.of(j.amount, currency(j.currency));
}

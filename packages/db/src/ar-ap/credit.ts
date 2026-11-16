import { Money, currency } from "@dulja/domain";
import type { Sql } from "postgres";

/**
 * contracts §4.8.1 — a party's credit position as the control computes it. Every figure is in the COMPANY'S
 * BASE currency: `party.credit_limit` is one bare `numeric(19,4)` per party while a party may be invoiced in
 * several currencies, so a comparison in any other currency would be SAH-014 in a new place.
 */
export interface CreditStatus {
  partyId: string;
  /** null = no limit configured, which is not a zero limit. */
  creditLimit: Money | null;
  creditHold: boolean;
  /** The party's POSTED receivable in BASE currency, every date — `app.party_open_balance(party, null)`. */
  openBase: Money;
  /** The party's issued-but-unposted outbound documents, in base: the part of the exposure the ledger does not
   *  hold yet. `exposureBase − openBase`. */
  pendingBase: Money;
  /** What the control compares a new sale with — `app.party_credit_exposure`: posted, with no date cut, plus
   *  pending (Phase 4 review A6). */
  exposureBase: Money;
  /** limit − exposure, in base; null when there is no limit. */
  headroomBase: Money | null;
}

/**
 * The read behind the credit screen and the route pre-flight. It calls `app.party_open_balance` and
 * `app.party_credit_exposure` — the SAME functions `app.assert_credit_available()` calls — so a screen can
 * never disagree with the control (spec:2173). Base currency throughout: one limit per party, several invoice
 * currencies (SAH-014).
 *
 * There is no `asOf`: the control measures a sale against everything posted and everything issued, whatever
 * its date (A6), so a dated figure here would be a second answer to the question the trigger asks.
 *
 * It therefore inherits those functions' fail-closed behaviour: a party carrying a `credit_limit` with no
 * `receivable_account_id` raises `ERR_POLICY_REQUIRES_MISSING` here too, rather than showing a headroom
 * figure the control would not honour. Surfacing the misconfiguration on the screen is the point — a
 * screen that reported full headroom while the trigger refused the sale is two answers to one question.
 */
export async function creditStatus(tx: Sql, input: { partyId: string }): Promise<CreditStatus> {
  const [row] = await tx<
    {
      creditLimit: string | null;
      creditHold: boolean;
      openBase: string;
      exposureBase: string;
      baseCurrency: string;
    }[]
  >`
    select p.credit_limit::text                                                  as "creditLimit",
           p.credit_hold                                                         as "creditHold",
           app.party_open_balance(p.id, null)::numeric(19,4)::text               as "openBase",
           app.party_credit_exposure(p.id, null)::numeric(19,4)::text            as "exposureBase",
           c.base_currency                                                       as "baseCurrency"
      from app.party p
      join app.company c on c.id = p.company_id
     where p.id = ${input.partyId}`;
  if (row === undefined) {
    // `packages/db` may not import `@dulja/contracts` (§3.1): a thrown error carrying an existing ErrCode as
    // `code` is what the API's `fromDomainError` lifts — the shape payment-term.ts and 3A's errors use.
    throw Object.assign(new Error(`ERR_NOT_FOUND: party ${input.partyId} is not visible`), {
      code: "ERR_NOT_FOUND" as const,
    });
  }

  const base = currency(row.baseCurrency.trim());
  const openBase = Money.of(row.openBase, base);
  const exposureBase = Money.of(row.exposureBase, base);
  const creditLimit = row.creditLimit === null ? null : Money.of(row.creditLimit, base);
  return {
    partyId: input.partyId,
    creditLimit,
    creditHold: row.creditHold,
    openBase,
    pendingBase: exposureBase.subtract(openBase),
    exposureBase,
    headroomBase: creditLimit === null ? null : creditLimit.subtract(exposureBase),
  };
}

import type { Sql } from "postgres";
import { Money, Quantity, currency, promotionActiveAt, promotionDiscount } from "@dulja/domain";
// The db-local twin, never `@dulja/sync` (0B's `dependency-rule`; see limits.ts).
import type { TicketInput } from "./apply";
import { SyncError } from "./enrolment";

function fail(detail: string): never {
  throw new SyncError("ERR_VALIDATION_FAILED", detail);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `document_line.custom_fields` key under which a POS item line records the VERIFIED promotion share its
 * `discount` carries (ADR 0059's PR 12 review amendment), so `pos.sales_by_cashier` can leave it out of the
 * cashier's `discountBase` as it leaves out the cash rounding. A four-place figure in the line's own direction,
 * like `CASH_ROUNDING_FIELD` and `cost`: the signed share is the record times the sign of the line's quantity,
 * so a reversal mirror (which copies `custom_fields` and negates quantity and discount) unwinds it. A sale or
 * blind return line records the share `verifyPromotions` honoured; a referenced refund line records its share of
 * its sale line's record by the cumulative rule; a line whose claim was not honoured records nothing, because
 * its whole discount is the cashier's.
 */
export const PROMOTION_FIELD = "posPromotion";

export interface PromotionVerification {
  /** The ticket with each VERIFIED promotion's share taken out of its line's discount — what discount authority
   *  and the branch limits read. Lines whose evidence was not honoured keep their whole discount. */
  ticket: TicketInput;
  /** Why evidence was not honoured, one entry per line, so a refusal that follows can say so. Empty when every
   *  claim held or none was made. */
  unhonoured: string[];
  /** Each honoured line's promotion share by line number, in `PROMOTION_FIELD`'s stored form — what the posted
   *  line records. Empty when no claim was honoured. */
  honoured: ReadonlyMap<number, string>;
}

interface PromotionDbRow {
  id: string;
  kind: string;
  branchId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  definition: unknown;
}

/**
 * Verifies the promotion evidence on a ticket's lines (ADR 0059's PR 12 review amendment) and returns the
 * ticket discount authority and the branch limits read: a promotion is the shop's decision, and only the
 * cashier's own discount needs `pos.ticket.discount` or counts against `max_line_discount_pct` and
 * `max_ticket_discount_pct` (6B Task 6). Runs on the caller's `tx`, after `verifyCashRounding`, so the discount
 * it starts from is already free of the automatic rounding.
 *
 * A claim is honoured only when the server's own `app.promotion` row proves it: a promotion of THIS company, of
 * no branch or of the terminal's branch (Form B), whose window contains `soldAt` (both ends inclusive, as the
 * till reads it), and whose definition — read in the catalogue stream's normal form, so the till and the server
 * see the same text — gives this line exactly the claimed discount through the domain's `promotionDiscount`,
 * the till's own arithmetic, from the wire's unit price and quantity. Anything else is **not honoured**: the
 * line keeps its whole discount, the ordinary checks apply to it, and a cashier without the authority or the
 * limit is refused — recoverably, with the reason named — rather than let through on a claim nobody can prove.
 * A promotion edited, shortened or removed between the sale and the sync is refused the same way, as a stale
 * tax rate is (SAH-020): the server never re-prices what the shop sold.
 *
 * Malformed evidence is refused outright: another currency, a zero or wrongly signed share, a share larger
 * than the line's discount, a line whose whole discount exceeds its gross, or any evidence on a referenced
 * return (which restores its sale's discount as it was, as `verifyCashRounding` refuses fresh rounding there).
 */
export async function verifyPromotions(
  tx: Sql,
  ctx: { companyId: string; branchId: string },
  ticket: TicketInput,
): Promise<PromotionVerification> {
  if (!ticket.lines.some((line) => line.promotion != null))
    return { ticket, unhonoured: [], honoured: new Map() };
  if (ticket.returnsClientRef !== null)
    fail("a referenced return restores its sale's discount and cannot carry promotion evidence");
  const cur = currency(ticket.currency);
  const ids = [
    ...new Set(
      ticket.lines.flatMap((line) =>
        line.promotion != null && UUID.test(line.promotion.promotionId)
          ? [line.promotion.promotionId]
          : [],
      ),
    ),
  ];
  // The definition in the catalogue stream's normal form (`readCatalogue`: top-level JSON numbers become their
  // exact decimal text), and the window bounds as the same `to_jsonb` text the till mirrored.
  const rows =
    ids.length === 0
      ? []
      : await tx<PromotionDbRow[]>`
          select p.id, p.kind, p.branch_id as "branchId",
                 to_jsonb(p.starts_at) #>> '{}' as "startsAt", to_jsonb(p.ends_at) #>> '{}' as "endsAt",
                 case when jsonb_typeof(p.definition) = 'object' then
                   (select coalesce(jsonb_object_agg(e.key, case when jsonb_typeof(e.value) = 'number'
                                                                 then to_jsonb(e.value::text) else e.value end),
                                    '{}'::jsonb)
                      from jsonb_each(p.definition) e)
                 else p.definition end as definition
            from app.promotion p
           where p.company_id = ${ctx.companyId} and p.id = any(${ids}::uuid[])`;
  const byId = new Map(rows.map((row) => [row.id, row]));

  const unhonoured: string[] = [];
  const honoured = new Map<number, string>();
  const lines = ticket.lines.map((line) => {
    const evidence = line.promotion;
    if (evidence == null) return line;
    if (
      evidence.discount.currency !== ticket.currency ||
      line.unitPrice.currency !== ticket.currency
    )
      fail(`line ${line.lineNo}: promotion currency disagrees with ticket`);
    const quantity = Quantity.of(line.quantity);
    const claimed = Money.of(evidence.discount.amount, cur);
    if (claimed.isZero() || claimed.isNegative() !== quantity.isNegative())
      fail(
        `line ${line.lineNo}: a promotion's discount is non-zero and signed like the line quantity`,
      );
    const discount = Money.of(line.discount.amount, cur);
    // The WHOLE discount, promotion included, is bounded by the line's gross here, because `validateShape`
    // bounds only the manual share it is handed: without this, an honoured promotion would let promotion plus
    // manual discount exceed the gross and leave a sale line with a negative total (PR 12 review).
    const entered = Money.of(line.unitPrice.amount, cur).multiply(
      quantity.toString(),
      "HALF_AWAY_FROM_ZERO",
    );
    if (discount.abs().compare(entered.abs()) > 0)
      fail(`line ${line.lineNo}: discount exceeds gross price`);
    const manual = discount.subtract(claimed);
    if (!manual.isZero() && manual.isNegative() !== quantity.isNegative())
      fail(
        `line ${line.lineNo}: promotion discount ${claimed.toString()} exceeds the line discount ${discount.toString()}`,
      );

    const row = byId.get(evidence.promotionId);
    const id = evidence.promotionId;
    let reason: string | null = null;
    // A terminal's session sees only its own branch's promotions and the company-wide ones (6C's
    // `branch_isolation`, Form B), so another branch's offer is usually not found at all; the explicit test
    // keeps the rule for a session that is not branch-restricted.
    if (row === undefined) reason = `promotion ${id} is not a promotion of this company and branch`;
    else if (row.branchId !== null && row.branchId !== ctx.branchId)
      reason = `promotion ${id} belongs to another branch`;
    else if (!promotionActiveAt(row, ticket.soldAt))
      reason = `promotion ${id} is not active at ${ticket.soldAt}`;
    else {
      const computed = promotionDiscount(row, {
        itemId: line.itemId,
        unitPrice: Money.of(line.unitPrice.amount, cur),
        quantity,
      });
      if (computed.isZero()) reason = `promotion ${id} does not apply to item ${line.itemId}`;
      else if (!computed.equals(claimed.abs()))
        reason = `promotion ${id} gives ${computed.toString()} on this line, not ${claimed.abs().toString()}`;
    }
    if (reason !== null) {
      unhonoured.push(`line ${line.lineNo}: ${reason}`);
      return line;
    }
    // Signed like the quantity (checked above), so its magnitude is the line-direction record.
    honoured.set(line.lineNo, claimed.abs().toString());
    return { ...line, discount: manual.toJSON() };
  });
  return { ticket: { ...ticket, lines }, unhonoured, honoured };
}

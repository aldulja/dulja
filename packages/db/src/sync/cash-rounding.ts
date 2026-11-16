import type { Sql } from "postgres";
import { Money, Quantity, currency, roundToIncrement, type CurrencyCode } from "@dulja/domain";
import type { TicketInput } from "./apply";
import { SyncError } from "./enrolment";

function fail(detail: string): never {
  throw new SyncError("ERR_VALIDATION_FAILED", detail);
}

/**
 * The `document_line.custom_fields` key that records the automatic cash-rounding adjustment an item line of a
 * POS ticket absorbed (ADR 0059, owner direction 2026-10-22). The posted `discount` keeps that adjustment —
 * the ticket balances only that way — so a reader separating manual discounts from rounding, as
 * `pos.sales_by_cashier` does, reads it back from here. Absent means none.
 *
 * The stored figure is a 4-place magnitude **in the line's own direction**, like `cost` (§4.4.2): positive when
 * rounding raised the amount moving the way the line moves (a sale rounded up, a refund whose payout was
 * rounded up). `reverseDocument` copies `custom_fields` unchanged and negates `quantity` and `discount`, so its
 * mirror unwinds the adjustment with no rewrite, at any depth of a reversal chain. A reader turns it back into
 * the signed adjustment (rounded payable − original gross) by the sign of the line's quantity.
 */
export const CASH_ROUNDING_FIELD = "posCashRounding";

/** The stored, line-direction form of a signed adjustment (rounded payable − original gross). */
export function lineCashRounding<C extends CurrencyCode>(
  adjustment: Money<C>,
  quantity: Quantity,
): Money<C> {
  return quantity.isNegative() ? adjustment.negate() : adjustment;
}

/** Returns reconstructed manual discounts after verifying the branch's automatic cash adjustment. */
export async function verifyCashRounding(
  tx: Sql,
  ctx: { companyId: string; branchId: string },
  ticket: TicketInput,
): Promise<TicketInput> {
  const evidence = ticket.cashRounding;
  if (evidence == null) return ticket;
  if (ticket.returnsClientRef !== null)
    fail("referenced returns preserve source rounding and cannot carry new rounding evidence");
  if (ticket.tenders.length === 0 || ticket.tenders.some((t) => t.method !== "cash"))
    fail("cash rounding requires cash-only tenders");
  if (evidence.adjustment.currency !== ticket.currency)
    fail("cash rounding currency disagrees with ticket");
  const cur = currency(ticket.currency),
    delta = Money.of(evidence.adjustment.amount, cur);
  const [policy] = await tx<
    { increment: string }[]
  >`select coalesce(b.rounding_increment,0.05::numeric(19,4))::text as increment from (select 1) one left join app.branch_pos_policy b on b.company_id=${ctx.companyId} and b.branch_id=${ctx.branchId}`;
  const seen = new Set<number>();
  let originalTotal = Money.zero(cur),
    chosen: { lineNo: number; gross: Money<typeof cur> } | null = null;
  const lines = ticket.lines.map((line) => {
    if (!Number.isSafeInteger(line.lineNo) || line.lineNo <= 0 || seen.has(line.lineNo))
      fail("cash rounding requires unique positive line numbers");
    seen.add(line.lineNo);
    for (const value of [line.unitPrice, line.discount, line.total, line.taxAmount])
      if (value.currency !== ticket.currency)
        fail(`line ${line.lineNo}: currency disagrees with ticket`);
    const wireDiscount = Money.of(line.discount.amount, cur),
      manual = line.lineNo === evidence.lineNo ? wireDiscount.add(delta) : wireDiscount;
    const quantity = Quantity.of(line.quantity),
      price = Money.of(line.unitPrice.amount, cur);
    if (
      price.isNegative() ||
      quantity.isZero() ||
      quantity.isNegative() !== (ticket.kind === "return")
    )
      fail("cash rounding price or quantity has an invalid sign");
    if (!manual.isZero() && manual.isNegative() !== quantity.isNegative())
      fail("manual discount sign disagrees with quantity");
    const entered = price.multiply(quantity.toString(), "HALF_AWAY_FROM_ZERO");
    if (manual.abs().compare(entered.abs()) > 0) fail("manual discount exceeds entered gross");
    const originalGross = entered.subtract(manual),
      finalGross = Money.of(line.total.amount, cur);
    if (
      !finalGross.equals(line.lineNo === evidence.lineNo ? originalGross.add(delta) : originalGross)
    )
      fail("cash rounding line total disagrees with verified adjustment");
    originalTotal = originalTotal.add(originalGross);
    if (
      chosen === null ||
      originalGross.abs().compare(chosen.gross.abs()) > 0 ||
      (originalGross.abs().equals(chosen.gross.abs()) && line.lineNo < chosen.lineNo)
    )
      chosen = { lineNo: line.lineNo, gross: originalGross };
    return { ...line, discount: manual.toJSON() };
  });
  // The target is derived from entered facts, not the till's chosen identifier.
  const target = chosen as { lineNo: number; gross: Money<typeof cur> } | null;
  if (!target || target.lineNo !== evidence.lineNo)
    fail(
      "cash rounding target must be greatest original gross, breaking ties by lowest line number",
    );
  if (!delta.equals(roundToIncrement(originalTotal, policy!.increment).subtract(originalTotal)))
    fail("cash rounding adjustment disagrees with current branch increment");
  return { ...ticket, lines };
}

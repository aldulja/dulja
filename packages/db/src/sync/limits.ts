import type { Sql } from "postgres";
import { SyncError } from "./enrolment";
import { Money, currency, type CurrencyCode } from "@dulja/domain";
// 6A's DB-LOCAL twins, never `@dulja/sync`: 0B's `dependency-rule` pins `packages/db` to
// ['@dulja/domain'] (6A:1772 states the same constraint for its own `SyncError`). `@dulja/sync`'s
// `Ticket` satisfies `TicketInput` structurally, so the test tier may keep passing the wire type.
import type { TicketInput, TicketLineInput } from "./apply";

export type LimitKind = "line_discount" | "ticket_discount" | "void" | "blind_return";

export interface LimitRefusal {
  kind: LimitKind;
  detail: string;
  lineNo: number | null;
}

export interface TicketVerification {
  missingCodes: string[];
  refusals: LimitRefusal[];
}

export interface TicketContext {
  companyId: string;
  branchId: string;
  currency: string;
}

/**
 * Which limit kinds an override subject lifts. The ONE place this mapping exists: 6D's till events read it
 * for the same `void` subject, and two copies would let a void be lifted by a discount approval.
 * `price_override` lifts nothing here — that limit is enforced at the till (see the task's decision (c)),
 * and 6A's applyBatch step (h) records the event either way, so the supervisor is on the document.
 * Keyed by `string` because `TicketEventInput.subject` is `string` in the db-local twin; an unrecognised
 * subject lifts NOTHING, which is the safe direction — a till cannot invent a word that widens a limit.
 */
export const OVERRIDE_LIFTS: Readonly<Record<string, readonly LimitKind[]>> = {
  discount: ["line_discount", "ticket_discount"],
  void: ["void"],
  blind_return: ["blind_return"],
  price_override: [],
};

const MODE = "HALF_AWAY_FROM_ZERO" as const; // hazard 23's mode; 6B computes the same allowance the same way

const isBlindReturn = (t: TicketInput) => t.kind === "return" && t.returnsClientRef === null;
const hasVoidEvent = (t: TicketInput) => t.events.some((e) => e.subject === "void");
// Through `Money`, never a string compare: a till that formats zero as "0.00" or "0" would otherwise be
// told it needs `pos.ticket.discount` for a ticket carrying no discount at all, and would be refused.
const hasDiscount = (t: TicketInput, c: CurrencyCode) =>
  t.returnsClientRef === null &&
  t.lines.some((l) => !Money.of(l.discount.amount, c).abs().isZero());

/** The codes a ticket's SHAPE requires of its cashier, before any policy row is read. Pure. */
export function requiredCodesFor(ticket: TicketInput): string[] {
  const cur = currency(ticket.currency);
  const codes = new Set<string>([
    ticket.kind === "return" ? "pos.ticket.return" : "pos.ticket.sell",
  ]);
  if (hasDiscount(ticket, cur)) codes.add("pos.ticket.discount");
  if (isBlindReturn(ticket)) codes.add("pos.ticket.return_blind");
  if (hasVoidEvent(ticket)) codes.add("pos.ticket.void");
  if (ticket.newCustomer != null) codes.add("pos.customer.create");
  return [...codes].toSorted();
}

// `.abs()` on both factors: a RETURN carries a negative quantity and a negative total (6A step (b) enforces
// it), and a limit is a magnitude. Nothing in this file reads a sign to decide a direction (§4.4.2).
const gross = (l: TicketLineInput, c: CurrencyCode) =>
  Money.of(l.unitPrice.amount, c).abs().multiply(String(l.quantity).replace("-", ""), MODE);

/**
 * Re-verifies a ticket against the SERVER's authority and the branch's limit ROW (spec:1324, test 37).
 * It never reads `pos_cashier.snapshot`: the snapshot is the till's copy and may lag or be tampered with.
 * Every query runs on the caller's `tx`, inside `applyBatch`'s per-ticket savepoint.
 *
 * The line discounts it reads are the CASHIER's: `applyBatch` passes the ticket with the verified cash
 * rounding (ADR 0059) and the verified promotions (its PR 12 review amendment) taken out, so neither the
 * automatic adjustment nor the shop's offer needs `pos.ticket.discount` or counts against a branch limit.
 * Called on the wire ticket as it stands, every discount on it counts — the conservative reading.
 */
export async function verifyTicket(
  tx: Sql,
  ctx: TicketContext,
  ticket: TicketInput,
): Promise<TicketVerification> {
  const cur = currency(ctx.currency);
  const missingCodes: string[] = [];
  const refusals: LimitRefusal[] = [];

  // 1. Is this principal a live cashier at THIS branch? A revoked one authorises nothing, whatever the
  //    till's mirror still says (spec:2090, test 34).
  const [cashier] = await tx<{ revoked: boolean }[]>`
    select (revoked_at is not null) as revoked from app.pos_cashier
     where principal_id = ${ticket.cashierPrincipalId} and company_id = ${ctx.companyId} and branch_id = ${ctx.branchId}`;
  if (!cashier) {
    missingCodes.push(`no pos_cashier row for ${ticket.cashierPrincipalId} at this branch`);
    return { missingCodes, refusals };
  }
  if (cashier.revoked) {
    missingCodes.push(`cashier ${ticket.cashierPrincipalId} is revoked`);
    return { missingCodes, refusals };
  }

  // 2. Authority, from app.principal_has and nothing else (§4.5.3). An authority gap is NEVER override-able.
  for (const code of requiredCodesFor(ticket)) {
    const [grant] = await tx<{ ok: boolean }[]>`
      select app.principal_has(${ticket.cashierPrincipalId}, ${code}, ${ctx.companyId}, ${ctx.branchId}) as ok`;
    if (!grant?.ok) missingCodes.push(code);
  }
  if (missingCodes.length > 0) return { missingCodes, refusals };

  // 3. Limits, from the ROW. A branch with no row authorises nothing above zero — the migration's defaults
  //    and a missing row refuse identically, which is why `coalesce` is used and not a null-check branch.
  //    **Every fallback carries its column's own type.** An untyped `0` has scale 0, so `coalesce(x, 0)::text`
  //    returns "0" where a real row returns "0.0000" — the JS fallback below would then disagree with the SQL
  //    for exactly the branches that have no row, which are the ones this check most has to get right.
  const [policy] = await tx<
    {
      maxLineDiscountPct: string;
      maxTicketDiscountPct: string;
      maxVoidAmount: string;
      blindReturnAllowed: boolean;
      maxBlindReturnAmount: string;
    }[]
  >`
    select coalesce(max_line_discount_pct,   0::numeric(9,6))::text  as "maxLineDiscountPct",
           coalesce(max_ticket_discount_pct, 0::numeric(9,6))::text  as "maxTicketDiscountPct",
           coalesce(max_void_amount,         0::numeric(19,4))::text as "maxVoidAmount",
           coalesce(blind_return_allowed,    false)                  as "blindReturnAllowed",
           coalesce(max_blind_return_amount, 0::numeric(19,4))::text as "maxBlindReturnAmount"
      from app.branch_pos_policy where company_id = ${ctx.companyId} and branch_id = ${ctx.branchId}`;
  const limits = policy ?? {
    maxLineDiscountPct: "0.000000",
    maxTicketDiscountPct: "0.000000",
    maxVoidAmount: "0.0000",
    blindReturnAllowed: false,
    maxBlindReturnAmount: "0.0000",
  };

  let totalGross = Money.zero(cur);
  let totalDiscount = Money.zero(cur);
  for (const line of ticket.lines) {
    const g = gross(line, cur);
    const d =
      ticket.returnsClientRef === null
        ? Money.of(line.discount.amount, cur).abs()
        : Money.zero(cur);
    totalGross = totalGross.add(g);
    totalDiscount = totalDiscount.add(d);
    // The allowance is computed rather than a ratio derived: `Money.multiply` takes the 6-dp fraction
    // directly, so no division, no float and no second rounding mode enter the comparison.
    const allowed = g.multiply(limits.maxLineDiscountPct, MODE);
    if (d.compare(allowed) > 0) {
      refusals.push({
        kind: "line_discount",
        lineNo: line.lineNo,
        detail: `line ${line.lineNo} discount ${d.toString()} exceeds ${limits.maxLineDiscountPct} of ${g.toString()} (${allowed.toString()})`,
      });
    }
  }

  const ticketAllowance = totalGross.multiply(limits.maxTicketDiscountPct, MODE);
  if (totalDiscount.compare(ticketAllowance) > 0) {
    refusals.push({
      kind: "ticket_discount",
      lineNo: null,
      detail: `ticket discount ${totalDiscount.toString()} exceeds ${limits.maxTicketDiscountPct} of ${totalGross.toString()} (${ticketAllowance.toString()})`,
    });
  }

  const absoluteTotal = ticket.lines.reduce(
    (sum, l) => sum.add(Money.of(l.total.amount, cur).abs()),
    Money.zero(cur),
  );

  if (hasVoidEvent(ticket)) {
    const cap = Money.of(limits.maxVoidAmount, cur);
    if (absoluteTotal.compare(cap) > 0) {
      refusals.push({
        kind: "void",
        lineNo: null,
        detail: `void of ${absoluteTotal.toString()} exceeds max_void_amount ${cap.toString()}`,
      });
    }
  }

  if (isBlindReturn(ticket)) {
    if (!limits.blindReturnAllowed) {
      refusals.push({
        kind: "blind_return",
        lineNo: null,
        detail: `blind return: this branch does not allow one (blind_return_allowed = false)`,
      });
    } else {
      const cap = Money.of(limits.maxBlindReturnAmount, cur);
      if (absoluteTotal.compare(cap) > 0) {
        refusals.push({
          kind: "blind_return",
          lineNo: null,
          detail: `blind return of ${absoluteTotal.toString()} exceeds max_blind_return_amount ${cap.toString()}`,
        });
      }
    }
  }

  // 4. Overrides lift refusals by SUBJECT — and that is ALL this function does with them. It records
  //    nothing: 6A's applyBatch step (h) already calls setEventContext + recordOverride for every
  //    TicketEvent, and 2B's `assert_override_authorised` trigger is the control (§4.5.3, spec:2173).
  //    An unrecognised subject lifts nothing (`?? []`), so a till cannot invent a word that widens a limit.
  const lifted = new Set<LimitKind>();
  for (const e of ticket.events) {
    if (e.kind !== "override") continue;
    for (const kind of OVERRIDE_LIFTS[e.subject] ?? []) lifted.add(kind);
  }
  return { missingCodes, refusals: refusals.filter((r) => !lifted.has(r.kind)) };
}

/** A financial void uses the same live grant, closed branch cap and supervisor subject as a ticket. */
export async function verifyTillVoid(
  tx: Sql,
  ctx: TicketContext,
  input: {
    cashierPrincipalId: string;
    supervisorPrincipalId: string | null;
    amount: Money;
    reason: string;
  },
): Promise<void> {
  const [cashier] = await tx<
    { allowed: boolean }[]
  >`select app.principal_has(${input.cashierPrincipalId},'pos.ticket.void',${ctx.companyId},${ctx.branchId}) allowed from app.pos_cashier where principal_id=${input.cashierPrincipalId} and company_id=${ctx.companyId} and branch_id=${ctx.branchId} and revoked_at is null`;
  if (!cashier?.allowed)
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      "cashier lacks live pos.ticket.void authority at this branch",
    );
  if (!input.reason.trim()) throw new SyncError("ERR_VALIDATION_FAILED", "void requires a reason");
  let approved = false;
  if (input.supervisorPrincipalId !== null) {
    if (input.supervisorPrincipalId === input.cashierPrincipalId)
      throw new SyncError(
        "ERR_OVERRIDE_NOT_AUTHORISED",
        "void approval requires a different supervisor",
      );
    const [supervisor] = await tx<
      { allowed: boolean }[]
    >`select app.principal_has(${input.supervisorPrincipalId},'pos.ticket.override',${ctx.companyId},${ctx.branchId}) allowed from app.pos_cashier where principal_id=${input.supervisorPrincipalId} and company_id=${ctx.companyId} and branch_id=${ctx.branchId} and revoked_at is null`;
    if (!supervisor?.allowed)
      throw new SyncError(
        "ERR_OVERRIDE_NOT_AUTHORISED",
        "supervisor lacks live void override authority at this branch",
      );
    approved = OVERRIDE_LIFTS.void!.includes("void");
  }
  const [policy] = await tx<
    { cap: string }[]
  >`select max_void_amount::text cap from app.branch_pos_policy where company_id=${ctx.companyId} and branch_id=${ctx.branchId}`;
  if (
    input.amount.abs().compare(Money.of(policy?.cap ?? "0.0000", input.amount.currency)) > 0 &&
    !approved
  )
    throw new SyncError(
      "ERR_POS_LIMIT_EXCEEDED",
      "void exceeds the branch max_void_amount; a different supervisor must approve",
    );
}

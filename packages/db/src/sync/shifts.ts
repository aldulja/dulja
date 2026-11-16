import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import { SyncError } from "./enrolment";
import type { MessageOutcome, TerminalApplyContext } from "./apply";
import type { TenantContext } from "../with-tenant";

/**
 * The db-tier structural twin of §4.10.1's `ShiftOpenClose`, exactly as 6A's `TicketInput` is the twin of
 * `Ticket`: `packages/db` may not import `@dulja/contracts` (§3.1), so `kind` and `currency` are `string`
 * here and this layer VALIDATES them instead of trusting a narrowing that happened somewhere else.
 */
export interface ShiftMessageInput {
  shiftId: string;
  kind: string;
  terminalId: string;
  cashierPrincipalId: string;
  at: string;
  currency: string;
  openingFloat: { amount: string; currency: string } | null;
  countedCash: { amount: string; currency: string } | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §4.10.1's ack key: `"<shiftId>:<kind>"` — one outbox row per transition, not per shift. Written with a
 * defensive `String(o.x ?? "")` shape, because a message we cannot key must still be acked as *itself*: an
 * empty ref matches no outbox row and the till keeps it pending, which is the safe direction (spec:1337).
 * This is the shift half; `tillEventRef` in `till-events.ts` is the till-event half, and `apply.ts`
 * delegates to both.
 */
export function shiftRef(m: unknown): string {
  const o = (m ?? {}) as Record<string, unknown>;
  return `${String(o.shiftId ?? "")}:${String(o.kind ?? "")}`;
}

export interface ClassifiedShift {
  index: number;
  ref: string;
  msg: ShiftMessageInput;
}
export interface ShiftClassification {
  opens: ClassifiedShift[];
  closes: ClassifiedShift[];
  malformed: { index: number; outcome: MessageOutcome }[];
}

/**
 * Pure, and deliberately so: `applyBatch` must know how many opens and closes it has BEFORE it opens a
 * savepoint, because the order it applies them in depends on the split (Step 3). Nothing here touches the
 * database and nothing here validates money — a message whose `kind` is neither `open` nor `close` is the
 * only thing this function refuses, since it is the only defect that makes the message unroutable.
 */
export function classifyShifts(messages: readonly unknown[]): ShiftClassification {
  const opens: ClassifiedShift[] = [];
  const closes: ClassifiedShift[] = [];
  const malformed: { index: number; outcome: MessageOutcome }[] = [];

  messages.forEach((raw, index) => {
    const msg = (raw ?? {}) as ShiftMessageInput;
    const ref = shiftRef(raw);
    if (msg.kind === "open") {
      opens.push({ index, ref, msg });
      return;
    }
    if (msg.kind === "close") {
      closes.push({ index, ref, msg });
      return;
    }
    malformed.push({
      index,
      outcome: {
        ref,
        status: "rejected",
        error: {
          code: "ERR_VALIDATION_FAILED",
          detail: `shift message ${index}: kind must be "open" or "close", received ${JSON.stringify(msg.kind)}`,
        },
      },
    });
  });

  return { opens, closes, malformed };
}

/**
 * Every check both transitions share, in one place so `open` and `close` (Task 5) cannot drift.
 *
 * **`terminalId` is checked against the CONTEXT and not merely parsed.** The context comes from the signed
 * request (6A's `terminalAuth`); the payload comes from a till that may be reimaged, cloned or hostile.
 * A shift claiming another terminal would put branch A's cash under branch B's Z-report, and RLS would not
 * catch it because both terminals are in one tenant. This is the message-level twin of hazard 19.
 */
function assertShape(msg: ShiftMessageInput, terminal: TerminalApplyContext): void {
  const at = `shift ${msg.shiftId} (${msg.kind})`;
  if (!UUID_RE.test(String(msg.shiftId))) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: shiftId is not a uuid — the till mints it (§4.10.1)`,
    );
  }
  if (msg.terminalId !== terminal.terminalId) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: terminalId ${msg.terminalId} is not this terminal (${terminal.terminalId}); a shift may only be` +
        ` opened or closed by the terminal that signed the call`,
    );
  }
  if (!UUID_RE.test(String(msg.cashierPrincipalId))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: cashierPrincipalId is not a uuid`);
  }
  if (!/^[A-Z]{3}$/.test(String(msg.currency))) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: currency ${JSON.stringify(msg.currency)} is not a 3-letter code`,
    );
  }
  if (Number.isNaN(Date.parse(String(msg.at)))) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: at is not an ISO 8601 timestamp`);
  }
}

/**
 * Reads a `{ amount, currency }` bag off a message as a `Money` in the shift's own currency, or refuses.
 * `Money.of` is 0D's parser and is the only thing in this file that touches a decimal: no `Number()`, no
 * arithmetic on a string, and `no-number-money` (§3.7.5) fires on any of it (Global Constraint 2).
 */
export function moneyFromMessage(
  bag: { amount: string; currency: string } | null,
  field: string,
  shiftCurrency: string,
  at: string,
): Money {
  if (bag === null || bag === undefined) {
    throw new SyncError("ERR_VALIDATION_FAILED", `${at}: ${field} is required on this transition`);
  }
  if (typeof bag !== "object" || typeof bag.amount !== "string" || typeof bag.currency !== "string")
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: ${field} must contain decimal text and currency`,
    );
  if (bag.currency !== shiftCurrency) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: ${field} is in ${bag.currency} but the shift is in ${shiftCurrency}; a drawer is counted in one` +
        ` currency and a base-currency figure would tie in the wrong money`,
    );
  }
  try {
    return Money.of(bag.amount, currency(bag.currency));
  } catch {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `${at}: ${field}.amount ${JSON.stringify(bag.amount)} is not a decimal`,
    );
  }
}

/**
 * The OPEN transition. Idempotent on the primary key: the id is the uuidv7 the till minted when the drawer
 * was counted in, so the read below is the whole of "zero duplicates" for this message kind — a re-send
 * after a timeout answers `duplicate` and the first write's `opening_float` stands. Overwriting it on a
 * re-send would let a till change a figure a Z-report has already been built on, which is SAH-020's shape
 * ("the server does not overwrite a figure the shop chose") applied to cash. The insert carries no
 * `on conflict` (Plan Contracts' 6D shift integrity corrections): a collision the read cannot see —
 * another tenant's or company's id, or another terminal's uncommitted open — raises 23505 and is rejected
 * rather than acknowledged.
 *
 * `branch_id` and `terminal_id` come from `terminal`, never from `msg`: the context is signed and the
 * payload is not. `opened_principal_id` is the cashier from the payload — that is ATTRIBUTION data and the
 * acting principal stays the terminal (hazard 19, §4.6.5's naming note).
 */
export async function applyShiftOpen(
  sp: Sql,
  _ctx: TenantContext,
  terminal: TerminalApplyContext,
  msg: ShiftMessageInput,
): Promise<MessageOutcome> {
  const ref = shiftRef(msg);
  assertShape(msg, terminal);
  const at = `shift ${msg.shiftId}`;
  const float = moneyFromMessage(msg.openingFloat, "openingFloat", msg.currency, at);

  // Read first, exactly as 6A's `applyTicket` step (a) does. `applyBatch` holds the terminal's
  // `sync-batch` advisory lock, so a same-terminal re-send — the route and the job racing after a client
  // timeout — always sees the first apply's row here and answers `duplicate`; it never reaches the insert.
  const [existing] = await sp<{ id: string; terminal_id: string; branch_id: string }[]>`
    select id, terminal_id, branch_id from app.shift where id = ${msg.shiftId} and company_id = ${terminal.companyId}`;
  if (existing) {
    if (existing.terminal_id !== terminal.terminalId || existing.branch_id !== terminal.branchId)
      throw new SyncError("ERR_CONFLICT_REFERENCE", "shift belongs to another terminal or branch");
    return { ref, status: "duplicate", error: null };
  }
  const [company] = await sp<
    { currency: string }[]
  >`select base_currency currency from app.company where id=${terminal.companyId}`;
  if (!company || company.currency !== msg.currency)
    throw new SyncError("ERR_VALIDATION_FAILED", "shift currency must equal company currency");
  const [cashier] = await sp<
    { allowed: boolean }[]
  >`select app.principal_has(${msg.cashierPrincipalId}, 'pos.shift.own', ${terminal.companyId}, ${terminal.branchId}) allowed from app.pos_cashier where principal_id=${msg.cashierPrincipalId} and company_id=${terminal.companyId} and branch_id=${terminal.branchId} and revoked_at is null`;
  if (!cashier?.allowed)
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      "cashier lacks live pos.shift.own authority at this branch",
    );
  if (float.isNegative())
    throw new SyncError("ERR_VALIDATION_FAILED", "opening float must be non-negative");
  if (msg.countedCash !== null)
    throw new SyncError("ERR_VALIDATION_FAILED", "open must not contain countedCash");

  await sp`
    insert into app.shift (id, tenant_id, company_id, branch_id, terminal_id,
                           opened_principal_id, opened_at, opening_float, currency)
    values (${msg.shiftId}, app.current_tenant(), ${terminal.companyId}, ${terminal.branchId},
            ${terminal.terminalId}, ${msg.cashierPrincipalId}, ${msg.at}::timestamptz,
            ${float.toString()}, ${msg.currency})`;

  // No `on conflict`, so reaching this line means the row was written. A primary-key collision the read
  // above could not see (another tenant's or company's shift, or another terminal's open that had not
  // committed) raised 23505, which `runMessage` classifies as ERR_CONFLICT_UNIQUE and answers `rejected` —
  // never a silent `duplicate` for a shift that is not this terminal's.
  return { ref, status: "accepted", error: null };
}

/**
 * The reference `0070` deliberately does not enforce (Task 0 amendment A2), enforced here instead.
 *
 * Two facts made a validated foreign key impossible in the migration: a migration cannot backfill the
 * missing parents, because `FORCE ROW LEVEL SECURITY` binds `app_migrator` and a migration file has no
 * `set_config` (hazard 10); and PostgreSQL's referential-integrity checks BYPASS row security, so the
 * constraint's validation scan would see every pre-6D `POS_TICKET` written between 6B's release and 6D's,
 * each naming a shift with no row. Refusing here creates no new orphan, which is what a later contract
 * migration will need before it can add the key.
 *
 * **Scoped to the terminal, not merely to the company.** A shift id is a client-minted uuid; two tills in
 * one shop cannot collide on one by accident, but a cloned till could send its neighbour's, and a ticket
 * filed under the wrong drawer is an over/short on both.
 */
export async function assertShiftKnown(
  sp: Sql,
  terminal: TerminalApplyContext,
  shiftId: string,
): Promise<void> {
  if (!UUID_RE.test(String(shiftId))) {
    throw new SyncError(
      "ERR_VALIDATION_FAILED",
      `shiftId ${JSON.stringify(shiftId)} is not a uuid`,
    );
  }
  const [row] = await sp<{ id: string }[]>`
    select id from app.shift
     where id = ${shiftId} and company_id = ${terminal.companyId} and terminal_id = ${terminal.terminalId} and branch_id=${terminal.branchId} and closed_at is null`;
  if (!row) {
    throw new SyncError(
      "ERR_CONFLICT_REFERENCE",
      `shift ${shiftId} is not an open shift of terminal ${terminal.terminalId}; send the ShiftOpenClose "open"` +
        ` message before the tickets of that shift (§4.10.1)`,
    );
  }
}

// All three are used below: `buildTillDocument` posts the over/short, `resolveAccountByCode` resolves
// `1110` for the expected-cash read, and `tillEffectiveDate` maps the till's instant to a posting date.
import { buildTillDocument, resolveAccountByCode, tillEffectiveDate } from "../posting/till";
import { POS_PERMISSION } from "./authority";

/**
 * ADR 0063's formula, as one read.
 *
 * `opening_float + Σ(debit − credit)` over `app.ledger_entry` rows on the company's **`1110` Cash in
 * till**, in the **shift's own currency**, for documents of this `shift_id` whose status is `posted` or
 * `reversed` and whose type is not `TILL_OVER_SHORT`.
 *
 * Four clauses, four reasons, each of which a reader would otherwise have to reconstruct:
 * — **`1110` and not "the cash accounts"**: the drawer holds notes. Card and transfer tenders post to
 *   `1120` and `1100` and are not in the drawer at all.
 * — **`le.currency = shift.currency` and not the base amounts**: a physical count is a count in one
 *   currency, and `base_debit` would tie a MYR drawer to a rate-converted figure.
 * — **`status in ('posted','reversed')`**: a reversed ticket's own entries stay in the ledger and its
 *   reversal's entries are there too; both belong. Filtering to `posted` would drop the original and keep
 *   the reversal, understating the drawer by twice the sale. (4B's `ledgerLegSource` predicate, reused.)
 * — **`t.code <> 'TILL_OVER_SHORT'`**: this figure is what the over/short is posted FROM. Including it
 *   would make a second close compute an expectation that already held the first close's correction.
 *
 * Every future cash movement — OD-10's paid-outs, safe drops and bankings — enters this sum the day its
 * document type lands, with no change here. That is the whole point of reading the ledger.
 */
export async function computeExpectedCash(
  sp: Sql,
  companyId: string,
  shiftId: string,
): Promise<{ expected: Money; openingFloat: Money; shiftCurrency: string }> {
  const [shift] = await sp<{ opening_float: string; currency: string }[]>`
    select opening_float::text, currency from app.shift
     where id = ${shiftId} and company_id = ${companyId}`;
  if (!shift) {
    throw new SyncError(
      "ERR_CONFLICT_REFERENCE",
      `shift ${shiftId} is not a shift of company ${companyId}`,
    );
  }
  const cur = currency(shift.currency);
  const tillAccountId = await resolveAccountByCode(sp, companyId, "1110");

  const [net] = await sp<{ movement: string }[]>`
    select coalesce(sum(le.debit) - sum(le.credit), 0)::text as movement
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
     where le.company_id = ${companyId}
       and le.account_id = ${tillAccountId}
       and le.currency   = ${shift.currency}
       and d.shift_id    = ${shiftId}
       and d.status in ('posted', 'reversed')
       and t.code <> 'TILL_OVER_SHORT'`;

  const openingFloat = Money.of(shift.opening_float, cur);
  // `Money.add` on two `Money` of one currency — no JavaScript arithmetic, no `Number()` (Constraint 2).
  const expected = openingFloat.add(Money.of(net!.movement, cur));
  return { expected, openingFloat, shiftCurrency: shift.currency };
}

/**
 * The CLOSE transition. Six steps, in this order and for these reasons:
 *
 * 1. Shape (`assertShape`) — shared with the open, so the two cannot drift.
 * 2. `select … for update` on the shift, so two concurrent closes of one drawer serialise. The batch-level
 *    advisory lock in `applyBatch` covers one terminal; a branch manager's close arriving on a second
 *    terminal's batch is a different key, and without this row lock both would derive the same expectation
 *    and post two over/short documents.
 * 3. Already closed → `duplicate` and NOTHING else. The first count stands: overwriting `counted_cash` on
 *    a re-send would change a figure a Z-report has already been built on, and posting a second
 *    `TILL_OVER_SHORT` would double the correction. This is "zero duplicates" for this message kind.
 * 4. Authority, evaluated against the SERVER's assignments through `app.principal_has` — never against
 *    anything the till sent (spec:1324). The closer's own shift needs `pos.shift.own` (6B's code); someone
 *    else's needs `pos.shift.close_any` (6D's). That is spec:2161's distinction verbatim, and no override
 *    lifts either (Task 2 Step 6: `OVERRIDE_SUBJECT_FOR` is `null` for both).
 * 5. The derivation and the four columns, written in ONE update so `shift_close_is_atomic` can never see a
 *    half-closed row.
 * 6. The posting — but only when the difference is non-zero.
 */
export async function applyShiftClose(
  sp: Sql,
  ctx: TenantContext,
  terminal: TerminalApplyContext,
  msg: ShiftMessageInput,
): Promise<MessageOutcome> {
  const ref = shiftRef(msg);
  assertShape(msg, terminal);
  const at = `shift ${msg.shiftId}`;

  // 2. One closer per drawer.
  const [shift] = await sp<
    {
      id: string;
      opened_principal_id: string;
      opened_at: string;
      closed_at: string | null;
      currency: string;
    }[]
  >`
    select id, opened_principal_id::text, opened_at::text, closed_at::text, currency
      from app.shift
     where id = ${msg.shiftId} and company_id = ${terminal.companyId} and terminal_id = ${terminal.terminalId} and branch_id=${terminal.branchId}
       for update`;
  if (!shift) {
    throw new SyncError(
      "ERR_CONFLICT_REFERENCE",
      `${at} is not an open shift of terminal ${terminal.terminalId}; send the "open" message first (§4.10.1)`,
    );
  }

  // 3. Idempotent on the transition, not on the payload.
  if (shift.closed_at !== null) return { ref, status: "duplicate", error: null };

  if (msg.currency !== shift.currency)
    throw new SyncError("ERR_VALIDATION_FAILED", "close currency differs from the shift");
  if (msg.openingFloat !== null)
    throw new SyncError("ERR_VALIDATION_FAILED", "close must not contain openingFloat");
  if (Date.parse(msg.at) < Date.parse(shift.opened_at))
    throw new SyncError("ERR_VALIDATION_FAILED", "close cannot precede open");
  const counted = moneyFromMessage(msg.countedCash, "countedCash", shift.currency, at);
  if (counted.isNegative())
    throw new SyncError("ERR_VALIDATION_FAILED", "counted cash must be non-negative");
  const [credential] = await sp<
    { id: string }[]
  >`select principal_id id from app.pos_cashier where principal_id=${msg.cashierPrincipalId} and company_id=${terminal.companyId} and branch_id=${terminal.branchId} and revoked_at is null`;
  if (!credential)
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      "closer has no live cashier credential at this branch",
    );

  // 4. Authority. `app.principal_has(p_principal, p_code, p_company_id, p_branch_id)` — that order (§4.5.3).
  const own = msg.cashierPrincipalId === shift.opened_principal_id;
  const code = own ? POS_PERMISSION.shiftOwn : POS_PERMISSION.shiftCloseAny;
  const [auth] = await sp<{ ok: boolean }[]>`
    select app.principal_has(${msg.cashierPrincipalId}, ${code}, ${terminal.companyId}, ${terminal.branchId}) as ok`;
  if (!auth!.ok) {
    throw new SyncError(
      "ERR_RBAC_FORBIDDEN",
      `${at}: principal ${msg.cashierPrincipalId} does not hold ${code} at branch ${terminal.branchId}` +
        (own
          ? " (closing one's own shift)"
          : " (closing a shift another principal opened — spec:2160)"),
    );
  }

  // 5. Derive and write. `over_short = counted − expected`, POSITIVE IS OVER (§4.6.5).
  const { expected } = await computeExpectedCash(sp, terminal.companyId, msg.shiftId);
  const overShort = counted.subtract(expected);
  await sp`
    update app.shift
       set closed_at = ${msg.at}::timestamptz,
           closed_principal_id = ${msg.cashierPrincipalId},
           counted_cash  = ${counted.toString()},
           expected_cash = ${expected.toString()},
           over_short    = ${overShort.toString()}
     where id = ${msg.shiftId}`;

  // 6. An exact count posts NOTHING. `over_short_document_id` stays null and `over_short` is "0.0000",
  //    which is a *statement* that the drawer balanced and not a missing document. Posting a zero
  //    document would raise ERR_DOC_NO_LINES from §4.3.2 step 6's zero-drop and refuse a correct close.
  if (!overShort.isZero()) {
    // The SIGN chooses the pair; the MAGNITUDE is always positive. This is the one place in the slice that
    // reads a sign, and Global Constraint 9 grants it explicitly: `shift.over_short` is a stored signed
    // column, not a `PlannedLedgerLine`, and it is read once to pick two account codes.
    const over = overShort.isNegative() === false;
    const result = await buildTillDocument(sp, ctx, terminal, {
      kind: "over_short",
      typeCode: "TILL_OVER_SHORT",
      shiftId: msg.shiftId,
      amount: overShort.abs(),
      // OVER: the drawer holds more than the ledger says → debit 1110 (more cash), credit 5120 (a gain
      // sitting in an expense account, which is what "signed: a debit is short, a credit is over" means
      // in §4.15's row for 5120). SHORT: the mirror.
      debitAccountCode: over ? "1110" : "5120",
      creditAccountCode: over ? "5120" : "1110",
      effectiveDate: await tillEffectiveDate(sp, terminal.companyId, msg.at),
      attributedTo: msg.cashierPrincipalId,
      description: over
        ? `Till over on shift ${msg.shiftId}`
        : `Till short on shift ${msg.shiftId}`,
      clientRef: null,
    });
    await sp`update app.shift set over_short_document_id = ${result.documentId} where id = ${msg.shiftId}`;
  }

  return { ref, status: "accepted", error: null };
}

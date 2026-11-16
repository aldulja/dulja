// apps/pos/src/main/shift.ts
import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import { shiftRef, type ShiftOpenClose, type TillCashMsg } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import { moneyToText, textToMoney } from "./money";
import { tillUuidv7 } from "./ticket";

export interface TillShift {
  id: string;
  terminalId: string;
  cashierPrincipalId: string;
  openedAt: string;
  openingFloat: Money;
  currency: CurrencyCode;
  closedAt: string | null;
  countedCash: Money | null;
}

interface ShiftDbRow {
  id: string;
  terminal_id: string;
  cashier_principal_id: string;
  opened_at: string;
  opening_float: string;
  currency: string;
  closed_at: string | null;
  counted_cash: string | null;
}
const toShift = (r: ShiftDbRow): TillShift => {
  const cur = currency(r.currency);
  return {
    id: r.id,
    terminalId: r.terminal_id,
    cashierPrincipalId: r.cashier_principal_id,
    openedAt: r.opened_at,
    openingFloat: textToMoney(r.opening_float, cur),
    currency: cur,
    closedAt: r.closed_at,
    countedCash: r.counted_cash === null ? null : textToMoney(r.counted_cash, cur),
  };
};

export function currentShift(sqliteDb: PosDatabase, terminalId: string): TillShift | null {
  const row = sqliteDb.raw
    .prepare<[string], ShiftDbRow>(
      `select id, terminal_id, cashier_principal_id, opened_at, opening_float, currency, closed_at, counted_cash from shift where terminal_id = ? and closed_at is null order by opened_at desc limit 1`,
    )
    .get(terminalId);
  return row === undefined ? null : toShift(row);
}

/**
 * Open a shift (§3.7.6's Shift row: *"open/close with declared opening float"*).
 *
 * `pos.shift.own` is written as `PERMISSION["pos.shift.own"]` and not as a string, which is what makes
 * §3.6.3's `permission-catalogue` lint see a reference from `apps/pos` — the till is the only place in the
 * product that references this code. `pos.shift.close_any`, the branch manager's code for closing *someone
 * else's* shift, is **6D's** and is deliberately not referenced here.
 *
 * The id is a `uuidv7` minted at the till and **is** `app.shift.id` (§4.6.5) — the same client-id convention
 * as `Ticket.clientRef`, so re-sending the open message is idempotent on the primary key. The outbox ref is
 * `shiftRef({ shiftId: id, kind: "open" })`, 6A's own function, never a hand-composed `"<id>:<kind>"`: two spellings of one key
 * would let `markAcked` fail to match a `MessageResult` and the row would re-send for ever.
 */
export function openShift(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  opts: {
    terminalId: string;
    cashier: TillCashier;
    openingFloat: Money;
    at?: Date;
    shiftId?: string;
  },
): TillShift {
  requireCode(opts.cashier, PERMISSION["pos.shift.own"]);
  if (currentShift(sqliteDb, opts.terminalId) !== null) {
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      `terminal ${opts.terminalId} already has an open shift; close it before opening another`,
    );
  }
  if (opts.openingFloat.isNegative())
    throw new TillError("ERR_VALIDATION_FAILED", "opening float must be non-negative");
  const at = opts.at ?? new Date();
  const id = opts.shiftId ?? tillUuidv7(at);
  const cur = currency(opts.openingFloat.toJSON().currency);
  const message: ShiftOpenClose = {
    shiftId: id,
    kind: "open",
    terminalId: opts.terminalId,
    cashierPrincipalId: opts.cashier.principalId,
    at: at.toISOString(),
    currency: cur,
    openingFloat: opts.openingFloat.toJSON(),
    countedCash: null,
  };
  return sqliteDb.tx(() => {
    sqliteDb.raw
      .prepare(
        `insert into shift (id, terminal_id, cashier_principal_id, opened_at, opening_float, currency,
                          closed_at, counted_cash)
       values (?, ?, ?, ?, ?, ?, null, null)`,
      )
      .run(
        id,
        opts.terminalId,
        opts.cashier.principalId,
        at.toISOString(),
        moneyToText(opts.openingFloat),
        cur,
      );
    store.enqueue("shift", shiftRef({ shiftId: id, kind: "open" }), message);
    return currentShift(sqliteDb, opts.terminalId)!;
  });
}

/**
 * Close a shift. **The till sends `countedCash` and nothing else.**
 *
 * §4.10.1, verbatim: *"The till never computes `expectedCash` or `over_short`: the server derives both from
 * the shift's posted tickets, so the local schema deliberately omits these server-derived columns.
 */
export function closeShift(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  opts: { shiftId: string; cashier: TillCashier; countedCash: Money; at?: Date },
): TillShift {
  const row = sqliteDb.raw
    .prepare<[string], ShiftDbRow>(
      `select id, terminal_id, cashier_principal_id, opened_at, opening_float, currency, closed_at, counted_cash from shift where id = ?`,
    )
    .get(opts.shiftId);
  if (row === undefined)
    throw new TillError("ERR_NOT_FOUND", `no shift ${opts.shiftId} on this till`);
  if (row.closed_at !== null) {
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      `shift ${opts.shiftId} was closed at ${row.closed_at}`,
    );
  }
  requireCode(
    opts.cashier,
    row.cashier_principal_id === opts.cashier.principalId
      ? PERMISSION["pos.shift.own"]
      : PERMISSION["pos.shift.close_any"],
  );
  if (
    sqliteDb.raw
      .prepare("select 1 from ticket where shift_id=? and status='open' limit 1")
      .get(opts.shiftId)
  )
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      "complete or cancel unfinished tickets before closing the shift",
    );
  const at = opts.at ?? new Date();
  if (opts.countedCash.isNegative())
    throw new TillError("ERR_VALIDATION_FAILED", "counted cash must be non-negative");
  const cur = currency(row.currency);
  if (currency(opts.countedCash.toJSON().currency) !== cur) {
    throw new TillError(
      "ERR_MONEY_CURRENCY_MISMATCH",
      `the shift is in ${cur} and the count is in ${opts.countedCash.toJSON().currency}`,
    );
  }
  const message: ShiftOpenClose = {
    shiftId: opts.shiftId,
    kind: "close",
    terminalId: row.terminal_id,
    cashierPrincipalId: opts.cashier.principalId,
    at: at.toISOString(),
    currency: cur,
    openingFloat: null,
    countedCash: opts.countedCash.toJSON(),
  };
  return sqliteDb.tx(() => {
    sqliteDb.raw
      .prepare("update shift set closed_at = ?, counted_cash = ? where id = ?")
      .run(at.toISOString(), moneyToText(opts.countedCash), opts.shiftId);
    store.enqueue("shift", shiftRef({ shiftId: opts.shiftId, kind: "close" }), message);
    return toShift({
      ...row,
      closed_at: at.toISOString(),
      counted_cash: moneyToText(opts.countedCash),
    });
  });
}

/**
 * What the cashier sees at close: the ticket count and the cash the drawer *should* hold by tender method.
 *
 * **This is not a Z-report and must not be called one.** The Z-report is 6D's, ties to the ledger to the
 * cent, and reads the server's `expected_cash`; this is a local aid so the person counting the drawer has a
 * number to compare against, computed from the till's own `ticket_tender` rows. Amounts are returned as
 * fixed-4-dp strings because this crosses the `contextBridge` and JSON has no decimal.
 */
export function shiftTotals(
  sqliteDb: PosDatabase,
  shiftId: string,
): { tickets: number; byMethod: Record<string, string> } {
  const tickets = sqliteDb.raw
    .prepare<[string], { n: number }>(
      "select count(*) as n from ticket where shift_id = ? and status = 'completed'",
    )
    .get(shiftId)!.n;
  const row = sqliteDb.raw
    .prepare<[string], { currency: string }>("select currency from shift where id = ?")
    .get(shiftId);
  if (!row) throw new TillError("ERR_NOT_FOUND", "no shift on this till");
  const cur = currency(row.currency);
  const byMethod: Record<string, string> = {};
  const rows = sqliteDb.raw
    .prepare<[string], { method: string; amount: string }>(
      `select t.method as method, t.amount as amount
       from ticket_tender t join ticket k on k.id = t.ticket_id
      where k.shift_id = ? and k.status = 'completed'`,
    )
    .all(shiftId);
  for (const r of rows) {
    const running =
      byMethod[r.method] === undefined ? Money.zero(cur) : textToMoney(byMethod[r.method]!, cur);
    byMethod[r.method] = moneyToText(running.add(textToMoney(r.amount, cur)));
  }
  return { tickets, byMethod };
}

/**
 * ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064). Records a paid-out, a safe drop or a banking on this till's
 * open shift and queues its `TillCashMsg` in the same local transaction (spec:1303, 1337).
 *
 * The till checks what it can see offline, and the server checks it all again against its own rows: every kind
 * needs `pos.shift.own`; a paid-out needs a reference, a branch whose mirrored policy allows paid-outs, and —
 * above `max_paid_out_amount` — the caller-authenticated `supervisor` (a different principal holding
 * `pos.ticket.override`, checked in `register.ts` before this runs). A supervisor offered for anything that
 * does not need one is not sent: the server refuses an approval where none is due.
 */
export function recordCashMovement(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  opts: {
    shiftId: string;
    cashier: TillCashier;
    kind: TillCashMsg["kind"];
    amount: Money;
    reference: string | null;
    fromSafe: boolean;
    supervisor: TillCashier | null;
    at?: Date;
  },
): string {
  requireCode(opts.cashier, PERMISSION["pos.shift.own"]);
  const row = sqliteDb.raw
    .prepare<
      [string],
      { closed_at: string | null; currency: string; cashier_principal_id: string }
    >("select closed_at, currency, cashier_principal_id from shift where id = ?")
    .get(opts.shiftId);
  if (!row || row.closed_at !== null)
    throw new TillError("ERR_VALIDATION_FAILED", "a cash movement needs this till's open shift");
  // A cash movement is an act on one's own drawer, as a sale is: the server refuses any other cashier
  // (ADR 0064's 2026-11-07 amendment), so the till does not queue one it knows will be refused.
  if (row.cashier_principal_id !== opts.cashier.principalId)
    throw new TillError("ERR_RBAC_FORBIDDEN", "a cash movement needs an owned shift");
  const cur = currency(row.currency);
  if (currency(opts.amount.toJSON().currency) !== cur)
    throw new TillError(
      "ERR_MONEY_CURRENCY_MISMATCH",
      `the shift is in ${cur} and the amount is in ${opts.amount.toJSON().currency}`,
    );
  if (opts.amount.isZero() || opts.amount.isNegative())
    throw new TillError("ERR_VALIDATION_FAILED", "a cash movement needs a positive amount");
  if (opts.kind !== "banking" && opts.fromSafe)
    throw new TillError("ERR_VALIDATION_FAILED", "only a banking can come from the safe");
  const reference = opts.reference?.trim() ? opts.reference.trim() : null;
  let supervisorId: string | null = null;
  if (opts.kind === "paid_out") {
    if (reference === null)
      throw new TillError(
        "ERR_VALIDATION_FAILED",
        "a paid-out needs a receipt or voucher reference",
      );
    const policy = sqliteDb.raw
      .prepare<[string], { paid_out_allowed: number; max_paid_out_amount: string }>(
        "select paid_out_allowed, max_paid_out_amount from catalogue_branch_pos_policy where branch_id = ?",
      )
      .get(opts.cashier.branchId);
    if (!policy || policy.paid_out_allowed !== 1)
      throw new TillError("ERR_TILL_LIMIT_EXCEEDED", "paid-outs are not allowed at this branch");
    if (opts.amount.compare(textToMoney(policy.max_paid_out_amount, cur)) > 0) {
      if (!opts.supervisor)
        throw new TillError(
          "ERR_TILL_LIMIT_EXCEEDED",
          `paid-out above ${policy.max_paid_out_amount} needs supervisor approval`,
        );
      supervisorId = opts.supervisor.principalId;
    }
  }
  const at = opts.at ?? new Date();
  const id = tillUuidv7(at);
  const message: TillCashMsg = {
    clientRef: id,
    shiftId: opts.shiftId,
    kind: opts.kind,
    amount: opts.amount.toJSON(),
    cashierPrincipalId: opts.cashier.principalId,
    supervisorPrincipalId: supervisorId,
    occurredAt: at.toISOString(),
    reference,
    fromSafe: opts.kind === "banking" && opts.fromSafe,
  };
  return sqliteDb.tx(() => {
    sqliteDb.raw
      .prepare(
        `insert into cash_event (id, shift_id, kind, amount, currency, reference, from_safe,
                                 cashier_principal_id, supervisor_principal_id, occurred_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.shiftId,
        opts.kind,
        moneyToText(opts.amount),
        cur,
        reference,
        message.fromSafe ? 1 : 0,
        opts.cashier.principalId,
        supervisorId,
        message.occurredAt,
      );
    store.enqueue("cash_event", id, message);
    return id;
  });
}

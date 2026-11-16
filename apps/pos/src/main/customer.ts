import { Money, currency, type CurrencyCode } from "@dulja/domain";
import { PERMISSION } from "@dulja/contracts";
import type { NewCustomer } from "@dulja/sync";
import type { PosDatabase } from "./database";
import type { SqliteSyncStore } from "./store";
import { TillError } from "./errors";
import { requireCode, type TillCashier } from "./authority";
import { sell, tillUuidv7, type SellInput, type SellResult } from "./ticket";
import { draftTicket } from "./ticket";
import { textToMoney } from "./money";

export interface TillCustomer {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  phone: string | null;
  currency: CurrencyCode | null;
  creditLimit: Money | null;
  creditHold: boolean;
  pending: boolean;
}

/**
 * ⚠️ **`credit_hold` is aliased to `hold_flag` in every SELECT below, and the member is named `hold_flag`
 * here, because of `no-number-money` (§3.7.5, 0D).** That rule matches a **declared** `number` annotation on
 * any `PropertySignature` whose name matches `/amount|price|cost|debit|credit|total|balance|rate|tax|net|
 * gross/i`, its `IN_SCOPE` list includes `/(^|\/)apps\//` and its `EXCLUDED` list covers only test paths —
 * so `credit_hold: number` in `apps/pos/src/main/customer.ts` is a violation, and `ALLOWED` is deliberately
 * empty ("every entry there is a review conversation", 0D). The column is a **boolean stored as SQLite's
 * `0|1`**, not money, so the honest fix is the rename and not an `ALLOWED` entry: the public shape,
 * `TillCustomer.creditHold: boolean`, is unchanged and no caller sees this name.
 */
interface CustomerDbRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  phone: string | null;
  currency: string | null;
  credit_limit: string | null;
  hold_flag: number;
}
const toCustomer = (r: CustomerDbRow, pending: boolean): TillCustomer => {
  const cur = r.currency === null ? null : currency(r.currency);
  return {
    id: r.id,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    phone: r.phone,
    currency: cur,
    creditLimit: r.credit_limit === null || cur === null ? null : textToMoney(r.credit_limit, cur),
    creditHold: r.hold_flag === 1,
    pending,
  };
};

/**
 * Lookup by code, phone or either name, across the mirror **and** the till's own pending rows.
 *
 * The `union all` is what makes a customer created at 09:00 findable at 11:00 with no network, and it is two
 * queries rather than one view because the two tables are two *kinds* of row (ADR 0057): the mirror's writer
 * is `applyChanges` and the pending table's writer is this module. `phone` is in the `where` because a shop
 * looks a customer up by the number they read out, and `name_ar` because spec:2061 makes Arabic first-class.
 */
export function findCustomers(sqliteDb: PosDatabase, query: string, limit = 20): TillCustomer[] {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200)
    throw new RangeError("customer search limit must be 1–200");
  const needle = `%${query.trim().toLowerCase()}%`;
  const mirrored = sqliteDb.raw
    .prepare<[string, string, string, string, number], CustomerDbRow>(
      `select id, code, name_en, name_ar, phone, currency, credit_limit, credit_hold as hold_flag
       from catalogue_customer
      where lower(code) like ? or lower(name_en) like ? or lower(coalesce(name_ar, '')) like ?
         or coalesce(phone, '') like ?
      order by code limit ?`,
    )
    .all(needle, needle, needle, needle, limit)
    .map((r) => toCustomer(r, false));
  const pending = sqliteDb.raw
    .prepare<[string, string, string, string, number], CustomerDbRow>(
      `select id, code, name_en, name_ar, phone, null as currency, null as credit_limit, 0 as hold_flag
       from pending_customer
      where not exists (select 1 from catalogue_customer m where m.id=pending_customer.id)
        and (lower(code) like ? or lower(name_en) like ? or lower(coalesce(name_ar, '')) like ?
             or coalesce(phone, '') like ?)
      order by code limit ?`,
    )
    .all(needle, needle, needle, needle, limit)
    .map((r) => toCustomer(r, true));
  return [...mirrored, ...pending].slice(0, limit);
}

export function getCustomer(sqliteDb: PosDatabase, id: string): TillCustomer | null {
  const mirrored = sqliteDb.raw
    .prepare<[string], CustomerDbRow>(
      `select id, code, name_en, name_ar, phone, currency, credit_limit, credit_hold as hold_flag
       from catalogue_customer where id = ?`,
    )
    .get(id);
  if (mirrored !== undefined) return toCustomer(mirrored, false);
  const pending = sqliteDb.raw
    .prepare<[string], CustomerDbRow>(
      `select id, code, name_en, name_ar, phone, null as currency, null as credit_limit, 0 as hold_flag
       from pending_customer where id = ?`,
    )
    .get(id);
  return pending === undefined ? null : toCustomer(pending, true);
}

/**
 * Quick-create (§3.7.6's Customers row, gated on `pos.customer.create`).
 *
 * The party's `uuidv7` is **minted here, at the till, offline**, and is both `Ticket.customerId` and
 * `NewCustomer.id` — 6A's own comment: *"so a re-sent ticket creates no second party"*. 6A's
 * `quickCreateCustomer` verifies code collisions server-side; local duplicates are refused first.
 *
 * The code defaults to `WALK-<the id's last eight hex digits>`, which is unique by construction and readable
 * at a counter. `code` is `unique` in the local table so a cashier who types a code twice is told, rather
 * than silently attaching this sale to the earlier person's account.
 */
export function quickCreateCustomer(
  sqliteDb: PosDatabase,
  cashier: TillCashier,
  opts: { nameEn: string; phone?: string | null; code?: string },
): { customer: TillCustomer; newCustomer: NewCustomer } {
  requireCode(cashier, PERMISSION["pos.customer.create"]);
  const name = opts.nameEn.trim();
  if (name.length === 0) throw new TillError("ERR_VALIDATION_FAILED", "a customer needs a name");
  const id = tillUuidv7();
  const code = opts.code?.trim() ?? `WALK-${id.replaceAll("-", "").slice(-8).toUpperCase()}`;
  if (!code) throw new TillError("ERR_VALIDATION_FAILED", "a customer needs a code");
  const clash = sqliteDb.raw
    .prepare<[string, string], { n: number }>(
      "select (select count(*) from pending_customer where code = ?) + (select count(*) from catalogue_customer where code = ?) as n",
    )
    .get(code, code)!;
  if (clash.n > 0) {
    throw new TillError(
      "ERR_VALIDATION_FAILED",
      `customer code ${code} is already in use on this till`,
    );
  }
  sqliteDb.raw
    .prepare(
      "insert into pending_customer (id, code, name_en, name_ar, phone, created_at, acked_at) values (?, ?, ?, null, ?, ?, null)",
    )
    .run(id, code, name, opts.phone ?? null, new Date().toISOString());
  return {
    customer: getCustomer(sqliteDb, id)!,
    newCustomer: { id, code, nameEn: name, phone: opts.phone ?? null },
  };
}

export interface CreditCheck {
  ok: boolean;
  limit: Money | null;
  localExposure: Money;
  detail: string | null;
}

/**
 * The till's credit check, and it says out loud what it does not know.
 *
 * 4A owns credit control server-side; the till holds `party.credit_limit` and `credit_hold` from the mirror
 * and **its own unsynced account sales**. It does **not** hold the customer's outstanding balance — that is
 * an AR figure the till has no stream for — so this is a *local* check whose refusals are conservative and
 * whose approvals are provisional. The `detail` string says "this till" for exactly the reason spec:1307
 * makes the stock hint say so: a figure the till cannot trust must be labelled, not presented as fact.
 *
 * The server re-checks: `applyBatch` posts a `POS_TICKET` with no tender to `1200` trade receivables through
 * the `POS_TICKET` policy, and 4A's credit control is what refuses it there. A ticket refused for credit
 * lands in the needs-attention queue with the reason, which is the honest end state.
 */
export function checkCredit(sqliteDb: PosDatabase, customerId: string, amount: Money): CreditCheck {
  const cur = currency(amount.toJSON().currency);
  if (amount.isNegative())
    throw new TillError("ERR_VALIDATION_FAILED", "credit exposure must be non-negative");
  const customer = getCustomer(sqliteDb, customerId);
  if (customer === null) {
    return {
      ok: false,
      limit: null,
      localExposure: Money.zero(cur),
      detail: `no customer ${customerId} on this till`,
    };
  }
  if (customer.currency !== null && customer.currency !== cur)
    throw new TillError(
      "ERR_MONEY_CURRENCY_MISMATCH",
      "customer currency differs from the account sale",
    );
  const exposureRows = sqliteDb.raw
    .prepare<[string], { total: string }>(
      `select k.total as total
       from ticket k
      where k.customer_id = ? and k.status = 'completed' and k.kind='sale'
        and not exists (select 1 from ticket_tender t where t.ticket_id = k.id)
        and exists (select 1 from outbox o where o.kind = 'ticket' and o.ref = k.id and o.acked_at is null
                      and not exists (select 1 from outbox_refused r where r.id = o.id))`,
    )
    .all(customerId);
  let localExposure = Money.zero(cur);
  for (const r of exposureRows) localExposure = localExposure.add(textToMoney(r.total, cur));

  if (customer.creditHold) {
    return {
      ok: false,
      limit: customer.creditLimit,
      localExposure,
      detail: `customer ${customer.code} is on credit hold`,
    };
  }
  if (customer.creditLimit === null) {
    return {
      ok: false,
      limit: null,
      localExposure,
      detail: `customer ${customer.code} has no credit limit; take payment at the till`,
    };
  }
  const wanted = localExposure.add(amount);
  if (wanted.compare(customer.creditLimit) > 0) {
    return {
      ok: false,
      limit: customer.creditLimit,
      localExposure,
      detail: `${wanted.toString()} would exceed customer ${customer.code}'s limit of ${customer.creditLimit.toString()}; ${localExposure.toString()} of that is unsynced on this till and the back office may hold more`,
    };
  }
  return { ok: true, limit: customer.creditLimit, localExposure, detail: null };
}

/**
 * An account sale: a completed ticket with a customer and **no tender**.
 *
 * The `POS_TICKET` policy's tender rules are `each_line` rules over `document_line.kind = 'tender'`, so a
 * ticket with no tender lines debits nothing to `1110`/`1120`/`1100`/`2200` and the balancing debit is the
 * receivable — which is what "account sale" means and why this needs no new document type and no new
 * account. `party.receivable_account_id` defaults to §4.15's `1200` (§4.5.7), which 0C seeds.
 *
 * The credit check runs on the **drafted** total, so the figure checked is the figure posted — checking a
 * pre-tax subtotal against a tax-inclusive limit is the kind of near-miss that only shows up on the ticket
 * that crosses the limit by the tax.
 */
export function accountSale(
  sqliteDb: PosDatabase,
  store: SqliteSyncStore,
  input: SellInput & { customerId: string },
): SellResult {
  return sqliteDb.tx(() => {
    if (input.kind === "return" || input.returnsClientRef != null)
      throw new TillError("ERR_VALIDATION_FAILED", "accountSale requires a sale");
    const at = input.at ?? new Date();
    requireCode(input.cashier, PERMISSION["pos.ticket.sell"]);
    const draft = draftTicket(sqliteDb, {
      ...input,
      shiftId: input.shiftId,
      cashier: input.cashier,
      customerId: input.customerId,
      lines: input.lines,
      at,
    });
    const credit = checkCredit(sqliteDb, input.customerId, draft.total);
    if (!credit.ok)
      throw new TillError("ERR_TILL_LIMIT_EXCEEDED", credit.detail ?? "credit refused");

    const result = sell(sqliteDb, store, {
      ...input,
      shiftId: input.shiftId,
      cashier: input.cashier,
      customerId: input.customerId,
      lines: input.lines,
      at,
      clientRef: draft.clientRef,
    });
    // No tender, so `tender()` is never called and the status must be set here — an account sale is complete
    // the moment it is made, and leaving it `open` would keep it out of `shiftTotals` and out of the Z-report.
    sqliteDb.raw
      .prepare("update ticket set status = 'completed' where id = ?")
      .run(result.clientRef);
    return result;
  });
}

/** Stamps pending customers acknowledged. The drain does NOT call this: `SqliteSyncStore.markAcked` stamps the
 *  customer a ticket carried in the acknowledging transaction itself. This is a manual and test helper. It is a
 *  soft clear — `acked_at` rather than a delete — because the row must stay until the real party arrives on a
 *  catalogue page (lookups prefer that mirror by id), so an acknowledgement never makes a customer vanish. */
export function clearPendingCustomers(sqliteDb: PosDatabase, ids: readonly string[]): void {
  const stamp = sqliteDb.raw.prepare(
    "update pending_customer set acked_at = ? where id = ? and acked_at is null",
  );
  const now = new Date().toISOString();
  for (const id of ids) stamp.run(now, id);
}

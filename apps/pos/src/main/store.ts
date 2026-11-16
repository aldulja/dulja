import { v7 as uuidv7 } from "uuid";
import { serializeSyncBody } from "@dulja/sync";
import {
  CATALOGUE_STREAMS,
  type BatchResult,
  type Change,
  type OutboxRow,
  type Stream,
  type SyncStore,
} from "@dulja/sync";
import type { PosDatabase } from "./database";
import { deleteMirror, upsertMirror } from "./mirror";
import { revisionToText, textToRevision } from "./money";

interface OutboxDbRow {
  id: string;
  kind: OutboxRow["kind"];
  ref: string;
  payload: string;
  attempts: number;
  last_error: string | null;
  acked_at: string | null;
}

export class SqliteSyncStore implements SyncStore {
  constructor(private readonly db: PosDatabase) {}

  /** A page arrival alone does not establish a complete initial catalogue. */
  finishCataloguePull(): void {
    this.db.raw
      .prepare(
        "insert into meta (key, value) values ('catalogue_ready', '1') on conflict (key) do update set value = excluded.value",
      )
      .run();
  }

  private readCursor(stream: Stream): bigint {
    const row = this.db.raw
      .prepare<[string], { revision: string }>("select revision from sync_cursor where stream = ?")
      .get(stream);
    return row === undefined ? 0n : textToRevision(row.revision);
  }

  async getCursor(stream: Stream): Promise<bigint> {
    return this.readCursor(stream);
  }

  /**
   * Applies one page and advances **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)`.
   *
   * §4.10.5, 6A's amendment 23c, verbatim: *"A page is ordered by revision **across all streams**, so a page
   * whose last change is revision R has delivered everything at or below R for **every** stream."* A store
   * that advanced only the streams the page carried would answer `0n` for `cashier` and `branch_pos_policy`
   * — which have no rows at all on a fresh company — for ever; `pullAll`'s minimum-across-streams would then
   * be `0n` on every till, every pull would restart from page one, and **nothing would throw**. This loop is
   * the contract, and `store.test.ts`'s second case is its proof.
   *
   * The whole page is one SQLite transaction, so a malformed change leaves neither a half-applied mirror nor
   * an advanced cursor — the till simply re-pulls from where it was.
   */
  async applyChanges(changes: Change[]): Promise<void> {
    if (changes.length === 0) return;
    this.db.tx(() => {
      const cursors = new Map(CATALOGUE_STREAMS.map((stream) => [stream, this.readCursor(stream)]));
      let high = 0n;
      let previous = -1n;
      for (const change of changes) {
        if (
          !CATALOGUE_STREAMS.includes(change.stream) ||
          (change.op !== "upsert" && change.op !== "delete") ||
          typeof change.id !== "string" ||
          !change.id
        )
          throw new TypeError("invalid catalogue change");
        revisionToText(change.revision);
        if (change.revision < previous)
          throw new TypeError("catalogue page must be revision ordered");
        previous = change.revision;
        if (change.revision > high) high = change.revision;
        if (change.revision <= (cursors.get(change.stream) ?? 0n)) continue;
        if (change.op === "delete") {
          if (change.row !== null) throw new TypeError("tombstone must carry a null row");
          deleteMirror(this.db, change.stream, change.id);
        } else {
          if (change.row === null || typeof change.row !== "object" || Array.isArray(change.row)) {
            throw new TypeError(`${change.stream}/${change.id}: an upsert carried a null row`);
          }
          upsertMirror(this.db, change.stream, {
            id: change.id,
            revision: change.revision,
            row: change.row as Record<string, unknown>,
          });
        }
        if (change.revision > high) high = change.revision;
      }

      const advance = this.db.raw.prepare(
        `insert into sync_cursor (stream, revision) values (?, ?)
         on conflict (stream) do update set revision = excluded.revision`,
      );
      for (const stream of CATALOGUE_STREAMS) {
        const current = cursors.get(stream) ?? 0n;
        advance.run(stream, revisionToText(current > high ? current : high));
      }
      this.db.raw
        .prepare(
          "insert into meta (key, value) values ('catalogue_pulled_at', ?) on conflict (key) do update set value = excluded.value",
        )
        .run(new Date().toISOString());
    });
  }

  /**
   * The rows eligible to travel: unacked, not finally refused, and — for a ticket — not still being rung up.
   *
   * **The `not exists` clause is load-bearing and is not an optimisation.** `sell` writes the outbox row
   * inside the sale's own transaction with `tenders: []` (spec:1303 — that is the whole of "zero lost
   * tickets") and leaves `ticket.status <> 'completed'`; `tender` replaces the payload in place and flips the
   * status to `'completed'`. The drain loop fires every 15 seconds (T3), so without this clause any sale
   * where the cashier takes more than one tick to collect payment is pushed with an empty tender array —
   * and 6A's `POS_TICKET` policy balances `Σ` tender debits against `Σ`(amount + tax) with no residual leg,
   * so the server refuses it, writes an `app.needs_attention` row that needs `pos.needs_attention.resolve`
   * to clear, and increments `attempts`. Nothing is lost (`markAcked` leaves a rejected row pending), but a
   * busy shop collects one false needs-attention row per in-progress sale, every day.
   *
   * Existing local tickets travel only after completion. Open and voided tickets are held back;
   * bare protocol payloads without a local ticket row remain eligible.
   *
   * **A refused row is re-sent until its shift's close is acknowledged, and never holds that close** (PR 12
   * review, R12; proposed ADR 0056 amendment). The close waits only for the tickets and till events of its
   * shift that have **no answer yet** (`attempts = 0`: never sent, in flight or offline), because the server
   * refuses anything naming a closed shift (`assertShiftKnown`) and a close that overtook one would strand
   * it. A row the server has refused has its answer: waiting on it would keep the server's shift open for
   * ever whenever the refusal is deterministic (a stale tax figure, an exceeded limit), with no expected cash,
   * over/short or Z-report. So the close travels, and the refused rows travel with it — `applyBatch` applies
   * tickets and till events before closes, so a refusal cured in the meantime posts before the drawer is
   * derived, and a deterministic one is refused once more. Once the close is acknowledged the row is in
   * `outbox_refused` (schema.sql) and is never offered again: it was never posted, so ADR 0063's ledger-derived
   * expectation leaves it out and the cash the customer paid shows in the shift's over/short.
   *
   * **Rows the server has never answered go first**, refused tickets and till events last, each group in
   * creation order. Otherwise a run of `limit` refused rows at the head would fill every batch, `drainOutbox`
   * would stop on a pass with no progress, and nothing behind them — the close included — would ever leave.
   * Shift messages keep their creation order whatever their answer, so an open always precedes its tickets.
   */
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("outbox limit must be positive");
    const rows = this.db.raw
      .prepare<[number], OutboxDbRow>(
        `select id, kind, ref, payload, attempts, last_error, acked_at
         from outbox
        where acked_at is null
          and not exists (select 1 from outbox_refused r where r.id = outbox.id)
          and (kind <> 'ticket'
               or not exists (select 1 from ticket t where t.id = outbox.ref and t.status <> 'completed'))
          and (kind <> 'shift' or json_extract(payload, '$.kind') <> 'close'
               or (not exists (
                 select 1 from ticket t join outbox pending on pending.kind='ticket' and pending.ref=t.id
                  where t.shift_id=json_extract(outbox.payload,'$.shiftId') and pending.acked_at is null
                    and pending.attempts = 0 and t.status<>'voided'
               ) and not exists (
                 select 1 from outbox pending where pending.kind in ('till_event', 'cash_event')
                   and pending.acked_at is null
                   and pending.attempts = 0
                   and json_extract(pending.payload,'$.shiftId')=json_extract(outbox.payload,'$.shiftId')
               )))
        order by (kind <> 'shift' and attempts > 0), created_at, rowid limit ?`,
      )
      .all(limit);
    // FRESH objects on every call. 6A's `drainOutbox` decides termination from the `BatchResult` and not
    // from the rows it was handed, precisely so a store that snapshots — as this one does — is correct.
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ref: r.ref,
      payload: JSON.parse(r.payload) as unknown,
      attempts: r.attempts,
      lastError: r.last_error,
      ackedAt: r.acked_at,
    }));
  }

  /**
   * Acks the rows the server named, and **only** those (spec:1337).
   *
   * A ref that appears in no array stays pending for ever — that is "never acked on silence" and it is the
   * whole of "zero lost tickets" on the till side. A `rejected` ref is not acked either: it stays pending
   * with its attempt count and the server's error and is sent again, so a refusal the server cures without a
   * new payload — a role granted, a period opened, a colliding customer code freed (ADR 0056's "recoverable
   * refusals") — posts on a later drain. It becomes final only when the server acknowledges the close of the
   * row's shift (`outbox_refused`, `pendingOutbox`).
   */
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const outcomes = new Map<
      string,
      {
        status: string;
        error: { code: string; detail: string } | null;
        number?: string | null;
        documentId?: string | null;
      }
    >();
    for (const row of result.results) outcomes.set(`ticket:${row.clientRef}`, row);
    for (const row of result.shiftResults) outcomes.set(`shift:${row.ref}`, row);
    for (const row of result.tillEventResults) outcomes.set(`till_event:${row.ref}`, row);
    for (const row of result.cashEventResults ?? []) outcomes.set(`cash_event:${row.ref}`, row);
    const now = new Date().toISOString();
    this.db.tx(() => {
      const read = this.db.raw.prepare<
        [string],
        { kind: OutboxRow["kind"]; ref: string; acked_at: string | null; payload: string }
      >("select kind, ref, acked_at, payload from outbox where id = ?");
      const ack = this.db.raw.prepare(
        "update outbox set acked_at = ?, last_error = null where id = ?",
      );
      const fail = this.db.raw.prepare(
        "update outbox set attempts = attempts + 1, last_error = ? where id = ?",
      );
      for (const id of new Set(ids)) {
        const row = read.get(id);
        if (!row || row.acked_at !== null) continue;
        const outcome = outcomes.get(`${row.kind}:${row.ref}`);
        if (!outcome) continue;
        if (outcome.status === "accepted" || outcome.status === "duplicate") {
          ack.run(now, id);
          if (row.kind === "till_event") {
            const event = JSON.parse(row.payload) as {
              kind: string;
              ticketClientRef: string | null;
            };
            if (event.kind === "void" && event.ticketClientRef)
              this.db.raw
                .prepare("update ticket set status='voided' where id=? and status='completed'")
                .run(event.ticketClientRef);
          }
          if (row.kind === "ticket") {
            const payload = JSON.parse(row.payload) as { newCustomer?: { id?: unknown } } | null;
            const customerId = payload?.newCustomer?.id;
            if (typeof customerId === "string")
              this.db.raw
                .prepare("update pending_customer set acked_at=? where id=? and acked_at is null")
                .run(now, customerId);
            const metadata = this.db.raw.prepare(
              "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
            );
            if (outcome.number) metadata.run(`number:${row.ref}`, outcome.number);
            if (outcome.documentId) metadata.run(`document:${row.ref}`, outcome.documentId);
          }
        } else if (outcome.status === "rejected")
          fail.run(
            outcome.error ? `${outcome.error.code}: ${outcome.error.detail}` : "rejected",
            id,
          );
        else throw new TypeError("invalid acknowledgement status");
      }
    });
  }

  /**
   * The till's own outbox writer. Callers invoke it **inside** their own `db.tx(...)`, so the ticket and its
   * outbox row are one local transaction (spec:1303, 1337) — `better-sqlite3` nests transactions as
   * savepoints, so an inner `tx` inside an outer one is correct and does not commit early.
   *
   * Idempotent on `(kind, ref)`: a retry of `sell` for a ticket the till already wrote returns the existing
   * row's id and leaves the **first** payload in place, because that payload matches the ticket rows that
   * are already committed and a second one would describe a ticket nobody has.
   */
  enqueue(kind: OutboxRow["kind"], ref: string, payload: unknown): string {
    const existing = this.db.raw
      .prepare<[string, string], { id: string }>("select id from outbox where kind = ? and ref = ?")
      .get(kind, ref);
    if (existing !== undefined) return existing.id;
    const id = uuidv7();
    this.db.raw
      .prepare(
        "insert into outbox (id, kind, ref, payload, attempts, last_error, acked_at, created_at) values (?, ?, ?, ?, 0, null, null, ?)",
      )
      .run(id, kind, ref, serializeSyncBody(payload), new Date().toISOString());
    return id;
  }

  /** Clear only replicated scope when a drained till receives a replacement identity. */
  resetCatalogue(): void {
    const sqliteDb = this.db;
    sqliteDb.tx(() => {
      sqliteDb.raw.exec(`delete from catalogue_item; delete from catalogue_price_list;
        delete from catalogue_price_list_line; delete from catalogue_promotion;
        delete from catalogue_customer; delete from catalogue_tax_code;
        delete from catalogue_cashier; delete from catalogue_branch_pos_policy;
        delete from sync_cursor; delete from meta where key in ('catalogue_ready','catalogue_pulled_at','branch_id','company_id');`);
    });
  }

  /** Catalogue age, revision and honest pending work: the rows that will still be sent, and the finally
   *  refused ones (`outbox_refused`) counted apart — they are answered, so they are not "still syncing". */
  catalogueState(): {
    revision: bigint;
    pulledAt: string | null;
    pendingOutbox: number;
    refusedOutbox: number;
  } {
    const cursor = this.db.raw
      .prepare<[], { revision: string | null }>(
        "select revision from sync_cursor order by cast(revision as integer) desc limit 1",
      )
      .get();
    const pulled = this.db.raw
      .prepare<[], { value: string }>("select value from meta where key = 'catalogue_pulled_at'")
      .get();
    const unacked = this.db.raw
      .prepare<[], { unacked: number; refused: number }>(
        `select (select count(*) from outbox where acked_at is null) as unacked,
                (select count(*) from outbox_refused) as refused`,
      )
      .get()!;
    return {
      revision: cursor?.revision ? textToRevision(cursor.revision) : 0n,
      pulledAt: pulled?.value ?? null,
      pendingOutbox: unacked.unacked - unacked.refused,
      refusedOutbox: unacked.refused,
    };
  }

  /**
   * Every unacknowledged row the server has refused, for the till's status line (PR 12 review). `retrying`
   * rows are sent again — tickets and till events until their shift's close is acknowledged, shift messages
   * until accepted (6D A10) — and `final` ones never are. A refused till event has no server-side queue (A10),
   * so this is the only place a refused void is visible; `newest` is the reason on the most recent such row.
   */
  outboxRefusals(): { retrying: number; final: number; newest: string | null } {
    const counts = this.db.raw
      .prepare<[], { refused: number; final: number }>(
        `select (select count(*) from outbox where acked_at is null and attempts > 0) as refused,
                (select count(*) from outbox_refused) as final`,
      )
      .get()!;
    const newest = this.db.raw
      .prepare<[], { last_error: string | null }>(
        `select last_error from outbox where acked_at is null and attempts > 0
          order by created_at desc, rowid desc limit 1`,
      )
      .get();
    return {
      retrying: counts.refused - counts.final,
      final: counts.final,
      newest: newest?.last_error ?? null,
    };
  }

  /**
   * Quick-created customers the server has not created yet, for the re-enrolment gate (6B IPC clarification).
   * A customer whose ticket the server finally refused (`outbox_refused`) is not counted: no outbox row will
   * ever create it — the refused payload, `newCustomer` included, is in the server's needs-attention queue —
   * and counting it would refuse re-enrolment for ever. A later sale to it carries it again (`sell`).
   */
  unsyncedCustomers(): number {
    return this.db.raw
      .prepare<[], { n: number }>(
        `select count(*) as n from pending_customer p
          where p.acked_at is null
            and not exists (select 1 from outbox_refused r
                             where r.kind = 'ticket' and json_extract(r.payload, '$.newCustomer.id') = p.id)`,
      )
      .get()!.n;
  }
}

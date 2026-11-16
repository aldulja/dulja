import type { BatchResult, Change, CataloguePage, Stream, TicketBatch } from "./messages";
import { CATALOGUE_STREAMS, SYNC_BATCH_SYNC_LIMIT } from "./messages";
import { encodeSyncCursor } from "./cursor";

/** The local outbox row (§4.10.6 — 6B's SQLite table). `packages/sync` owns the TYPE; 6B owns the table. */
export interface OutboxRow {
  id: string;
  kind: "ticket" | "shift" | "till_event" | "cash_event";
  /** The id the server acknowledges by: `Ticket.clientRef`, `"<shiftId>:<kind>"`, `TillEventMsg.clientRef`,
   *  `TillCashMsg.clientRef`. */
  ref: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  ackedAt: string | null;
}

export interface SyncStore {
  getCursor(stream: Stream): Promise<bigint>;
  /**
   * Applies one page, then advances **every** member of `CATALOGUE_STREAMS` to `max(changes[].revision)` —
   * not only the streams the page happened to carry (§4.10.2, Task 0 amendment 23c).
   *
   * A page is ordered by revision **across all streams**, so a page whose last change is revision *R* has
   * delivered everything at or below *R* for every stream, including the ones with nothing in it. A store
   * that advanced only the touched streams would answer `0n` for every quiet stream for ever — `cashier`
   * and `branch_pos_policy` have no rows at all until 6C ships — and `pullAll`'s minimum-across-streams
   * would then be `0n` on every till in Phase 6: every pull would start from the beginning and no resume
   * would exist. Nothing would throw. **This paragraph is what 6B's SQLite store is measured against.**
   *
   * An empty `changes` array advances nothing.
   */
  applyChanges(changes: Change[]): Promise<void>;
  pendingOutbox(limit: number): Promise<OutboxRow[]>;
  /** Acks all four outbox kinds from one `BatchResult`. A row whose ref appears in NO array stays pending —
   *  never acked on silence (spec:1337). */
  markAcked(ids: string[], result: BatchResult): Promise<void>;
}

/**
 * `pushTickets` rejects with this when the server answered **202** (§4.10.4): the batch went to the
 * `pos.sync.apply` job and there is no per-ticket result yet, so **nothing may be acked**. It is an error
 * rather than a `BatchResult` with three empty arrays precisely because `drainOutbox` must be able to tell
 * "the server acknowledged nothing" from "the server has not answered yet" — the first ends the drain, the
 * second must leave every row pending for the next one.
 */
export class SyncQueuedError extends Error {
  constructor(
    readonly batchId: string,
    readonly jobId: string,
  ) {
    super(`batch ${batchId} was queued as job ${jobId}; re-send to collect per-ticket results`);
    this.name = "SyncQueuedError";
  }
}

export interface SyncTransport {
  pullCatalogue(since: string, limit: number): Promise<CataloguePage>;
  pushTickets(batch: TicketBatch): Promise<BatchResult>;
}

/**
 * Pulls until `has_more` is false, resuming from the store's own cursor.
 *
 * **The cursor is the MINIMUM across streams and this is the whole correctness argument.** The wire cursor is
 * one scalar over eight streams (§4.10.2). If the till resumed from its highest per-stream cursor, every
 * change to a quieter stream between the minimum and the maximum would be skipped for ever — and nothing
 * would fail, which is why it has to be stated rather than assumed. Re-delivering a change the store has
 * already applied is harmless: `applyChanges` is an upsert-or-delete keyed on `(stream, id)`.
 *
 * **This function does NOT catch.** A dropped connection propagates, the store keeps every change it applied
 * and the cursor those changes advanced, and the next call resumes from there. Swallowing the error here
 * would turn "interrupted" into "finished" — the failure acceptance test 20 exists to catch.
 *
 * **The minimum is only meaningful because `applyChanges` advances every stream** (see `SyncStore` above). A
 * store that advanced only the streams a page carried would hold `0n` on `cashier` and `branch_pos_policy`
 * until 6C ships, the minimum would be `0n` on every till, and this function would restart from the
 * beginning on every call while looking perfectly correct.
 */
export async function pullAll(
  store: SyncStore,
  transport: SyncTransport,
  opts: { pageSize?: number } = {},
): Promise<{ applied: number; cursor: string }> {
  const pageSize = opts.pageSize ?? 1000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    throw new RangeError("pageSize must be a positive safe integer");
  // The MINIMUM across streams, not the maximum and not any one stream's. A till that pulled `item` to
  // revision 900 and `tax_code` only to 400 must resume at 400, or revisions 401..900 of the quieter stream
  // are lost for ever and nothing fails — the silent-starvation failure acceptance test 20 exists to catch.
  const cursors = await Promise.all(CATALOGUE_STREAMS.map((st) => store.getCursor(st)));
  // Seeded with `cursors[0]`, never with `0n`: a minimum seeded at zero is always zero, and the till would
  // re-pull the whole catalogue on every start.
  const cursor = cursors.reduce((min, c) => (c < min ? c : min), cursors[0] ?? 0n);

  let applied = 0;
  let wire = cursor === 0n ? "" : encodeSyncCursor({ revision: cursor });
  for (;;) {
    const page = await transport.pullCatalogue(wire, pageSize);
    if (page.changes.length > 0) {
      await store.applyChanges(page.changes);
      applied += page.changes.length;
    }
    wire = page.next_cursor;
    if (!page.has_more) return { applied, cursor: wire };
  }
}

/**
 * Drains the outbox in batches, marking `acked_at` only on acknowledgement (spec:1337).
 *
 * **`terminalId` and `newBatchId` are required** (Task 0 amendment 23a). §4.10.1 fixes `TicketBatch.batchId`
 * as a **uuidv7**, and `crypto.randomUUID()` is a v4 — spec:2037 admits one and not the other — so the
 * generator is injected rather than chosen here: `packages/sync` runs in the Electron main process and has no
 * database to call `uuidv7()` on. `terminalId` is required because `POST /v1/sync/tickets` refuses a batch
 * whose `terminalId` is not the signing terminal, so a `?? ""` default would only move the failure from a
 * type error to a 400 at the till.
 *
 * **A 202 acknowledges nothing.** An over-size batch is applied by the `pos.sync.apply` job (§4.10.4) and
 * returns no per-ticket result, so the transport's `pushTickets` rejects with `SyncQueuedError` and every row
 * stays pending. The till re-sends, and `client_ref` dedup turns the re-send into a stream of `duplicate`
 * acknowledgements — which is why "re-sending a batch changes nothing" is the DoD sentence and not merely a
 * nice property.
 */
export async function drainOutbox(
  store: SyncStore,
  transport: SyncTransport,
  opts: { terminalId: string; newBatchId: () => string; batchSize?: number },
): Promise<{ accepted: number; duplicates: number; rejected: number }> {
  const requestedSize = opts.batchSize ?? SYNC_BATCH_SYNC_LIMIT;
  if (!Number.isSafeInteger(requestedSize) || requestedSize < 1)
    throw new RangeError("batchSize must be a positive safe integer");
  const batchSize = Math.min(requestedSize, SYNC_BATCH_SYNC_LIMIT);
  // Count each outbox row once, even when a partial acknowledgement retries a rejected row.
  const outcomes = new Map<string, "accepted" | "duplicate" | "rejected">();
  const totals = () => ({
    accepted: [...outcomes.values()].filter((status) => status === "accepted").length,
    duplicates: [...outcomes.values()].filter((status) => status === "duplicate").length,
    rejected: [...outcomes.values()].filter((status) => status === "rejected").length,
  });
  for (;;) {
    const pending = await store.pendingOutbox(batchSize);
    if (pending.length === 0) return totals();

    const batch: TicketBatch = {
      terminalId: opts.terminalId,
      batchId: opts.newBatchId(),
      tickets: pending
        .filter((r) => r.kind === "ticket")
        .map((r) => r.payload as TicketBatch["tickets"][number]),
      shifts: pending
        .filter((r) => r.kind === "shift")
        .map((r) => r.payload as TicketBatch["shifts"][number]),
      tillEvents: pending
        .filter((r) => r.kind === "till_event")
        .map((r) => r.payload as TicketBatch["tillEvents"][number]),
    };
    // ⚠️ OD-10: the fourth array travels only when it has something in it, so a till with no cash event to
    // send emits exactly the three-array batch a server without the fourth array accepts (ADR 0064).
    const cashEvents = pending
      .filter((r) => r.kind === "cash_event")
      .map((r) => r.payload as NonNullable<TicketBatch["cashEvents"]>[number]);
    if (cashEvents.length > 0) batch.cashEvents = cashEvents;
    const result = await transport.pushTickets(batch);

    if (result.batchId !== batch.batchId)
      throw new Error("sync acknowledgement names a different batch");

    // Match both kind and ref. A ticket acknowledgement never acknowledges a till event even when their
    // refs happen to be equal. Stores receive fresh row objects, so progress comes from the result itself.
    const byKind = {
      ticket: new Map(result.results.map((r) => [r.clientRef, r.status])),
      shift: new Map(result.shiftResults.map((r) => [r.ref, r.status])),
      till_event: new Map(result.tillEventResults.map((r) => [r.ref, r.status])),
      cash_event: new Map((result.cashEventResults ?? []).map((r) => [r.ref, r.status])),
    };
    let progressed = false;
    for (const row of pending) {
      const status = byKind[row.kind].get(row.ref);
      if (status === undefined) continue;
      outcomes.set(row.id, status);
      if (status !== "rejected") progressed = true;
    }
    await store.markAcked(
      pending.map((r) => r.id),
      result,
    );

    // The ONE exit besides an empty outbox: this pass acknowledged nothing new, so the next pass would send
    // the identical rows and get the identical answer. A rejected row is still pending — it never acks — and
    // without this a batch of pure rejections would re-send for ever.
    if (!progressed) return totals();
  }
}

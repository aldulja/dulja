// packages/sync/test/drain-outbox.test.ts
import { describe, expect, it } from "vitest";
import {
  drainOutbox,
  SyncQueuedError,
  type BatchResult,
  type OutboxRow,
  type SyncStore,
  type SyncTransport,
  type TicketBatch,
} from "../src/index";

/** A counter, not `crypto.randomUUID()`: §4.10.1 fixes `batchId` as a uuidv7 and a test that minted a v4
 *  would be asserting against a shape the wire refuses. The counter also makes the assertions below readable. */
const counter = (): (() => string) => {
  let n = 0;
  return () => `0196ec7d-7300-7000-8000-${(n += 1).toString(16).padStart(12, "0")}`;
};

class Store implements SyncStore {
  readonly outbox: OutboxRow[];
  readonly cursors = new Map<string, bigint>();
  constructor(rows: Pick<OutboxRow, "id" | "kind" | "ref">[]) {
    this.outbox = rows.map((r) => ({
      ...r,
      payload: { ref: r.ref },
      attempts: 0,
      lastError: null,
      ackedAt: null,
    }));
  }
  async getCursor(): Promise<bigint> {
    return 0n;
  }
  async applyChanges(): Promise<void> {
    // `drainOutbox` never pulls, so a call here means the function under test grew a down-sync it should not
    // have. A throw says that; an empty body would let the defect pass as a silent no-op.
    throw new Error(
      "drainOutbox called applyChanges — down-sync belongs to pullAll (pull-all.test.ts)",
    );
  }
  /** Returns FRESH objects on every call, exactly as 6B's SQLite store will. A `drainOutbox` that decided
   *  termination by reading `ackedAt` back off the rows it was handed would loop for ever against this. */
  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    return this.outbox
      .filter((r) => r.ackedAt === null)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async markAcked(ids: string[], result: BatchResult): Promise<void> {
    const refs = {
      ticket: new Set(
        result.results.filter((r) => r.status !== "rejected").map((r) => r.clientRef),
      ),
      shift: new Set(result.shiftResults.filter((r) => r.status !== "rejected").map((r) => r.ref)),
      till_event: new Set(
        result.tillEventResults.filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
      cash_event: new Set(
        (result.cashEventResults ?? []).filter((r) => r.status !== "rejected").map((r) => r.ref),
      ),
    };
    for (const row of this.outbox)
      if (ids.includes(row.id) && refs[row.kind].has(row.ref))
        row.ackedAt = new Date().toISOString();
  }
}

const err = (s: string) =>
  s === "rejected" ? { code: "ERR_VALIDATION_FAILED" as const, detail: "scripted" } : null;

/** Answers each ticket/message by a scripted status looked up on its ref; a ref with no entry is OMITTED from
 *  every array, which is spec:1337's "silence". */
function scriptedTransport(
  script: Record<string, "accepted" | "duplicate" | "rejected">,
): SyncTransport & { sent: TicketBatch[] } {
  const t = {
    sent: [] as TicketBatch[],
    async pullCatalogue(): Promise<never> {
      throw new Error("not used");
    },
    async pushTickets(batch: TicketBatch): Promise<BatchResult> {
      t.sent.push(batch);
      return {
        batchId: batch.batchId,
        results: batch.tickets
          .filter((x) => script[x.clientRef] !== undefined)
          .map((x) => ({
            clientRef: x.clientRef,
            status: script[x.clientRef]!,
            documentId: null,
            number: null,
            error: err(script[x.clientRef]!),
          })),
        shiftResults: batch.shifts
          .map((m) => `${m.shiftId}:${m.kind}`)
          .filter((r) => script[r] !== undefined)
          .map((r) => ({ ref: r, status: script[r]!, error: err(script[r]!) })),
        tillEventResults: batch.tillEvents
          .filter((m) => script[m.clientRef] !== undefined)
          .map((m) => ({
            ref: m.clientRef,
            status: script[m.clientRef]!,
            error: err(script[m.clientRef]!),
          })),
        cashEventResults: (batch.cashEvents ?? [])
          .filter((m) => script[m.clientRef] !== undefined)
          .map((m) => ({
            ref: m.clientRef,
            status: script[m.clientRef]!,
            error: err(script[m.clientRef]!),
          })),
        catalogueCursor: "MA",
      };
    },
  };
  return t;
}

const OPTS = { terminalId: "term-1", newBatchId: counter() };

describe("drainOutbox (§4.10.5) — acked only on acknowledgement (spec:1337)", () => {
  it("three accepted tickets are all acked and the loop terminates", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" },
      { id: "o2", kind: "ticket", ref: "t2" },
      { id: "o3", kind: "ticket", ref: "t3" },
    ]);
    // `payload.ref` is what the scripted transport reads back as `clientRef`; the rows carry it as `payload`.
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted", t2: "accepted", t3: "accepted" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(store.outbox.every((r) => r.ackedAt !== null)).toBe(true);
    // Two passes: one that sent three, one that found the outbox empty. Never three, and never unbounded —
    // and this is the assertion that fails if termination reads `ackedAt` off the returned rows, because
    // `pendingOutbox` above hands out copies.
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.terminalId).toBe("term-1");
    expect(t.sent[0]!.batchId).toBe("0196ec7d-7300-7000-8000-000000000001");
  });

  it("accepted + duplicate + rejected: two ack, the rejected one stays pending, and the drain STOPS", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" },
      { id: "o2", kind: "ticket", ref: "t2" },
      { id: "o3", kind: "ticket", ref: "t3" },
    ]);
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted", t2: "duplicate", t3: "rejected" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 1, duplicates: 1, rejected: 1 });
    expect(store.outbox.find((r) => r.id === "o3")!.ackedAt).toBeNull();
    // A second pass sends only t3, acknowledges nothing new, and ends. Without the "nothing new" exit this
    // loop would re-send the same rejection until the process died.
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.tickets).toHaveLength(1);
  });

  it("a shift and a till event ack through their OWN result arrays (§4.10.1's two extra arrays)", async () => {
    const store = new Store([
      { id: "o1", kind: "shift", ref: "sh-1:open" },
      { id: "o2", kind: "till_event", ref: "te-1" },
    ]);
    store.outbox[0]!.payload = { shiftId: "sh-1", kind: "open" };
    store.outbox[1]!.payload = { clientRef: "te-1" };
    const t = scriptedTransport({ "sh-1:open": "accepted", "te-1": "accepted" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(store.outbox.every((r) => r.ackedAt !== null)).toBe(true);
    // Without shiftResults and tillEventResults these two kinds could never ack and would re-send for ever
    // (spec:1337) — which is the whole reason §4.10.1 carries three arrays and not one.
  });

  it("⚠️ OD-10: a cash event travels in the fourth array, acks through cashEventResults, and an empty one is not sent", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" },
      { id: "o2", kind: "cash_event", ref: "ce-1" },
    ]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    store.outbox[1]!.payload = { clientRef: "ce-1", kind: "safe_drop" };
    const t = scriptedTransport({ t1: "accepted", "ce-1": "accepted" });
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(store.outbox.every((r) => r.ackedAt !== null)).toBe(true);
    expect(t.sent[0]!.cashEvents).toEqual([{ clientRef: "ce-1", kind: "safe_drop" }]);
    expect(t.sent[0]!.tickets.map((x) => x.clientRef)).toEqual(["t1"]);

    // A batch with no cash event is the three-array batch an older server accepts: the key is absent.
    const plain = new Store([{ id: "o3", kind: "ticket", ref: "t2" }]);
    plain.outbox[0]!.payload = { clientRef: "t2" };
    const t2 = scriptedTransport({ t2: "accepted" });
    await drainOutbox(plain, t2, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect("cashEvents" in t2.sent[0]!).toBe(false);
  });

  it("a ref that appears in NO array stays pending — never acked on silence (spec:1337)", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" },
      { id: "o2", kind: "ticket", ref: "t2" },
    ]);
    for (const r of store.outbox) r.payload = { clientRef: r.ref };
    const t = scriptedTransport({ t1: "accepted" }); // t2 is simply absent from every array
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 10 });
    expect(out).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(store.outbox.find((r) => r.id === "o2")!.ackedAt).toBeNull();
  });

  it("a 202 acknowledges nothing: SyncQueuedError propagates and every row stays pending", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    const t: SyncTransport = {
      async pullCatalogue(): Promise<never> {
        throw new Error("not used");
      },
      async pushTickets(b) {
        throw new SyncQueuedError(b.batchId, "job-9");
      },
    };
    await expect(drainOutbox(store, t, { ...OPTS, newBatchId: counter() })).rejects.toBeInstanceOf(
      SyncQueuedError,
    );
    expect(store.outbox[0]!.ackedAt, "a queued batch acks nothing").toBeNull();
  });

  it("clamps oversized batches and mints a fresh uuidv7 for each send", async () => {
    const store = new Store(
      Array.from({ length: 201 }, (_, index) => ({
        id: `o${index}`,
        kind: "ticket" as const,
        ref: `t${index}`,
      })),
    );
    for (const row of store.outbox) row.payload = { clientRef: row.ref };
    const t = scriptedTransport(
      Object.fromEntries(store.outbox.map((row) => [row.ref, "accepted"])),
    );
    const out = await drainOutbox(store, t, { ...OPTS, newBatchId: counter(), batchSize: 999 });
    expect(out).toEqual({ accepted: 201, duplicates: 0, rejected: 0 });
    expect(t.sent.map((batch) => batch.tickets.length)).toEqual([200, 1]);
    expect(new Set(t.sent.map((batch) => batch.batchId)).size).toBe(2);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    "refuses invalid batchSize %s without sending or acking",
    async (batchSize) => {
      const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
      const t = scriptedTransport({ t1: "accepted" });
      await expect(drainOutbox(store, t, { ...OPTS, batchSize })).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(t.sent).toHaveLength(0);
      expect(store.outbox[0]!.ackedAt).toBeNull();
    },
  );

  it("a dropped transport keeps pending rows for the next drain", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    const t = scriptedTransport({ t1: "duplicate" });
    const failed: SyncTransport = {
      ...t,
      async pushTickets() {
        throw new Error("ECONNRESET");
      },
    };
    await expect(drainOutbox(store, failed, OPTS)).rejects.toThrow("ECONNRESET");
    expect(store.outbox[0]!.ackedAt).toBeNull();
    expect(await drainOutbox(store, t, OPTS)).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
  });

  it("an acknowledgement for another batch leaves every row pending", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    const t = scriptedTransport({ t1: "accepted" });
    const wrong: SyncTransport = {
      ...t,
      async pushTickets(batch) {
        return { ...(await t.pushTickets(batch)), batchId: "another-batch" };
      },
    };
    await expect(drainOutbox(store, wrong, OPTS)).rejects.toThrow("different batch");
    expect(store.outbox[0]!.ackedAt).toBeNull();
  });

  it("acks only the matching message kind and ignores results for refs outside the sent batch", async () => {
    const store = new Store([{ id: "o1", kind: "till_event", ref: "same-ref" }]);
    store.outbox[0]!.payload = { clientRef: "same-ref" };
    const t: SyncTransport = {
      async pullCatalogue(): Promise<never> {
        throw new Error("not used");
      },
      async pushTickets(batch) {
        return {
          batchId: batch.batchId,
          results: [
            {
              clientRef: "same-ref",
              status: "accepted",
              documentId: null,
              number: null,
              error: null,
            },
          ],
          shiftResults: [{ ref: "unrelated-ref", status: "accepted", error: null }],
          tillEventResults: [],
          catalogueCursor: "MA",
        };
      },
    };
    expect(await drainOutbox(store, t, OPTS)).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });
    expect(store.outbox[0]!.ackedAt).toBeNull();
  });

  it("a rejected row later accepted in the same drain is counted once with its final outcome", async () => {
    const store = new Store([
      { id: "o1", kind: "ticket", ref: "t1" },
      { id: "o2", kind: "ticket", ref: "t2" },
    ]);
    for (const row of store.outbox) row.payload = { clientRef: row.ref };
    const first = scriptedTransport({ t1: "rejected", t2: "accepted" });
    const retry = scriptedTransport({ t1: "accepted" });
    let calls = 0;
    const t: SyncTransport = {
      ...first,
      async pushTickets(batch) {
        calls += 1;
        return calls === 1 ? first.pushTickets(batch) : retry.pushTickets(batch);
      },
    };
    expect(await drainOutbox(store, t, OPTS)).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(calls).toBe(2);
    expect(store.outbox.every((row) => row.ackedAt !== null)).toBe(true);
  });

  it("a failed local acknowledgement can replay server duplicates on the next drain", async () => {
    const store = new Store([{ id: "o1", kind: "ticket", ref: "t1" }]);
    store.outbox[0]!.payload = { clientRef: "t1" };
    const broken: SyncStore = {
      getCursor: store.getCursor.bind(store),
      applyChanges: store.applyChanges.bind(store),
      pendingOutbox: store.pendingOutbox.bind(store),
      async markAcked(): Promise<never> {
        throw new Error("local commit failed");
      },
    };
    await expect(drainOutbox(broken, scriptedTransport({ t1: "accepted" }), OPTS)).rejects.toThrow(
      "local commit failed",
    );
    expect(store.outbox[0]!.ackedAt).toBeNull();
    expect(await drainOutbox(store, scriptedTransport({ t1: "duplicate" }), OPTS)).toEqual({
      accepted: 0,
      duplicates: 1,
      rejected: 0,
    });
    expect(store.outbox[0]!.ackedAt).not.toBeNull();
  });
});

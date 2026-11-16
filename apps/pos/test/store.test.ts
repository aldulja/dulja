// apps/pos/test/store.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE_STREAMS, type BatchResult, type Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";

let db: PosDatabase;
let store: SqliteSyncStore;
const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
  dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const itemChange = (n: number, rev: bigint): Change => ({
  stream: "item",
  op: "upsert",
  id: `item-${n}`,
  revision: rev,
  row: {
    id: `item-${n}`,
    code: `SKU-${n}`,
    barcode: `900000000${n}`,
    name_en: `Item ${n}`,
    name_ar: null,
    kind: "product",
    base_unit_id: "unit-1",
    track_lots: false,
    company_id: "co-1",
  },
});

/** One answer for ticket `t-1`: accepted, or refused for an exceeded limit. */
const answerT1 = (status: "accepted" | "rejected"): BatchResult => ({
  batchId: "b",
  results: [
    {
      clientRef: "t-1",
      status,
      documentId: status === "accepted" ? "d" : null,
      number: status === "accepted" ? "n" : null,
      error: status === "accepted" ? null : { code: "ERR_POS_LIMIT_EXCEEDED", detail: "limit" },
    },
  ],
  shiftResults: [],
  tillEventResults: [],
  catalogueCursor: "MQ",
});

describe("SqliteSyncStore — 6A's SyncStore over the local file", () => {
  it("never regresses a mirror or any cursor on a replayed older page", async () => {
    await store.applyChanges([itemChange(1, 9007199254740993n)]);
    await store.applyChanges([{ ...itemChange(1, 3n), op: "delete", row: null }]);
    expect(db.raw.prepare("select revision from catalogue_item").get()).toEqual({
      revision: "9007199254740993",
    });
    for (const stream of CATALOGUE_STREAMS)
      expect(await store.getCursor(stream)).toBe(9007199254740993n);
  });

  it("rolls back the whole page and all eight cursors for malformed indexed fields or order", async () => {
    const bad = { ...itemChange(2, 2n), row: { ...(itemChange(2, 2n).row as object), name_en: 5 } };
    await expect(store.applyChanges([itemChange(1, 1n), bad])).rejects.toThrow();
    expect(db.raw.prepare("select * from catalogue_item").all()).toEqual([]);
    for (const stream of CATALOGUE_STREAMS) expect(await store.getCursor(stream)).toBe(0n);
    await expect(store.applyChanges([itemChange(1, 2n), itemChange(2, 1n)])).rejects.toThrow(
      "ordered",
    );
    expect(db.raw.prepare("select * from catalogue_item").all()).toEqual([]);
  });

  it("holds open and voided tickets while allowing completed and bare protocol rows", async () => {
    db.raw
      .prepare(
        "insert into shift (id,terminal_id,cashier_principal_id,opened_at,opening_float,currency) values ('s','t','c','2026-10-09T00:00:00Z','0.0000','MYR')",
      )
      .run();
    const ticket = db.raw.prepare(
      "insert into ticket (id,shift_id,cashier_principal_id,kind,status,currency,net_total,tax_total,total,catalogue_revision,created_at) values (?,'s','c','sale',?,'MYR','0.0000','0.0000','0.0000','0','2026-10-09T00:00:00Z')",
    );
    for (const status of ["open", "voided", "completed"]) {
      ticket.run(status, status);
      store.enqueue("ticket", status, {});
    }
    store.enqueue("ticket", "bare", {});
    store.enqueue("till_event", "open", {});
    expect((await store.pendingOutbox(10)).map((row) => `${row.kind}:${row.ref}`)).toEqual([
      "ticket:completed",
      "ticket:bare",
      "till_event:open",
    ]);
  });

  it("matches acknowledgements by kind and ref and ignores silence and repeated IDs", async () => {
    const ticket = store.enqueue("ticket", "same", { catalogueRevision: 9007199254740993n });
    const event = store.enqueue("till_event", "same", {});
    const shift = store.enqueue("shift", "silent", {});
    await store.markAcked([ticket, event, event, shift], {
      batchId: "b",
      results: [
        { clientRef: "same", status: "accepted", documentId: "d", number: "n", error: null },
      ],
      shiftResults: [],
      tillEventResults: [
        {
          ref: "same",
          status: "rejected",
          error: { code: "ERR_SYNC_MESSAGE_UNSUPPORTED", detail: "later" },
        },
      ],
      catalogueCursor: "",
    });
    // Both stay pending; the silent shift message, never answered, travels before the refused event (R12).
    expect((await store.pendingOutbox(10)).map((row) => [row.kind, row.attempts])).toEqual([
      ["shift", 0],
      ["till_event", 1],
    ]);
    expect(db.raw.prepare("select payload from outbox where kind='ticket'").get()).toEqual({
      payload: '{"catalogueRevision":"9007199254740993"}',
    });
  });
  it("getCursor answers 0n for a stream that has never been pulled", async () => {
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(0n);
  });

  it("applyChanges advances EVERY stream to the page's highest revision, not only the ones it carried", async () => {
    // §4.10.5, 6A Task 0 amendment 23c. A page is ordered by revision ACROSS streams, so a page ending at
    // revision R has delivered everything <= R for every stream — including the quiet ones. `cashier` and
    // `branch_pos_policy` are empty on a fresh company; a store that advanced only `item` would answer 0n
    // for them for ever, pullAll's minimum-across-streams would be 0n on every till, and every pull would
    // restart from page one. Nothing would throw. This is the assertion that catches it.
    await store.applyChanges([itemChange(1, 10n), itemChange(3, 20n), itemChange(2, 30n)]);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(30n);
  });

  it("an empty page advances nothing", async () => {
    await store.applyChanges([itemChange(1, 5n)]);
    await store.applyChanges([]);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(5n);
  });

  it("a revision past 2^53 survives the round trip — the reason the column is TEXT", async () => {
    await store.applyChanges([itemChange(1, 9007199254740993n)]);
    expect(await store.getCursor("item")).toBe(9007199254740993n);
    expect(BigInt(Number(await store.getCursor("item")))).not.toBe(9007199254740993n);
  });

  it("an upsert extracts the indexed columns and keeps the whole server row", async () => {
    await store.applyChanges([itemChange(7, 1n)]);
    const row = db.raw
      .prepare<[], { code: string; barcode: string; row_json: string; revision: string }>(
        "select code, barcode, row_json, revision from catalogue_item where id = 'item-7'",
      )
      .get()!;
    expect(row.code).toBe("SKU-7");
    expect(row.barcode).toBe("9000000007");
    expect(row.revision).toBe("1");
    expect(JSON.parse(row.row_json)).toMatchObject({ company_id: "co-1", kind: "product" });
  });

  it("a tombstone deletes the mirror row and still advances the cursor", async () => {
    await store.applyChanges([itemChange(7, 1n)]);
    await store.applyChanges([
      { stream: "item", op: "delete", id: "item-7", revision: 2n, row: null },
    ]);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n,
    ).toBe(0);
    expect(await store.getCursor("item")).toBe(2n);
  });

  it("a re-applied page is idempotent — the same change twice leaves one row", async () => {
    await store.applyChanges([itemChange(7, 1n), itemChange(7, 1n)]);
    await store.applyChanges([itemChange(7, 1n)]);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n,
    ).toBe(1);
  });

  it("applyChanges is one transaction: a bad change leaves the cursor and every row untouched", async () => {
    await store.applyChanges([itemChange(1, 5n)]);
    const bad: Change = { stream: "item", op: "upsert", id: "item-2", revision: 9n, row: null };
    await expect(store.applyChanges([itemChange(2, 8n), bad])).rejects.toThrow();
    expect(await store.getCursor("item")).toBe(5n);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n,
    ).toBe(1);
  });

  it("enqueue and pendingOutbox round-trip in insertion order, capped at the limit", async () => {
    for (let n = 1; n <= 5; n += 1) store.enqueue("ticket", `ref-${n}`, { clientRef: `ref-${n}` });
    const pending = await store.pendingOutbox(3);
    expect(pending.map((r) => r.ref)).toEqual(["ref-1", "ref-2", "ref-3"]);
    expect(pending[0]!.kind).toBe("ticket");
    expect(pending[0]!.ackedAt).toBeNull();
    expect(pending[0]!.payload).toEqual({ clientRef: "ref-1" });
  });

  it("an UNTENDERED ticket is not drainable, and becomes drainable the moment its status leaves 'open'", async () => {
    // `sell` writes the outbox row with `tenders: []` inside the sale's transaction and leaves the ticket
    // `open`; `tender` replaces the payload and flips the status. The 15-second drain loop must not push the
    // half-finished ticket in between: 6A's POS_TICKET policy balances tenders against amount + tax with no
    // residual leg, so an empty-tender ticket is refused and lands in `app.needs_attention` — one false row
    // per sale where the cashier took longer than one tick to collect the money.
    db.raw
      .prepare(
        `insert into shift (id, terminal_id, cashier_principal_id, opened_at, opening_float, currency)
       values ('sh-1', 'term-1', 'p-1', '2026-06-15T08:00:00.000Z', '100.0000', 'MYR')`,
      )
      .run();
    const insertTicket = db.raw.prepare(
      `insert into ticket (id, shift_id, cashier_principal_id, customer_id, kind, returns_client_ref, status,
                           currency, net_total, tax_total, total, catalogue_revision, created_at)
       values (?, 'sh-1', 'p-1', null, 'sale', null, ?, 'MYR', '10.0000', '1.0000', '11.0000', '12', ?)`,
    );
    insertTicket.run("tk-open", "open", "2026-06-15T09:00:00.000Z");
    store.enqueue("ticket", "tk-open", { clientRef: "tk-open", tenders: [] });
    // A shift message enqueued at the same moment still travels — the hold-back is per ticket, and a shift
    // ref (`"<shiftId>:<kind>"`) can never name a ticket row.
    store.enqueue("shift", "sh-1:open", { shiftId: "sh-1", kind: "open" });
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual(["sh-1:open"]);

    // `tender`'s own update, in isolation: the status flips and the row is eligible on the very next drain.
    db.raw.prepare("update ticket set status = 'completed' where id = 'tk-open'").run();
    expect((await store.pendingOutbox(10)).map((r) => r.ref).toSorted()).toEqual([
      "sh-1:open",
      "tk-open",
    ]);

    // And a ticket row that does not exist at all is never held back — that is what every other case here
    // enqueues, and it is what keeps this clause from becoming a trap for a caller with no local ticket.
    store.enqueue("ticket", "tk-nowhere", { clientRef: "tk-nowhere" });
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toContain("tk-nowhere");
  });

  it("pendingOutbox returns FRESH objects every call — 6A's drainOutbox is written against that", async () => {
    store.enqueue("ticket", "ref-1", {});
    const a = await store.pendingOutbox(10);
    const b = await store.pendingOutbox(10);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toEqual(b[0]);
  });

  it("markAcked acks only refs the server named, and NEVER on silence (spec:1337)", async () => {
    for (const ref of ["t-1", "t-2", "t-3"]) store.enqueue("ticket", ref, { clientRef: ref });
    store.enqueue("shift", "s-1:open", { shiftId: "s-1", kind: "open" });
    const ids = (await store.pendingOutbox(10)).map((r) => r.id);
    const result: BatchResult = {
      batchId: "b-1",
      results: [
        {
          clientRef: "t-1",
          status: "accepted",
          documentId: "d-1",
          number: "POS-T1-000001",
          error: null,
        },
        {
          clientRef: "t-2",
          status: "rejected",
          documentId: null,
          number: null,
          error: { code: "ERR_STOCK_INSUFFICIENT", detail: "no stock" },
        },
        // t-3 is ABSENT — the server said nothing about it. It must stay pending.
      ],
      shiftResults: [
        {
          ref: "s-1:open",
          status: "rejected",
          error: { code: "ERR_SYNC_MESSAGE_UNSUPPORTED", detail: "6D" },
        },
      ],
      tillEventResults: [],
      catalogueCursor: "MQ",
    };
    await store.markAcked(ids, result);
    const stillPending = (await store.pendingOutbox(10)).map((r) => r.ref).toSorted();
    expect(stillPending).toEqual(["s-1:open", "t-2", "t-3"]);
    const rejected = db.raw
      .prepare<[], { attempts: number; last_error: string }>(
        "select attempts, last_error from outbox where ref = 't-2'",
      )
      .get()!;
    expect(rejected.attempts).toBe(1);
    expect(rejected.last_error).toContain("ERR_STOCK_INSUFFICIENT");
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 3, refusedOutbox: 0 });
  });

  /**
   * R12 (PR 12 review), second pass. A refusal is final only once the server has acknowledged the close of the
   * row's shift: before it, a refusal the server can cure with no change to the payload (a role granted, a
   * period opened, a customer code freed — ADR 0056's "recoverable refusals") must still post. The first fix
   * made every refusal final at once, so such a sale was never re-sent and never posted.
   */
  it("a refused ticket travels again while its shift is open, and an acceptance then acks it", async () => {
    store.enqueue("ticket", "t-1", { clientRef: "t-1", shiftId: "s-1" });
    const [row] = await store.pendingOutbox(10);
    await store.markAcked([row!.id], answerT1("rejected"));
    expect((await store.pendingOutbox(10)).map((r) => [r.ref, r.attempts])).toEqual([["t-1", 1]]);
    await store.markAcked([row!.id], answerT1("accepted"));
    expect(
      db.raw.prepare("select attempts, last_error, acked_at from outbox where id = ?").get(row!.id),
    ).toEqual({ attempts: 1, last_error: null, acked_at: expect.any(String) });
    expect(store.outboxRefusals()).toEqual({ retrying: 0, final: 0, newest: null });
  });

  it("a refusal becomes final when the server acknowledges its shift's close — not before, and not for a shift message", async () => {
    const t1 = store.enqueue("ticket", "t-1", { clientRef: "t-1", shiftId: "s-1" });
    const open = store.enqueue("shift", "s-1:open", { shiftId: "s-1", kind: "open" });
    await store.markAcked([t1, open], {
      ...answerT1("rejected"),
      shiftResults: [
        { ref: "s-1:open", status: "rejected", error: { code: "ERR_RBAC_FORBIDDEN", detail: "x" } },
      ],
    });
    const close = store.enqueue("shift", "s-1:close", { shiftId: "s-1", kind: "close" });
    // The refused open and the close keep creation order; the refused ticket travels after them.
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual([
      "s-1:open",
      "s-1:close",
      "t-1",
    ]);
    // The server refuses the close as well (its open has not landed), so nothing is final yet.
    await store.markAcked([close], {
      ...answerT1("rejected"),
      results: [],
      shiftResults: [
        {
          ref: "s-1:close",
          status: "rejected",
          error: { code: "ERR_CONFLICT_REFERENCE", detail: "y" },
        },
      ],
    });
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 3, refusedOutbox: 0 });
    await store.markAcked([t1, open, close], {
      ...answerT1("rejected"),
      shiftResults: [
        { ref: "s-1:open", status: "accepted", error: null },
        { ref: "s-1:close", status: "accepted", error: null },
      ],
    });
    expect(await store.pendingOutbox(10)).toEqual([]);
    expect(
      db.raw.prepare("select attempts, last_error, acked_at from outbox where id = ?").get(t1),
    ).toEqual({ attempts: 2, last_error: "ERR_POS_LIMIT_EXCEEDED: limit", acked_at: null });
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 1 });
    expect(store.outboxRefusals()).toEqual({
      retrying: 0,
      final: 1,
      newest: "ERR_POS_LIMIT_EXCEEDED: limit",
    });
  });

  it("never-answered rows travel before refused tickets, so a batch of refusals cannot starve the close", async () => {
    const refused = ["t-1", "t-2", "t-3"].map((ref) =>
      store.enqueue("ticket", ref, { clientRef: ref, shiftId: "s-1" }),
    );
    await store.markAcked(refused, {
      ...answerT1("rejected"),
      results: ["t-1", "t-2", "t-3"].map((clientRef) => ({
        clientRef,
        status: "rejected" as const,
        documentId: null,
        number: null,
        error: { code: "ERR_PERIOD_NOT_OPEN" as const, detail: "closed" },
      })),
    });
    store.enqueue("shift", "s-1:close", { shiftId: "s-1", kind: "close" });
    store.enqueue("ticket", "t-4", { clientRef: "t-4", shiftId: "s-2" });
    // Before the fix a batch of two held only t-1 and t-2: every pass refused, `drainOutbox` stopped on a pass
    // with no progress, and the close and t-4 behind them never left the till.
    expect((await store.pendingOutbox(2)).map((r) => r.ref)).toEqual(["s-1:close", "t-4"]);
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual([
      "s-1:close",
      "t-4",
      "t-1",
      "t-2",
      "t-3",
    ]);
  });

  it("a till file written before outbox_refused gains the view on its next open", async () => {
    const file = db.raw.name;
    store.enqueue("ticket", "t-1", { clientRef: "t-1", shiftId: "s-1" });
    db.raw.exec("drop view outbox_refused");
    db.close();
    db = openPosDatabase(file);
    store = new SqliteSyncStore(db);
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 1, refusedOutbox: 0 });
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual(["t-1"]);
  });

  it("a duplicate acknowledgement acks the row — a re-send is how a till recovers", async () => {
    store.enqueue("ticket", "t-1", {});
    const ids = (await store.pendingOutbox(10)).map((r) => r.id);
    await store.markAcked(ids, {
      batchId: "b",
      results: [
        { clientRef: "t-1", status: "duplicate", documentId: "d", number: "n", error: null },
      ],
      shiftResults: [],
      tillEventResults: [],
      catalogueCursor: "MQ",
    });
    expect(await store.pendingOutbox(10)).toEqual([]);
  });

  it("enqueue is idempotent on (kind, ref) — a retry of `sell` never doubles the outbox", () => {
    const first = store.enqueue("ticket", "t-1", { v: 1 });
    const second = store.enqueue("ticket", "t-1", { v: 2 });
    expect(second).toBe(first);
    expect(db.raw.prepare<[], { n: number }>("select count(*) as n from outbox").get()!.n).toBe(1);
    // The FIRST payload wins: the ticket is already written and its payload is what the server must see.
    expect(
      JSON.parse(
        db.raw.prepare<[], { payload: string }>("select payload from outbox").get()!.payload,
      ),
    ).toEqual({ v: 1 });
  });

  it("catalogueState reports the revision, the pull time and the pending count (spec:1356)", async () => {
    expect(store.catalogueState()).toEqual({
      revision: 0n,
      pulledAt: null,
      pendingOutbox: 0,
      refusedOutbox: 0,
    });
    await store.applyChanges([itemChange(1, 12n)]);
    store.enqueue("ticket", "t-1", {});
    const state = store.catalogueState();
    expect(state.revision).toBe(12n);
    expect(state.pendingOutbox).toBe(1);
    expect(Date.parse(state.pulledAt!)).toBeGreaterThan(0);
  });
});

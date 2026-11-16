// apps/pos/test/loops.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import {
  CATALOGUE_STREAMS,
  encodeSyncCursor,
  type BatchResult,
  type CataloguePage,
  type Change,
  type SyncTransport,
  type TicketBatch,
} from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { TransportOfflineError } from "../src/main/transport";

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

/** 52 catalogue changes: 50 item upserts at revisions 1..50 and, at revision 7, a tombstone for item-7 that
 *  arrives LATER in revision order, so a resume that skipped a page would leave the deleted row behind. */
const corpus: Change[] = [
  ...Array.from({ length: 50 }, (_, i): Change => ({
    stream: "item",
    op: "upsert",
    id: `item-${i + 1}`,
    revision: BigInt(i + 1),
    row: {
      id: `item-${i + 1}`,
      code: `SKU-${i + 1}`,
      barcode: null,
      name_en: `I${i + 1}`,
      name_ar: null,
      kind: "product",
      base_unit_id: "u-1",
      track_lots: false,
    },
  })),
  { stream: "item", op: "delete", id: "item-7", revision: 51n, row: null },
  {
    stream: "tax_code",
    op: "upsert",
    id: "tc-1",
    revision: 52n,
    row: {
      id: "tc-1",
      code: "SYN-OUT-STD",
      rate: "0.11000000",
      kind: "output",
      rounding_mode: "HALF_AWAY_FROM_ZERO",
      output_account_id: "acct-2300",
      input_account_id: null,
      effective_from: "2026-01-01",
      effective_to: null,
    },
  },
];

function server(all: Change[], pageSize: number, dieAfterPages = Infinity): SyncTransport {
  let pages = 0;
  return {
    async pullCatalogue(since: string): Promise<CataloguePage> {
      if (pages >= dieAfterPages) throw new TransportOfflineError(new Error("ECONNRESET"));
      pages += 1;
      const from = since === "" ? 0n : BigInt(Buffer.from(since, "base64url").toString("utf8"));
      const slice = all.filter((c) => c.revision > from).slice(0, pageSize);
      const last = slice.at(-1)?.revision ?? from;
      return {
        changes: slice,
        next_cursor: encodeSyncCursor({ revision: last }),
        has_more: all.some((c) => c.revision > last),
      };
    },
    async pushTickets(batch: TicketBatch) {
      return {
        batchId: batch.batchId,
        results: [],
        shiftResults: [],
        tillEventResults: [],
        catalogueCursor: "MQ",
      };
    },
  };
}

describe("the till's sync loops — acceptance test 20's till half", () => {
  it("serialises manual calls, clears the old identity immediately and awaits it before rebinding", async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let oldCalls = 0;
    let newCalls = 0;
    const old: SyncTransport = {
      async pullCatalogue() {
        oldCalls += 1;
        started();
        await held;
        return { changes: [], next_cursor: "MA", has_more: false };
      },
      async pushTickets() {
        throw new Error("old device must not drain");
      },
    };
    const next: SyncTransport = {
      async pullCatalogue() {
        newCalls += 1;
        return { changes: [], next_cursor: "MA", has_more: false };
      },
      async pushTickets() {
        throw new Error("empty outbox");
      },
    };
    const loops = createSyncLoops({
      store,
      transport: old,
      terminalId: "old",
      newBatchId: () => "b",
    });
    const first = loops.pullNow();
    await begun;
    const queued = loops.pullNow();
    let installed = false;
    const rebinding = loops.rebind(next, "next").then(() => {
      installed = true;
    });
    expect(loops.state().online).toBe(false);
    expect(installed).toBe(false);
    release();
    await Promise.all([first, queued, rebinding]);
    expect(oldCalls).toBe(1);
    expect(newCalls).toBe(0);
    await loops.pullNow();
    expect(newCalls).toBe(1);
    expect(loops.state().online).toBe(true);
  });
  it("kills the pull mid-transfer, resumes from the cursor, applies nothing twice and misses no deletion", async () => {
    const dying = createSyncLoops({
      store,
      transport: server(corpus, 10, 3),
      terminalId: "t",
      newBatchId: () => "b",
    });
    await expect(dying.pullNow()).rejects.toBeInstanceOf(TransportOfflineError);
    expect(
      db.raw.prepare("select value from meta where key='catalogue_ready'").get(),
    ).toBeUndefined();
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n,
    ).toBe(30);
    expect(
      db.raw
        .prepare<[], { n: number }>("select count(*) as n from catalogue_item where id = 'item-7'")
        .get()!.n,
    ).toBe(1);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(30n);

    const resumed = createSyncLoops({
      store,
      transport: server(corpus, 10),
      terminalId: "t",
      newBatchId: () => "b",
    });
    await resumed.pullNow();
    expect(db.raw.prepare("select value from meta where key='catalogue_ready'").get()).toEqual({
      value: "1",
    });
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_item").get()!.n,
    ).toBe(49);
    expect(
      db.raw
        .prepare<[], { n: number }>("select count(*) as n from catalogue_item where id = 'item-7'")
        .get()!.n,
    ).toBe(0);
    expect(
      db.raw.prepare<[], { n: number }>("select count(*) as n from catalogue_tax_code").get()!.n,
    ).toBe(1);
    for (const s of CATALOGUE_STREAMS) expect(await store.getCursor(s), s).toBe(52n);
  });

  it("state() reports honestly: offline until a pull succeeds, with the revision and its arrival time", async () => {
    const loops = createSyncLoops({
      store,
      transport: server(corpus, 100, 0),
      terminalId: "t",
      newBatchId: () => "b",
    });
    expect(loops.state()).toMatchObject({
      online: false,
      lastPullAt: null,
      catalogueRevision: "0",
      pendingOutbox: 0,
    });
    await expect(loops.pullNow()).rejects.toBeInstanceOf(TransportOfflineError);
    // ⚠️ `online` stays FALSE and `lastError` names the failure. spec:1356 asks for "a visible, HONEST
    // indicator of sync state and last-catalogue-update time"; a loop that swallowed the error and showed a
    // green light would be the dishonest one, and a shop would sell all day at stale prices believing it.
    expect(loops.state().online).toBe(false);
    expect(loops.state().lastError).toContain("ECONNRESET");

    const good = createSyncLoops({
      store,
      transport: server(corpus, 100),
      terminalId: "t",
      newBatchId: () => "b",
    });
    await good.pullNow();
    expect(good.state()).toMatchObject({ online: true, catalogueRevision: "52", lastError: null });
    expect(Date.parse(good.state().lastPullAt!)).toBeGreaterThan(0);
  });

  it("with no transport at all — a till that has never enrolled — every loop is a no-op that reports offline", async () => {
    const loops = createSyncLoops({
      store,
      transport: null,
      terminalId: "t",
      newBatchId: () => "b",
    });
    await loops.pullNow();
    await loops.drainNow();
    expect(loops.state().online).toBe(false);
    expect(loops.state().lastError).toContain("not enrolled");
  });

  it("drainNow sends the outbox in batches capped at SYNC_BATCH_SYNC_LIMIT and acks what the server named", async () => {
    for (let n = 1; n <= 3; n += 1) store.enqueue("ticket", `t-${n}`, { clientRef: `t-${n}` });
    const sent: TicketBatch[] = [];
    const transport: SyncTransport = {
      async pullCatalogue() {
        return { changes: [], next_cursor: "", has_more: false };
      },
      async pushTickets(batch) {
        sent.push(batch);
        return {
          batchId: batch.batchId,
          results: batch.tickets.map((t) => ({
            clientRef: t.clientRef,
            status: "accepted" as const,
            documentId: "d",
            number: "n",
            error: null,
          })),
          shiftResults: [],
          tillEventResults: [],
          catalogueCursor: "MQ",
        };
      },
    };
    const loops = createSyncLoops({
      store,
      transport,
      terminalId: "term-9",
      newBatchId: () => "batch-1",
    });
    await loops.drainNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.terminalId).toBe("term-9");
    expect(await store.pendingOutbox(10)).toEqual([]);
    expect(loops.state().pendingOutbox).toBe(0);
  });

  it("a queued (202) push acks nothing and leaves every row pending", async () => {
    store.enqueue("ticket", "t-1", { clientRef: "t-1" });
    const transport: SyncTransport = {
      async pullCatalogue() {
        return { changes: [], next_cursor: "", has_more: false };
      },
      async pushTickets() {
        const { SyncQueuedError } = await import("@dulja/sync");
        throw new SyncQueuedError("b", "j");
      },
    };
    const loops = createSyncLoops({ store, transport, terminalId: "t", newBatchId: () => "b" });
    await loops.drainNow();
    expect((await store.pendingOutbox(10)).map((r) => r.ref)).toEqual(["t-1"]);
    expect(loops.state().lastError).toContain("queued");
  });
});

/** A refusal as the model server words it: a status and a registered code. */
const refusal = (
  code: "ERR_CONFLICT_REFERENCE" | "ERR_RBAC_FORBIDDEN" | "ERR_VALIDATION_FAILED",
  detail: string,
) => ({ status: "rejected" as const, error: { code, detail } });

/**
 * A model of `applyBatch` (packages/db/src/sync/apply.ts) small enough to read: opens, then tickets, then till
 * events, then closes; a ticket naming a shift that is not open is refused, as `assertShiftKnown` refuses it;
 * and a close derives the drawer from the float and the POSTED tickets' cash alone (ADR 0063).
 */
function modelServer(opts: { refuse?: ReadonlySet<string>; refuseOpens?: () => boolean } = {}) {
  const MYR = currency("MYR");
  const drawers = new Map<string, Money<typeof MYR>>();
  const closed = new Map<string, { expected: Money; overShort: Money }>();
  const posted = new Set<string>();
  const batches: TicketBatch[] = [];
  const transport: SyncTransport = {
    async pullCatalogue() {
      return { changes: [], next_cursor: "", has_more: false };
    },
    async pushTickets(batch) {
      batches.push(structuredClone(batch));
      const shiftResults: BatchResult["shiftResults"] = [];
      for (const s of batch.shifts.filter((m) => m.kind === "open")) {
        const ref = `${s.shiftId}:open`;
        if (drawers.has(s.shiftId) || closed.has(s.shiftId))
          shiftResults.push({ ref, status: "duplicate", error: null });
        else if (opts.refuseOpens?.())
          shiftResults.push({
            ref,
            ...refusal("ERR_RBAC_FORBIDDEN", "cashier lacks live pos.shift.own"),
          });
        else {
          drawers.set(s.shiftId, Money.of(s.openingFloat!.amount, MYR));
          shiftResults.push({ ref, status: "accepted", error: null });
        }
      }
      const results: BatchResult["results"] = batch.tickets.map((t) => {
        const none = { clientRef: t.clientRef, documentId: null, number: null };
        if (posted.has(t.clientRef))
          return {
            clientRef: t.clientRef,
            status: "duplicate",
            documentId: "d",
            number: "n",
            error: null,
          };
        const drawer = drawers.get(t.shiftId);
        if (drawer === undefined)
          return {
            ...none,
            ...refusal("ERR_CONFLICT_REFERENCE", `shift ${t.shiftId} is not an open shift`),
          };
        if (opts.refuse?.has(t.clientRef))
          return {
            ...none,
            ...refusal("ERR_VALIDATION_FAILED", "re-pull the catalogue and re-price"),
          };
        posted.add(t.clientRef);
        let cash = drawer;
        for (const tender of t.tenders)
          if (tender.method === "cash") cash = cash.add(Money.of(tender.amount.amount, MYR));
        drawers.set(t.shiftId, cash);
        return {
          clientRef: t.clientRef,
          status: "accepted",
          documentId: "d",
          number: "n",
          error: null,
        };
      });
      for (const s of batch.shifts.filter((m) => m.kind === "close")) {
        const ref = `${s.shiftId}:close`;
        const drawer = drawers.get(s.shiftId);
        if (closed.has(s.shiftId)) shiftResults.push({ ref, status: "duplicate", error: null });
        else if (drawer === undefined)
          shiftResults.push({
            ref,
            ...refusal("ERR_CONFLICT_REFERENCE", "send the open message first"),
          });
        else {
          drawers.delete(s.shiftId);
          closed.set(s.shiftId, {
            expected: drawer,
            overShort: Money.of(s.countedCash!.amount, MYR).subtract(drawer),
          });
          shiftResults.push({ ref, status: "accepted", error: null });
        }
      }
      return {
        batchId: batch.batchId,
        results,
        shiftResults,
        tillEventResults: batch.tillEvents.map((e) => ({
          ref: e.clientRef,
          status: "accepted" as const,
          error: null,
        })),
        catalogueCursor: "MQ",
      };
    },
  };
  return { transport, batches, closed, posted };
}

/**
 * R12 (PR 12 review), through the real drain. A refused ticket no longer holds the shift close, and it is not
 * dropped while its shift is open: it travels again beside the close and is final only once the close is
 * acknowledged. The first fix made every refusal final at once, so a refusal the server cured with no change to
 * the payload — here the shift open refused for a missing grant, which refuses every ticket of that shift — left
 * those sales unposted for ever and the drawer "over" by all of them.
 */
describe("a refused ticket does not hold the shift close through drainNow (R12)", () => {
  const MYR = currency("MYR");
  async function shiftWithTwoSales() {
    const { SELLER, CATALOGUE } = await import("./support/catalogue");
    const { sell } = await import("../src/main/ticket");
    const { tender } = await import("../src/main/tender");
    const { openShift, closeShift } = await import("../src/main/shift");
    await store.applyChanges(CATALOGUE);
    store.finishCataloguePull();
    const shift = openShift(db, store, {
      terminalId: "term-1",
      cashier: SELLER,
      openingFloat: Money.of("100.0000", MYR),
    });
    const sale = () => {
      const ticket = sell(db, store, {
        shiftId: shift.id,
        cashier: SELLER,
        lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
      });
      tender(db, store, {
        clientRef: ticket.clientRef,
        cashier: SELLER,
        tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
      });
      // The cash the drawer kept for it, as the payload carries it: what was tendered, less the change.
      const [kept] = db.raw
        .prepare<[string], { amount: string }>(
          "select amount from ticket_tender where ticket_id = ?",
        )
        .all(ticket.clientRef);
      return { clientRef: ticket.clientRef, cash: Money.of(kept!.amount, MYR) };
    };
    const good = sale();
    const refused = sale();
    const counted = Money.of("100.0000", MYR).add(good.cash).add(refused.cash);
    closeShift(db, store, { shiftId: shift.id, cashier: SELLER, countedCash: counted });
    return { shiftId: shift.id, good, refused };
  }
  const loopsOver = (transport: SyncTransport) => {
    let n = 0;
    return createSyncLoops({
      store,
      transport,
      terminalId: "term-1",
      newBatchId: () => `batch-${(n += 1)}`,
    });
  };

  it("a deterministic refusal is sent, sent again beside the close, then final — and the status line names it", async () => {
    const { shiftId, good, refused } = await shiftWithTwoSales();
    const model = modelServer({ refuse: new Set([refused.clientRef]) });
    const loops = loopsOver(model.transport);
    await loops.drainNow();
    // Pass 1: the open and both tickets (the close waits for their answers). Pass 2: the close, and beside it
    // the refused ticket, which the server applies first and refuses again.
    expect(shapes(model.batches)).toEqual([
      [["open"], [good.clientRef, refused.clientRef]],
      [["close"], [refused.clientRef]],
    ]);
    const close = model.closed.get(shiftId)!;
    expect(close.expected.equals(Money.of("100.0000", MYR).add(good.cash))).toBe(true);
    expect(close.overShort.equals(refused.cash)).toBe(true); // ADR 0063: the unposted sale's cash is "over"
    expect(loops.state()).toMatchObject({ online: true, pendingOutbox: 0, refusedOutbox: 1 });
    expect(loops.state().lastError).toContain("1 final");
    expect(loops.state().lastError).toContain("re-pull the catalogue");

    await loops.drainNow();
    expect(model.batches).toHaveLength(2); // final: not re-sent every tick
  });

  it("a refused shift open strands nothing: once the server accepts it, the refused tickets post before the close", async () => {
    const { shiftId, good, refused } = await shiftWithTwoSales();
    let granted = false;
    const model = modelServer({ refuseOpens: () => !granted });
    const loops = loopsOver(model.transport);
    await loops.drainNow();
    // The open is refused, so both tickets are refused for naming a shift the server does not have.
    expect(loops.state()).toMatchObject({ pendingOutbox: 4, refusedOutbox: 0 });
    expect(loops.state().lastError).toContain("ERR_CONFLICT_REFERENCE");
    await loops.drainNow();
    // Answered tickets no longer hold the close, which the server refuses too: nothing is final, because the
    // server has closed nothing.
    expect(shapes(model.batches)[1]).toEqual([
      ["open", "close"],
      [good.clientRef, refused.clientRef],
    ]);
    expect(loops.state()).toMatchObject({ pendingOutbox: 4, refusedOutbox: 0 });

    granted = true; // the manager grants pos.shift.own
    await loops.drainNow();
    expect(model.posted).toEqual(new Set([good.clientRef, refused.clientRef]));
    const close = model.closed.get(shiftId)!;
    expect(close.expected.equals(Money.of("100.0000", MYR).add(good.cash).add(refused.cash))).toBe(
      true,
    );
    expect(close.overShort.isZero()).toBe(true);
    expect(loops.state()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 0, lastError: null });
  });

  it("an unreachable server answers nothing, so the close keeps waiting and nothing is refused", async () => {
    const { shiftId } = await shiftWithTwoSales();
    const offline: SyncTransport = {
      async pullCatalogue() {
        throw new TransportOfflineError(new Error("ECONNREFUSED"));
      },
      async pushTickets() {
        throw new TransportOfflineError(new Error("ECONNREFUSED"));
      },
    };
    const loops = loopsOver(offline);
    await loops.drainNow();
    expect(loops.state().lastError).toContain("ECONNREFUSED");
    expect((await store.pendingOutbox(200)).map((r) => r.ref)).not.toContain(`${shiftId}:close`);
    expect(loops.state()).toMatchObject({ pendingOutbox: 4, refusedOutbox: 0 });
  });
});

/** Each batch as [shift kinds, ticket refs]. */
function shapes(batches: TicketBatch[]): [string[], string[]][] {
  return batches.map((b) => [b.shifts.map((s) => s.kind), b.tickets.map((t) => t.clientRef)]);
}

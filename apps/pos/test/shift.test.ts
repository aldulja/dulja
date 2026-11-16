// apps/pos/test/shift.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { shiftRef, type BatchResult, type ShiftOpenClose } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { closeShift, currentShift, openShift } from "../src/main/shift";
import { TillError } from "../src/main/errors";
import type { TillCashier } from "../src/main/authority";

const MYR = currency("MYR");
let db: PosDatabase;
let store: SqliteSyncStore;
const dirs: string[] = [];
const LIMITS = {
  maxLineDiscountPct: "0.100000",
  maxTicketDiscountPct: "0.050000",
  maxVoidAmount: "200.0000",
  maxPriceOverridePct: "0.020000",
  blindReturnAllowed: false,
  maxBlindReturnAmount: "0.0000",
  roundingIncrement: "0.0500",
  requireCustomerOver: null,
  maxCashInDrawer: null,
};
const OWNER: TillCashier = {
  principalId: "p-1",
  employeeId: "e-1",
  branchId: "br-1",
  codes: ["pos.shift.own"],
  limits: LIMITS,
  snapshotRevision: "1",
};

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

const payload = (ref: string): ShiftOpenClose =>
  JSON.parse(
    db.raw
      .prepare<[string], { payload: string }>(
        "select payload from outbox where kind = 'shift' and ref = ?",
      )
      .get(ref)!.payload,
  ) as ShiftOpenClose;

describe("shifts at the till (§3.7.6 Shift, spec:1352; app.shift is 6D's)", () => {
  it("openShift needs pos.shift.own and writes the row plus one outbox message keyed by shiftRef", () => {
    const s = openShift(db, store, {
      terminalId: "term-1",
      cashier: OWNER,
      openingFloat: Money.of("150.0000", MYR),
    });
    expect(s.openingFloat.toString()).toBe("150.0000");
    const ref = shiftRef({ shiftId: s.id, kind: "open" });
    const p = payload(ref);
    expect(p).toMatchObject({
      shiftId: s.id,
      kind: "open",
      terminalId: "term-1",
      cashierPrincipalId: "p-1",
      currency: "MYR",
    });
    expect(p.openingFloat).toEqual({ amount: "150.0000", currency: "MYR" });
    expect(p.countedCash).toBeNull();
    const noCode: TillCashier = { ...OWNER, codes: [] };
    expect(() =>
      openShift(db, store, {
        terminalId: "term-1",
        cashier: noCode,
        openingFloat: Money.of("1.0000", MYR),
      }),
    ).toThrow(/ERR_RBAC_FORBIDDEN/);
  });

  it("refuses a second open shift on the same terminal — one drawer, one shift", () => {
    openShift(db, store, {
      terminalId: "term-1",
      cashier: OWNER,
      openingFloat: Money.of("100.0000", MYR),
    });
    let thrown: unknown;
    try {
      openShift(db, store, {
        terminalId: "term-1",
        cashier: OWNER,
        openingFloat: Money.of("100.0000", MYR),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TillError);
    expect((thrown as TillError).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("closeShift sends countedCash and NOTHING else — the server derives expected_cash and over_short", () => {
    const s = openShift(db, store, {
      terminalId: "term-1",
      cashier: OWNER,
      openingFloat: Money.of("100.0000", MYR),
    });
    closeShift(db, store, {
      shiftId: s.id,
      cashier: OWNER,
      countedCash: Money.of("342.5500", MYR),
    });
    const p = payload(shiftRef({ shiftId: s.id, kind: "close" }));
    expect(p.kind).toBe("close");
    expect(p.countedCash).toEqual({ amount: "342.5500", currency: "MYR" });
    expect(p.openingFloat).toBeNull();
    // §4.10.1: "the till never computes expectedCash or over_short: the server derives both" (A8c).
    expect(Object.keys(p)).not.toContain("expectedCash");
    expect(Object.keys(p)).not.toContain("overShort");
    const row = db.raw
      .prepare<[string], { closed_at: string }>("select closed_at from shift where id = ?")
      .get(s.id)!;
    expect(row.closed_at).not.toBeNull();
    const columns = db.raw
      .prepare<[], { name: string }>("pragma table_info(shift)")
      .all()
      .map((column) => column.name);
    expect(columns).not.toContain("expected_cash");
    expect(columns).not.toContain("over_short");
    expect(currentShift(db, "term-1")).toBeNull();
  });

  it("refuses to close a shift twice, and refuses to close one that is not open", () => {
    const s = openShift(db, store, {
      terminalId: "term-1",
      cashier: OWNER,
      openingFloat: Money.of("100.0000", MYR),
    });
    closeShift(db, store, {
      shiftId: s.id,
      cashier: OWNER,
      countedCash: Money.of("100.0000", MYR),
    });
    expect(() =>
      closeShift(db, store, {
        shiftId: s.id,
        cashier: OWNER,
        countedCash: Money.of("100.0000", MYR),
      }),
    ).toThrow(/ERR_VALIDATION_FAILED/);
    expect(() =>
      closeShift(db, store, {
        shiftId: "nope",
        cashier: OWNER,
        countedCash: Money.of("1.0000", MYR),
      }),
    ).toThrow(/ERR_NOT_FOUND/);
  });

  it("currentShift finds the open shift of THIS terminal and no other", () => {
    const a = openShift(db, store, {
      terminalId: "term-1",
      cashier: OWNER,
      openingFloat: Money.of("100.0000", MYR),
    });
    openShift(db, store, {
      terminalId: "term-2",
      cashier: OWNER,
      openingFloat: Money.of("50.0000", MYR),
    });
    expect(currentShift(db, "term-1")!.id).toBe(a.id);
    expect(currentShift(db, "term-2")!.openingFloat.toString()).toBe("50.0000");
  });
});

it("withholds a close until this shift's actual ticket and event outboxes are acknowledged", async () => {
  const { SELLER, CATALOGUE } = await import("./support/catalogue");
  const { sell } = await import("../src/main/ticket");
  const { tender } = await import("../src/main/tender");
  const { Quantity } = await import("@dulja/domain");
  await store.applyChanges(CATALOGUE);
  store.finishCataloguePull();
  const shift = openShift(db, store, {
    terminalId: "term-1",
    cashier: SELLER,
    openingFloat: Money.zero(MYR),
  });
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
  closeShift(db, store, {
    shiftId: shift.id,
    cashier: SELLER,
    countedCash: Money.of("3.3500", MYR),
  });
  const closeRef = shiftRef({ shiftId: shift.id, kind: "close" });
  expect((await store.pendingOutbox(200)).map((r) => r.ref)).not.toContain(closeRef);
  const pending = await store.pendingOutbox(200);
  await store.markAcked(
    pending.map((r) => r.id),
    {
      batchId: "b",
      catalogueCursor: "MQ",
      results: [
        {
          clientRef: ticket.clientRef,
          status: "accepted",
          documentId: "d",
          number: "POS-1",
          error: null,
        },
      ],
      shiftResults: [
        { ref: shiftRef({ shiftId: shift.id, kind: "open" }), status: "accepted", error: null },
      ],
      tillEventResults: [],
    },
  );
  expect((await store.pendingOutbox(200)).map((r) => r.ref)).toContain(closeRef);
  store.enqueue("till_event", "event-1", {
    clientRef: "event-1",
    shiftId: shift.id,
    kind: "no_sale",
    ticketClientRef: null,
    cashierPrincipalId: SELLER.principalId,
    supervisorPrincipalId: null,
    occurredAt: new Date().toISOString(),
  });
  expect((await store.pendingOutbox(200)).map((r) => r.ref)).not.toContain(closeRef);
  const events = (await store.pendingOutbox(200)).filter((r) => r.kind === "till_event");
  await store.markAcked(
    events.map((r) => r.id),
    {
      batchId: "e",
      catalogueCursor: "MQ",
      results: [],
      shiftResults: [],
      tillEventResults: [{ ref: "event-1", status: "accepted", error: null }],
    },
  );
  expect((await store.pendingOutbox(200)).map((r) => r.ref)).toContain(closeRef);
});

const closeRefOf = (shiftId: string) => shiftRef({ shiftId, kind: "close" });

/** A server answer for one drain: tickets and till events by status, and the one shift message it accepted. */
const answer = (
  tickets: { clientRef: string; status: "accepted" | "rejected" }[],
  acceptedShift: string | null,
  tillEvents: { ref: string; status: "accepted" | "rejected" }[] = [],
): BatchResult => ({
  batchId: "b",
  catalogueCursor: "MQ",
  results: tickets.map((t) => ({
    clientRef: t.clientRef,
    status: t.status,
    documentId: t.status === "accepted" ? "d" : null,
    number: t.status === "accepted" ? "POS-1" : null,
    error:
      t.status === "accepted"
        ? null
        : {
            code: "ERR_VALIDATION_FAILED",
            detail: "the till says tax 0.3027 and this server computes 0.1886",
          },
  })),
  shiftResults:
    acceptedShift === null ? [] : [{ ref: acceptedShift, status: "accepted", error: null }],
  tillEventResults: tillEvents.map((e) => ({
    ref: e.ref,
    status: e.status,
    error:
      e.status === "accepted"
        ? null
        : { code: "ERR_POS_LIMIT_EXCEEDED", detail: "void exceeds the branch limit" },
  })),
});

/**
 * R12 (PR 12 review). A refused ticket or till event must not hold the shift close: a deterministic refusal (a
 * stale tax figure, an exceeded limit) is never acknowledged, so the close never left the till and the server
 * shift stayed open for ever. It must not be dropped either while its shift is open: the server can cure a
 * refusal with no change to the payload, and the first fix, which made every refusal final at once, left such
 * a sale unposted for ever. So the refused row travels again — at the latest beside the close, which the
 * server applies after tickets and till events — and is final only once the close is acknowledged. Silence
 * (no answer at all) still holds the close.
 */
describe("a refused ticket or till event does not hold the shift close (R12)", () => {
  const refs = async () => (await store.pendingOutbox(200)).map((r) => `${r.kind}:${r.ref}`);
  const row = (ref: string) =>
    db.raw
      .prepare<[string], { acked_at: string | null; attempts: number; last_error: string | null }>(
        "select acked_at, attempts, last_error from outbox where ref = ?",
      )
      .get(ref)!;

  async function shiftWithTwoSales() {
    const { SELLER, CATALOGUE } = await import("./support/catalogue");
    const { sell } = await import("../src/main/ticket");
    const { tender } = await import("../src/main/tender");
    const { Quantity } = await import("@dulja/domain");
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
      return ticket.clientRef;
    };
    const good = sale();
    const refused = sale();
    closeShift(db, store, {
      shiftId: shift.id,
      cashier: SELLER,
      countedCash: Money.of("106.7000", MYR),
    });
    return { shift, good, refused, seller: SELLER };
  }

  it("a refused ticket releases the close, travels beside it, and is final once the close is acknowledged", async () => {
    const { shift, good, refused } = await shiftWithTwoSales();
    const closeRef = closeRefOf(shift.id);
    const openRef = shiftRef({ shiftId: shift.id, kind: "open" });
    const first = await store.pendingOutbox(200);
    expect(first.map((r) => r.ref)).not.toContain(closeRef);
    await store.markAcked(
      first.map((r) => r.id),
      answer(
        [
          { clientRef: good, status: "accepted" },
          { clientRef: refused, status: "rejected" },
        ],
        openRef,
      ),
    );
    // The close now travels, and the refused ticket travels again in the same batch.
    expect(await refs()).toEqual([`shift:${closeRef}`, `ticket:${refused}`]);
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 2, refusedOutbox: 0 });

    const second = await store.pendingOutbox(200);
    await store.markAcked(
      second.map((r) => r.id),
      answer([{ clientRef: refused, status: "rejected" }], closeRef),
    );
    // The server has closed the shift, so nothing naming it can be accepted: the refusal is final, the row
    // keeps its reason unacked (spec:1305) and is never offered again.
    expect(await refs()).toEqual([]);
    expect(row(refused)).toEqual({
      acked_at: null,
      attempts: 2,
      last_error: expect.stringContaining("ERR_VALIDATION_FAILED"),
    });
    // It is a completed sale whose cash is in the drawer: the local aid still counts it (ADR 0063 puts it in
    // the server's over/short, never in its expectation, because it was never posted).
    expect(db.raw.prepare("select status from ticket where id = ?").get(refused)).toEqual({
      status: "completed",
    });
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 1 });
  });

  it("a refusal the server cures before the close is accepted in the close's own batch", async () => {
    const { shift, good, refused } = await shiftWithTwoSales();
    const closeRef = closeRefOf(shift.id);
    await store.markAcked(
      (await store.pendingOutbox(200)).map((r) => r.id),
      answer(
        [
          { clientRef: good, status: "accepted" },
          { clientRef: refused, status: "rejected" },
        ],
        shiftRef({ shiftId: shift.id, kind: "open" }),
      ),
    );
    await store.markAcked(
      (await store.pendingOutbox(200)).map((r) => r.id),
      answer([{ clientRef: refused, status: "accepted" }], closeRef),
    );
    expect(row(refused)).toMatchObject({ acked_at: expect.any(String), last_error: null });
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 0 });
  });

  it("silence still holds the close: a ticket the server has not answered is not a refusal", async () => {
    const { shift, good } = await shiftWithTwoSales();
    const first = await store.pendingOutbox(200);
    // The server answered the open and ONE ticket; the other is absent from every array (in flight).
    await store.markAcked(
      first.map((r) => r.id),
      answer(
        [{ clientRef: good, status: "accepted" }],
        shiftRef({ shiftId: shift.id, kind: "open" }),
      ),
    );
    expect(await refs()).not.toContain(`shift:${closeRefOf(shift.id)}`);
    expect(store.catalogueState()).toMatchObject({ refusedOutbox: 0 });
  });

  it("a refused till event releases the close and travels beside it; an unanswered one still holds it", async () => {
    const { shift, good, refused, seller } = await shiftWithTwoSales();
    const closeRef = closeRefOf(shift.id);
    await store.markAcked(
      (await store.pendingOutbox(200)).map((r) => r.id),
      answer(
        [
          { clientRef: good, status: "accepted" },
          { clientRef: refused, status: "accepted" },
        ],
        shiftRef({ shiftId: shift.id, kind: "open" }),
      ),
    );
    expect(await refs()).toEqual([`shift:${closeRef}`]);
    const { recordTillEvent } = await import("../src/main/ticket");
    const voidRef = recordTillEvent(db, store, {
      shiftId: shift.id,
      kind: "void",
      cashier: { ...seller, codes: [...seller.codes, "pos.ticket.void"] },
      ticketClientRef: good,
      reason: "wrong item",
    });
    // Unanswered: the close waits for the void, which the server must apply before it derives the drawer.
    expect(await refs()).toEqual([`till_event:${voidRef}`]);
    await store.markAcked(
      (await store.pendingOutbox(200)).map((r) => r.id),
      answer([], null, [{ ref: voidRef, status: "rejected" }]),
    );
    // Refused: it no longer holds the close, and it goes again beside it.
    expect(await refs()).toEqual([`shift:${closeRef}`, `till_event:${voidRef}`]);
    await store.markAcked(
      (await store.pendingOutbox(200)).map((r) => r.id),
      answer([], closeRef, [{ ref: voidRef, status: "rejected" }]),
    );
    expect(await refs()).toEqual([]);
    // The local ticket only turns `voided` on the event's ACK, so a refused void leaves the sale completed —
    // and the till's status line still names the refusal, since no server queue holds a till event (A10).
    expect(db.raw.prepare("select status from ticket where id = ?").get(good)).toEqual({
      status: "completed",
    });
    expect(store.outboxRefusals()).toEqual({
      retrying: 0,
      final: 1,
      newest: "ERR_POS_LIMIT_EXCEEDED: void exceeds the branch limit",
    });
  });
});

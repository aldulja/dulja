import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { hashPin } from "@dulja/db/staff/pin";
import type { Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { registerPosHandlers } from "../src/main/register";
import { PIN_LOCKOUT_BASE_MS } from "../src/main/authority";
import { CATALOGUE, SELLER } from "./support/catalogue";
const ID = "019aaadb-0000-7000-8000-000000000001";
const SUP = "019aaadb-0000-7000-8000-000000000002";
const ITEM = "019aaadb-0000-7000-8000-000000000003";
let sqliteDb: PosDatabase;
let store: SqliteSyncStore;
let pinHash: string;
let wallClock: Date;
let listeners: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
let print: ReturnType<
  typeof vi.fn<(payload: import("../src/main/receipt").ReceiptPayload) => Promise<void>>
>;
const names = [
  "enrol",
  "login",
  "openShift",
  "closeShift",
  "search",
  "priceCheck",
  "sell",
  "tender",
  "clock",
  "receipt",
  "print",
  "pull",
  "drain",
  "status",
];
const call = async (method: string, arg?: unknown, event: unknown = "trusted") =>
  (await listeners.get(method)!(event, ...(arg === undefined ? [] : [arg]))) as {
    ok: boolean;
    value: any;
    error?: { code: string; detail: string };
  };
beforeAll(async () => {
  pinHash = await hashPin("4821");
});
beforeEach(async () => {
  sqliteDb = openPosDatabase(":memory:");
  store = new SqliteSyncStore(sqliteDb);
  const catalogue = CATALOGUE.map((c) => ({
    ...c,
    id: c.id === "item-A" ? ITEM : c.id,
    row: {
      ...(c.row as Record<string, unknown>),
      ...(c.stream === "item" ? { id: ITEM } : {}),
      ...(c.stream === "price_list_line" ? { item_id: ITEM } : {}),
    },
  })) as Change[];
  await store.applyChanges(catalogue);
  store.finishCataloguePull();
  await store.applyChanges(
    [ID, SUP].map((id, index) => ({
      stream: "cashier",
      op: "upsert",
      id,
      revision: BigInt(20 + index),
      row: {
        principal_id: id,
        employee_id: id,
        employee_number: index ? "SUP" : "CASH",
        branch_id: "br-1",
        pin_hash: pinHash,
        snapshot: {
          codes: [
            ...SELLER.codes,
            "pos.ticket.discount",
            "pos.customer.create",
            "pos.attendance.clock",
            ...(index ? ["pos.ticket.override"] : []),
          ],
          limits: SELLER.limits,
          revision: String(20 + index),
        },
        revoked_at: null,
      },
    })),
  );
  sqliteDb.raw.prepare("insert into meta values ('branch_id','br-1')").run();
  listeners = new Map();
  print = vi.fn(async () => {});
  wallClock = new Date("2026-10-22T08:00:00.000Z");
  registerPosHandlers({
    ipcMain: {
      handle: (channel, fn) => {
        listeners.set(channel, fn);
      },
    },
    channels: Object.fromEntries(names.map((n) => [n, n])),
    db: sqliteDb,
    store,
    loops: createSyncLoops({ store, transport: null, terminalId: ID, newBatchId: () => ID }),
    deviceStore: { get: async () => null, set: async () => {}, remove: async () => {} },
    baseUrl: "http://127.0.0.1",
    terminalId: ID,
    allowEvent: (event) => event === "trusted",
    print,
    onEnrolled: async () => {},
    now: () => wallClock,
  });
});
afterEach(() => {
  sqliteDb.close();
  vi.restoreAllMocks();
});
async function start() {
  expect((await call("login", { employeeNumber: "CASH", pin: "4821" })).ok).toBe(true);
  const result = await call("openShift", { openingFloat: "100.0000", currency: "MYR" });
  expect(result.ok).toBe(true);
  return result.value.shiftId as string;
}
describe("POS main IPC authority", () => {
  it("registers every channel and rejects untrusted frames or forged principal/event inputs", async () => {
    expect([...listeners.keys()]).toEqual(names);
    expect(await call("status", undefined, "untrusted")).toMatchObject({
      ok: false,
      error: { code: "ERR_RBAC_FORBIDDEN" },
    });
    const shiftId = await start();
    for (const extra of [{ cashierPrincipalId: SUP }, { events: [{ supervisorPrincipalId: SUP }] }])
      expect(
        await call("sell", { shiftId, lines: [{ itemId: ITEM, quantity: "1.000000" }], ...extra }),
      ).toMatchObject({ ok: false, error: { code: "ERR_VALIDATION_FAILED" } });
    expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 0 });
  });
  it("passes the server's refusal of an enrolment code to the screen as its own code", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { code: "ERR_TERMINAL_ENROLMENT_INVALID", detail: "enrolment code expired" },
        { status: 422 },
      ),
    );
    // Before, the till sent this as ERR_INTERNAL and the screen said "Something went wrong… call support".
    expect(await call("enrol", "A".repeat(32))).toMatchObject({
      ok: false,
      error: { code: "ERR_TERMINAL_ENROLMENT_INVALID", detail: "enrolment code expired" },
    });
    // Any other failure (here, a server that is down) stays the till's general fault.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    expect(await call("enrol", "A".repeat(32))).toMatchObject({
      ok: false,
      error: { code: "ERR_INTERNAL" },
    });
  });
  it("verifies a different supervisor PIN before lifting a price limit, recording no PIN on the wire", async () => {
    const shiftId = await start();
    const sale = {
      shiftId,
      lines: [{ itemId: ITEM, quantity: "1.000000", priceOverride: "4.0000" }],
    };
    expect(await call("sell", sale)).toMatchObject({
      ok: false,
      error: { code: "ERR_TILL_LIMIT_EXCEEDED" },
    });
    const approval = {
      employeeNumber: "SUP",
      pin: "9999",
      subject: "price_override",
      reason: "Approved price",
    };
    expect(await call("sell", { ...sale, approvals: [approval] })).toMatchObject({
      ok: false,
      error: { code: "ERR_TILL_PIN_INVALID" },
    });
    expect(
      await call("sell", {
        ...sale,
        approvals: [{ ...approval, employeeNumber: "CASH", pin: "4821" }],
      }),
    ).toMatchObject({ ok: false, error: { code: "ERR_RBAC_FORBIDDEN" } });
    const result = await call("sell", { ...sale, approvals: [{ ...approval, pin: "4821" }] });
    expect(result.ok).toBe(true);
    const payload = sqliteDb.raw
      .prepare<[string], { payload: string }>("select payload from outbox where ref=?")
      .get(result.value.clientRef)!.payload;
    expect(JSON.parse(payload).events).toEqual([
      {
        kind: "override",
        code: "pos.ticket.override",
        subject: "price_override",
        reason: "Approved price",
        supervisorPrincipalId: SUP,
      },
    ]);
    expect(payload).not.toContain("4821");
    expect(payload).not.toContain("pin");
  });
  it("counts wrong supervisor approvals and sign-ins against one lockout per employee number (SAH-028)", async () => {
    const shiftId = await start();
    const sale = {
      shiftId,
      lines: [{ itemId: ITEM, quantity: "1.000000", priceOverride: "4.0000" }],
    };
    const approval = {
      employeeNumber: "SUP",
      pin: "9999",
      subject: "price_override",
      reason: "Approved price",
    };
    for (let i = 0; i < 3; i++)
      expect(await call("sell", { ...sale, approvals: [approval] })).toMatchObject({
        ok: false,
        error: { code: "ERR_TILL_PIN_INVALID" },
      });
    for (let i = 0; i < 2; i++)
      expect(await call("login", { employeeNumber: "SUP", pin: "9999" })).toMatchObject({
        ok: false,
        error: { code: "ERR_TILL_PIN_INVALID" },
      });
    // Five wrong PINs, whichever screen took them: the supervisor's right PIN is now refused everywhere.
    // The wire carries the bare detail; the preload prefixes the code once, in the form contextBridge keeps.
    expect(await call("login", { employeeNumber: "SUP", pin: "4821" })).toMatchObject({
      ok: false,
      error: { code: "ERR_RATE_LIMITED", detail: expect.stringMatching(/^too many wrong PINs/) },
    });
    expect((await call("login", { employeeNumber: "CASH", pin: "4821" })).ok).toBe(true);
    const approved = { ...sale, approvals: [{ ...approval, pin: "4821" }] };
    expect(await call("sell", approved)).toMatchObject({
      ok: false,
      error: { code: "ERR_RATE_LIMITED" },
    });
    expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 0 });
    wallClock = new Date(wallClock.getTime() + PIN_LOCKOUT_BASE_MS);
    expect((await call("sell", approved)).ok).toBe(true);
  });
  it("flattens exact amounts, clock IDs and receipts for structured cloning and uses owned shift currency", async () => {
    const shiftId = await start();
    expect(await call("openShift", { openingFloat: "0.0000", currency: "USD" })).toMatchObject({
      ok: false,
      error: { code: "ERR_MONEY_CURRENCY_MISMATCH" },
    });
    const clock = await call("clock", "clock_in");
    expect(typeof clock.value.id).toBe("string");
    const sale = await call("sell", {
      shiftId,
      lines: [{ itemId: ITEM, quantity: "1.000000" }],
      quickCustomer: { nameEn: "Offline customer" },
    });
    expect(sale.value.total).toBe("3.3300");
    const payment = await call("tender", {
      clientRef: sale.value.clientRef,
      tenders: [{ method: "cash", amount: "5.0000" }],
    });
    expect(payment.value).toMatchObject({
      payable: "3.3500",
      change: "1.6500",
      rounding: "0.0200",
    });
    const receipt = await call("receipt", sale.value.clientRef);
    expect(structuredClone(receipt.value).total).toBe("3.3500");
    expect(receipt.value.customerName).toBe("Offline customer");
    expect(await call("print", sale.value.clientRef)).toMatchObject({ ok: true });
    expect(print).toHaveBeenCalledWith(receipt.value);
  });
  it("invalidates cached sessions after catalogue revocation and never leaves the previous login on failure", async () => {
    await start();
    expect(await call("login", { employeeNumber: "UNKNOWN", pin: "4821" })).toMatchObject({
      ok: false,
      error: { code: "ERR_TILL_PIN_INVALID" },
    });
    expect(await call("search", { text: "Rice" })).toMatchObject({
      ok: false,
      error: { code: "ERR_RBAC_FORBIDDEN" },
    });
    await call("login", { employeeNumber: "CASH", pin: "4821" });
    sqliteDb.raw
      .prepare("update catalogue_cashier set revoked_at=? where id=?")
      .run(new Date().toISOString(), ID);
    expect(await call("clock", "clock_in")).toMatchObject({
      ok: false,
      error: { code: "ERR_RBAC_FORBIDDEN" },
    });
  });
  it("rolls back a main-minted customer together with a failed sale write", async () => {
    const shiftId = await start();
    vi.spyOn(store, "enqueue").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(
      await call("sell", {
        shiftId,
        lines: [{ itemId: ITEM, quantity: "1.000000" }],
        quickCustomer: { nameEn: "Rollback" },
      }),
    ).toMatchObject({ ok: false, error: { code: "ERR_INTERNAL" } });
    expect(sqliteDb.raw.prepare("select count(*) n from pending_customer").get()).toEqual({ n: 0 });
    expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 0 });
  });
  it("retains a main-owned pending customer across offline sales and stamps only its real ticket ACK", async () => {
    const shiftId = await start();
    const first = await call("sell", {
      shiftId,
      lines: [{ itemId: ITEM, quantity: "1.000000" }],
      quickCustomer: { nameEn: "Repeat customer" },
    });
    await call("tender", {
      clientRef: first.value.clientRef,
      tenders: [{ method: "card", amount: "3.3300" }],
    });
    const hits = await call("search", { text: "Repeat", customer: true });
    const customerId = hits.value[0].id as string;
    const second = await call("sell", {
      shiftId,
      customerId,
      lines: [{ itemId: ITEM, quantity: "1.000000" }],
    });
    const secondWire = JSON.parse(
      sqliteDb.raw
        .prepare<[string], { payload: string }>("select payload from outbox where ref=?")
        .get(second.value.clientRef)!.payload,
    );
    expect(secondWire.newCustomer.id).toBe(customerId);
    const row = sqliteDb.raw
      .prepare<[string], { id: string }>("select id from outbox where kind='ticket' and ref=?")
      .get(first.value.clientRef)!;
    await store.markAcked([row.id], {
      batchId: ID,
      catalogueCursor: "",
      results: [
        {
          clientRef: first.value.clientRef,
          status: "accepted",
          documentId: ID,
          number: "POS-1",
          error: null,
        },
      ],
      shiftResults: [],
      tillEventResults: [],
    });
    expect(
      sqliteDb.raw
        .prepare<[string], { acked_at: string | null }>(
          "select acked_at from pending_customer where id=?",
        )
        .get(customerId)!.acked_at,
    ).not.toBeNull();
    expect((await call("search", { text: "Repeat", customer: true })).value).toHaveLength(1);
    await store.applyChanges([
      {
        stream: "customer",
        op: "upsert",
        id: customerId,
        revision: 100n,
        row: {
          id: customerId,
          code: hits.value[0].code,
          name_en: "Repeat customer",
          name_ar: null,
          phone: null,
          currency: "MYR",
          credit_limit: "100.0000",
          credit_hold: false,
        },
      },
    ]);
    const mirrored = await call("search", { text: "Repeat", customer: true });
    expect(structuredClone(mirrored.value)[0]).toMatchObject({
      pending: false,
      creditLimit: "100.0000",
    });
  });
});

it("cancels only an unsent owned draft, preserves its rows and audit, and then permits close", async () => {
  const shiftId = await start();
  const sale = await call("sell", { shiftId, lines: [{ itemId: ITEM, quantity: "1.000000" }] });
  expect(sale.ok).toBe(true);
  const clientRef = sale.value.clientRef as string;
  expect((await call("sell", { action: "cancel_draft", shiftId, clientRef })).ok).toBe(false);
  expect(
    (await call("sell", { action: "cancel_draft", shiftId, clientRef, reason: "Customer left" }))
      .ok,
  ).toBe(true);
  expect(sqliteDb.raw.prepare("select status from ticket where id=?").get(clientRef)).toEqual({
    status: "voided",
  });
  expect(
    sqliteDb.raw.prepare("select count(*) n from ticket_line where ticket_id=?").get(clientRef),
  ).toEqual({ n: 1 });
  expect(
    sqliteDb.raw.prepare("select 1 from outbox where kind='ticket' and ref=?").get(clientRef),
  ).toBeUndefined();
  expect(
    sqliteDb.raw.prepare("select value from meta where key=?").get(`cancel:${clientRef}`),
  ).toBeDefined();
  expect((await call("closeShift", { shiftId, countedCash: "100.0000" })).ok).toBe(true);
});
it("releases a cancelled draft's clock event to the next ticket instead of losing it", async () => {
  const shiftId = await start();
  const clock = await call("clock", "clock_in");
  expect(clock.ok).toBe(true);
  const cancelled = await call("sell", {
    shiftId,
    lines: [{ itemId: ITEM, quantity: "1.000000" }],
  });
  const cancelledRef = cancelled.value.clientRef as string;
  expect(
    (
      await call("sell", {
        action: "cancel_draft",
        shiftId,
        clientRef: cancelledRef,
        reason: "Customer left",
      })
    ).ok,
  ).toBe(true);
  expect(
    sqliteDb.raw.prepare("select sent_at from attendance where id=?").get(clock.value.id),
  ).toEqual({ sent_at: null });
  const next = await call("sell", { shiftId, lines: [{ itemId: ITEM, quantity: "1.000000" }] });
  const payload = sqliteDb.raw
    .prepare<[string], { payload: string }>(
      "select payload from outbox where kind='ticket' and ref=?",
    )
    .get(next.value.clientRef as string)!.payload;
  expect((JSON.parse(payload) as { attendance: { kind: string }[] }).attendance).toEqual([
    expect.objectContaining({ kind: "clock_in" }),
  ]);
});
it("drawer events use main identity, reject forged approval and persist atomic outbox intents", async () => {
  const shiftId = await start();
  for (const action of ["no_sale", "drawer_open"]) {
    expect((await call("sell", { action, shiftId, cashierPrincipalId: SUP })).ok).toBe(false);
    const result = await call("sell", { action, shiftId });
    expect(result.ok).toBe(true);
    expect(
      sqliteDb.raw
        .prepare("select cashier_principal_id from till_event where id=?")
        .get(result.value.clientRef),
    ).toEqual({ cashier_principal_id: ID });
    expect(
      sqliteDb.raw
        .prepare("select 1 from outbox where kind='till_event' and ref=?")
        .get(result.value.clientRef),
    ).toBeDefined();
  }
});
it("financial void requires ticket ACK and distinct supervisor PIN; local status changes only on event ACK", async () => {
  sqliteDb.raw
    .prepare(
      "update catalogue_cashier set snapshot_json=json_set(snapshot_json,'$.codes[#]','pos.ticket.void') where id=?",
    )
    .run(ID);
  const shiftId = await start();
  const sale = await call("sell", { shiftId, lines: [{ itemId: ITEM, quantity: "1.000000" }] });
  const clientRef = sale.value.clientRef as string;
  await call("tender", { clientRef, tenders: [{ method: "card", amount: "3.3300" }] });
  const request = {
    action: "void",
    shiftId,
    clientRef,
    reason: "Wrong item",
    approval: { subject: "void", reason: "Wrong item", employeeNumber: "SUP", pin: "4821" },
  };
  expect((await call("sell", request)).ok).toBe(false);
  const ids = (await store.pendingOutbox(100)).filter((r) => r.kind === "ticket").map((r) => r.id);
  await store.markAcked(ids, {
    batchId: ID,
    catalogueCursor: "",
    results: [{ clientRef, status: "accepted", documentId: ITEM, number: "TKT-1", error: null }],
    shiftResults: [],
    tillEventResults: [],
  });
  expect(
    (await call("sell", { ...request, approval: { ...request.approval, employeeNumber: "CASH" } }))
      .ok,
  ).toBe(false);
  const event = await call("sell", request);
  expect(event.ok).toBe(true);
  expect(
    (
      await call("sell", {
        shiftId,
        kind: "return",
        returnsClientRef: clientRef,
        lines: [{ itemId: ITEM, quantity: "1.000000" }],
      })
    ).ok,
  ).toBe(false);
  expect(sqliteDb.raw.prepare("select count(*) n from ticket").get()).toEqual({ n: 1 });

  expect(sqliteDb.raw.prepare("select status from ticket where id=?").get(clientRef)).toEqual({
    status: "completed",
  });
  const eventIds = (await store.pendingOutbox(100))
    .filter((r) => r.kind === "till_event")
    .map((r) => r.id);
  await store.markAcked(eventIds, {
    batchId: ID,
    catalogueCursor: "",
    results: [],
    shiftResults: [],
    tillEventResults: [
      {
        ref: event.value.clientRef,
        status: "accepted",
        error: null,
      },
    ],
  });
  expect(sqliteDb.raw.prepare("select status from ticket where id=?").get(clientRef)).toEqual({
    status: "voided",
  });
  expect((await call("sell", request)).ok).toBe(false);
});
it("a live manager can close another cashier's shift on this till", async () => {
  sqliteDb.raw
    .prepare(
      "update catalogue_cashier set snapshot_json=json_set(snapshot_json,'$.codes[#]','pos.shift.close_any') where id=?",
    )
    .run(SUP);
  const shiftId = await start();
  expect((await call("login", { employeeNumber: "SUP", pin: "4821" })).ok).toBe(true);
  expect((await call("closeShift", { shiftId, countedCash: "100.0000" })).ok).toBe(true);
});

// ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064): the shift view's cash movements through the real handler.
describe("POS cash movements — paid-out, safe drop, banking", () => {
  /** Branch br-1 allows paid-outs up to 50.0000 (the catalogue's own policy row keeps them off). */
  const allowPaidOuts = (allowed: boolean) =>
    store.applyChanges([
      {
        stream: "branch_pos_policy",
        op: "upsert",
        id: "bpp",
        revision: 30n,
        row: {
          ...(CATALOGUE.find((c) => c.stream === "branch_pos_policy")!.row as Record<
            string,
            unknown
          >),
          paid_out_allowed: allowed,
          max_paid_out_amount: "50.0000",
        },
      },
    ] as Change[]);
  const queued = () =>
    sqliteDb.raw
      .prepare<[], { kind: string; ref: string; payload: string }>(
        "select kind, ref, payload from outbox where kind = 'cash_event' order by created_at, rowid",
      )
      .all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  const move = (shiftId: string, body: Record<string, unknown>) =>
    call("sell", { action: "cash_movement", shiftId, ...body });

  it("a paid-out within the limit queues one TillCashMsg carrying its reference and no supervisor", async () => {
    await allowPaidOuts(true);
    const shiftId = await start();
    const out = await move(shiftId, { kind: "paid_out", amount: "20.0000", reference: "RCPT-9" });
    expect(out.ok).toBe(true);
    const rows = queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ref).toBe(out.value.clientRef);
    expect(rows[0]!.payload).toEqual({
      clientRef: out.value.clientRef,
      shiftId,
      kind: "paid_out",
      amount: { amount: "20.0000", currency: "MYR" },
      cashierPrincipalId: ID,
      supervisorPrincipalId: null,
      occurredAt: expect.any(String),
      reference: "RCPT-9",
      fromSafe: false,
    });
    const local = sqliteDb.raw.prepare("select kind, amount, reference from cash_event").all();
    expect(local).toEqual([{ kind: "paid_out", amount: "20.0000", reference: "RCPT-9" }]);
  });

  it("a paid-out without a reference is refused before anything is written", async () => {
    await allowPaidOuts(true);
    const shiftId = await start();
    const out = await move(shiftId, { kind: "paid_out", amount: "20.0000" });
    expect(out.ok).toBe(false);
    expect(out.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(queued()).toEqual([]);
  });

  it("a branch that does not allow paid-outs refuses one", async () => {
    await allowPaidOuts(false);
    const shiftId = await start();
    const out = await move(shiftId, { kind: "paid_out", amount: "1.0000", reference: "X" });
    expect(out.error!.code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    expect(queued()).toEqual([]);
  });

  it("above the limit needs another supervisor at this branch, who is then named on the message", async () => {
    await allowPaidOuts(true);
    const shiftId = await start();
    const alone = await move(shiftId, { kind: "paid_out", amount: "80.0000", reference: "BIG" });
    expect(alone.error!.code).toBe("ERR_TILL_LIMIT_EXCEEDED");
    const self = await move(shiftId, {
      kind: "paid_out",
      amount: "80.0000",
      reference: "BIG",
      approval: { employeeNumber: "CASH", pin: "4821" },
    });
    expect(self.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    const approved = await move(shiftId, {
      kind: "paid_out",
      amount: "80.0000",
      reference: "BIG",
      approval: { employeeNumber: "SUP", pin: "4821" },
    });
    expect(approved.ok).toBe(true);
    expect(queued().map((r) => r.payload.supervisorPrincipalId)).toEqual([SUP]);
  });

  it("a safe drop and a banking need no reference; only a banking may come from the safe", async () => {
    const shiftId = await start();
    expect((await move(shiftId, { kind: "safe_drop", amount: "30.0000" })).ok).toBe(true);
    expect((await move(shiftId, { kind: "banking", amount: "30.0000", fromSafe: true })).ok).toBe(
      true,
    );
    expect((await move(shiftId, { kind: "banking", amount: "10.0000" })).ok).toBe(true);
    const fromSafeDrop = await move(shiftId, {
      kind: "safe_drop",
      amount: "1.0000",
      fromSafe: true,
    });
    expect(fromSafeDrop.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(queued().map((r) => [r.payload.kind, r.payload.fromSafe, r.payload.reference])).toEqual([
      ["safe_drop", false, null],
      ["banking", true, null],
      ["banking", false, null],
    ]);
  });

  it("a zero or negative amount is refused", async () => {
    const shiftId = await start();
    expect((await move(shiftId, { kind: "safe_drop", amount: "0.0000" })).error!.code).toBe(
      "ERR_VALIDATION_FAILED",
    );
    expect((await move(shiftId, { kind: "safe_drop", amount: "-5.0000" })).error!.code).toBe(
      "ERR_VALIDATION_FAILED",
    );
    expect(queued()).toEqual([]);
  });

  it("another cashier signed in on this till cannot move cash on the open shift's drawer", async () => {
    const shiftId = await start();
    expect((await call("login", { employeeNumber: "SUP", pin: "4821" })).ok).toBe(true);
    const out = await move(shiftId, { kind: "safe_drop", amount: "5.0000" });
    expect(out.ok).toBe(false);
    expect(out.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(queued()).toEqual([]);
    expect(sqliteDb.raw.prepare("select count(*) n from cash_event").get()).toEqual({ n: 0 });
  });

  it("the close waits for a cash movement the server has not answered, and ack clears it", async () => {
    const shiftId = await start();
    const { value } = await move(shiftId, { kind: "safe_drop", amount: "5.0000" });
    expect((await call("closeShift", { shiftId, countedCash: "95.0000" })).ok).toBe(true);
    const first = await store.pendingOutbox(10);
    expect(first.map((r) => r.kind)).toEqual(["shift", "cash_event"]);
    await store.markAcked(
      first.map((r) => r.id),
      {
        batchId: ID,
        results: [],
        shiftResults: [{ ref: `${shiftId}:open`, status: "accepted", error: null }],
        tillEventResults: [],
        cashEventResults: [{ ref: value.clientRef, status: "accepted", error: null }],
        catalogueCursor: "MA",
      },
    );
    const second = await store.pendingOutbox(10);
    expect(second.map((r) => [r.kind, (r.payload as { kind: string }).kind])).toEqual([
      ["shift", "close"],
    ]);
  });
});

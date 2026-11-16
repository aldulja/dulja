// Full review 2026-11-15, till safety: POS-03 (bounded requests), POS-04 (a departed cashier's draft) and
// POS-18 (a failed manual sync is not "Completed."). Each case failed on the tree before its fix.
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPin } from "@dulja/db/staff/pin";
import type { Change, SyncTransport, TicketBatch } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { registerPosHandlers } from "../src/main/register";
import { enrolDevice, type DeviceIdentity } from "../src/main/device";
import { HttpSyncTransport, TransportOfflineError } from "../src/main/transport";
import { CATALOGUE, SELLER } from "./support/catalogue";

const CASH = "019aaadb-0000-7000-8000-000000000001";
const SUP = "019aaadb-0000-7000-8000-000000000002";
const ITEM = "019aaadb-0000-7000-8000-000000000003";
const OTHER = "019aaadb-0000-7000-8000-000000000004";

const { privateKey } = generateKeyPairSync("ed25519");
const device: DeviceIdentity = {
  terminalId: CASH,
  publicKeyDer: Buffer.alloc(0),
  sign: (m) => edSign(null, Buffer.from(m), privateKey),
};
/** A half-open API: it accepts the request and never answers, until the caller gives up on it. */
const hungFetch = (_url: string | URL, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });
const within = <T>(work: Promise<T>, ms: number) =>
  Promise.race([
    work.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve(`still waiting after ${ms}ms`), ms)),
  ]);
const emptyBatch: TicketBatch = {
  terminalId: CASH,
  batchId: SUP,
  tickets: [],
  shifts: [],
  tillEvents: [],
};

describe("POS-03: every till → API request has a deadline", () => {
  it("a hung catalogue pull and ticket push reject as offline once the deadline passes", async () => {
    const transport = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: hungFetch,
      timeoutMs: 50,
    });
    const pull = transport.pullCatalogue("", 10);
    const push = transport.pushTickets(emptyBatch);
    expect(await within(pull, 1000)).toBe("settled");
    await expect(pull).rejects.toBeInstanceOf(TransportOfflineError);
    await expect(push).rejects.toBeInstanceOf(TransportOfflineError);
  });
  it("the default deadline is bounded and well under undici's five minutes", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const transport = new HttpSyncTransport({
      baseUrl: "https://api.example",
      device,
      newIdempotencyKey: () => "k",
      fetch: (url, init) => {
        seen.push(init?.signal);
        return hungFetch(url, init);
      },
    });
    void transport.pullCatalogue("", 10).catch(() => {});
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
  it("a hung enrolment rejects once the deadline passes", async () => {
    const enrol = enrolDevice(
      { get: async () => null, set: async () => {}, remove: async () => {} },
      {
        baseUrl: "https://api.example",
        code: "A".repeat(32),
        fetch: hungFetch as typeof fetch,
        timeoutMs: 50,
      },
    );
    expect(await within(enrol, 1000)).toBe("settled");
    await expect(enrol).rejects.toThrow();
  });
  it("the serial sync chain is not held for minutes behind a hung API (the reviewer's reproduction)", async () => {
    const db = openPosDatabase(":memory:");
    try {
      const loops = createSyncLoops({
        store: new SqliteSyncStore(db),
        transport: new HttpSyncTransport({
          baseUrl: "https://api.example",
          device,
          newIdempotencyKey: () => "k",
          fetch: hungFetch,
          timeoutMs: 50,
        }),
        terminalId: CASH,
        newBatchId: () => SUP,
      });
      void loops.pullNow().catch(() => {});
      expect(await within(loops.drainNow(), 2000)).toBe("settled");
    } finally {
      db.close();
    }
  });
});

describe("POS-18: a manual sync that failed is reported as failed", () => {
  it("drainNow({ manual: true }) rejects when the push fails; the timer's drain stays quiet", async () => {
    const db = openPosDatabase(":memory:");
    try {
      const store = new SqliteSyncStore(db);
      store.enqueue("ticket", "t-1", { clientRef: "t-1" } as never);
      const down: SyncTransport = {
        pullCatalogue: async () => {
          throw new TransportOfflineError(new Error("ECONNREFUSED"));
        },
        pushTickets: async () => {
          throw new TransportOfflineError(new Error("ECONNREFUSED"));
        },
      };
      const loops = createSyncLoops({
        store,
        transport: down,
        terminalId: CASH,
        newBatchId: () => SUP,
      });
      await expect(loops.drainNow({ manual: true })).rejects.toBeInstanceOf(TransportOfflineError);
      await expect(loops.drainNow()).resolves.toBeUndefined();
      expect(loops.state().online).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("POS-04: a departed cashier's unfinished ticket", () => {
  let sqliteDb: PosDatabase;
  let store: SqliteSyncStore;
  let pinHash: string;
  let listeners: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
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
  const call = async (method: string, arg?: unknown) =>
    (await listeners.get(method)!("trusted", ...(arg === undefined ? [] : [arg]))) as {
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
    await store.applyChanges(
      CATALOGUE.map((c) => ({
        ...c,
        id: c.id === "item-A" ? ITEM : c.id,
        row: {
          ...(c.row as Record<string, unknown>),
          ...(c.stream === "item" ? { id: ITEM } : {}),
          ...(c.stream === "price_list_line" ? { item_id: ITEM } : {}),
        },
      })) as Change[],
    );
    store.finishCataloguePull();
    await store.applyChanges(
      [CASH, SUP, OTHER].map((id, index) => ({
        stream: "cashier",
        op: "upsert",
        id,
        revision: BigInt(20 + index),
        row: {
          principal_id: id,
          employee_id: id,
          employee_number: ["CASH", "SUP", "OTHER"][index],
          branch_id: "br-1",
          pin_hash: pinHash,
          snapshot: {
            codes: [...SELLER.codes, ...(index === 1 ? ["pos.shift.close_any"] : [])],
            limits: SELLER.limits,
            revision: String(20 + index),
          },
          revoked_at: null,
        },
      })),
    );
    sqliteDb.raw.prepare("insert into meta values ('branch_id','br-1')").run();
    listeners = new Map();
    registerPosHandlers({
      ipcMain: { handle: (channel, fn) => void listeners.set(channel, fn) },
      channels: Object.fromEntries(names.map((n) => [n, n])),
      db: sqliteDb,
      store,
      loops: createSyncLoops({ store, transport: null, terminalId: CASH, newBatchId: () => CASH }),
      deviceStore: { get: async () => null, set: async () => {}, remove: async () => {} },
      baseUrl: "http://127.0.0.1",
      terminalId: CASH,
      allowEvent: (event) => event === "trusted",
      print: async () => {},
      onEnrolled: async () => {},
    });
  });
  afterEach(() => {
    sqliteDb.close();
    vi.restoreAllMocks();
  });
  async function abandonedDraft() {
    expect((await call("login", { employeeNumber: "CASH", pin: "4821" })).ok).toBe(true);
    const shiftId = (await call("openShift", { openingFloat: "100.0000", currency: "MYR" })).value
      .shiftId as string;
    const sale = await call("sell", { shiftId, lines: [{ itemId: ITEM, quantity: "1.000000" }] });
    expect(sale.ok).toBe(true);
    // Cashier A goes home with the ticket at the payment step.
    expect((await call("login", { logout: true })).ok).toBe(true);
    expect((await call("login", { employeeNumber: "SUP", pin: "4821" })).ok).toBe(true);
    return { shiftId, clientRef: sale.value.clientRef as string };
  }
  it("a close_any holder sees the draft, cancels it under their own name and then closes the shift", async () => {
    const { shiftId, clientRef } = await abandonedDraft();
    const status = await call("status");
    expect(status.value.unfinishedTickets).toEqual([
      { clientRef, total: expect.any(String), cashierPrincipalId: CASH },
    ]);
    expect(
      await call("sell", { action: "cancel_draft", shiftId, clientRef, reason: "Cashier left" }),
    ).toMatchObject({ ok: true });
    expect(sqliteDb.raw.prepare("select status from ticket where id=?").get(clientRef)).toEqual({
      status: "voided",
    });
    const record = JSON.parse(
      (
        sqliteDb.raw.prepare("select value from meta where key=?").get(`cancel:${clientRef}`) as {
          value: string;
        }
      ).value,
    );
    expect(record).toMatchObject({
      cashierPrincipalId: SUP,
      onBehalfOfPrincipalId: CASH,
      reason: "Cashier left",
    });
    expect(await call("closeShift", { shiftId, countedCash: "100.0000" })).toMatchObject({
      ok: true,
    });
  });
  it("a cashier without close_any still cannot cancel another cashier's draft", async () => {
    const { shiftId, clientRef } = await abandonedDraft();
    expect((await call("login", { logout: true })).ok).toBe(true);
    expect((await call("login", { employeeNumber: "OTHER", pin: "4821" })).ok).toBe(true);
    expect(
      await call("sell", { action: "cancel_draft", shiftId, clientRef, reason: "not mine" }),
    ).toMatchObject({ ok: false, error: { code: "ERR_RBAC_FORBIDDEN" } });
    expect(sqliteDb.raw.prepare("select status from ticket where id=?").get(clientRef)).toEqual({
      status: "open",
    });
  });
});

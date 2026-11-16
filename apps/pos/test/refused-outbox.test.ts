// apps/pos/test/refused-outbox.test.ts
//
// PR 12 review (R12, second pass): every reader of the till's outbox agrees on what a FINAL refusal is — a
// ticket or till event the server refused whose shift's close it has since acknowledged (`outbox_refused`,
// schema.sql). Such a row will never be sent again and never be posted, so it is not "pending work" for the
// re-enrolment gate and is not part of this till's credit exposure. A refusal still being retried is both.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import { shiftRef, type BatchResult, type Change } from "@dulja/sync";
import { openPosDatabase, type PosDatabase } from "../src/main/database";
import { SqliteSyncStore } from "../src/main/store";
import { createSyncLoops } from "../src/main/loops";
import { registerPosHandlers } from "../src/main/register";
import { closeShift, openShift } from "../src/main/shift";
import { sell } from "../src/main/ticket";
import { tender } from "../src/main/tender";
import { accountSale, checkCredit, quickCreateCustomer } from "../src/main/customer";
import { CATALOGUE, SELLER } from "./support/catalogue";

const MYR = currency("MYR");
let db: PosDatabase;
let store: SqliteSyncStore;
const dirs: string[] = [];
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-till-"));
  dirs.push(dir);
  db = openPosDatabase(join(dir, "till.sqlite"));
  store = new SqliteSyncStore(db);
  await store.applyChanges([...CATALOGUE, CUSTOMER]);
  store.finishCataloguePull();
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CUSTOMER: Change = {
  stream: "customer",
  op: "upsert",
  id: "cust-1",
  revision: 99n,
  row: {
    id: "cust-1",
    code: "C-001",
    name_en: "Ahmad Trading",
    name_ar: null,
    phone: null,
    currency: "MYR",
    credit_limit: "100.0000",
    credit_hold: false,
  },
};
const CASHIER = { ...SELLER, codes: [...SELLER.codes, "pos.customer.create"] };

/** The server's answer to one batch: every named ticket refused, and the one shift message accepted. */
const refusedWith = (clientRef: string, acceptedShift: string): BatchResult => ({
  batchId: "b",
  catalogueCursor: "MQ",
  results: [
    {
      clientRef,
      status: "rejected",
      documentId: null,
      number: null,
      error: { code: "ERR_CREDIT_LIMIT_EXCEEDED", detail: "over the limit the back office holds" },
    },
  ],
  shiftResults: [{ ref: acceptedShift, status: "accepted", error: null }],
  tillEventResults: [],
});

/** Sends what is pending and answers it: the ticket refused, the shift message accepted. */
async function answer(clientRef: string, acceptedShift: string): Promise<void> {
  const rows = await store.pendingOutbox(200);
  await store.markAcked(
    rows.map((r) => r.id),
    refusedWith(clientRef, acceptedShift),
  );
}

describe("a final refusal is not pending work, and a refusal being retried still is (R12)", () => {
  it("leaves this till's credit exposure once final, and stays in it while it is retried", async () => {
    const shift = openShift(db, store, {
      terminalId: "term-1",
      cashier: CASHIER,
      openingFloat: Money.of("100.0000", MYR),
    });
    const sale = accountSale(db, store, {
      shiftId: shift.id,
      cashier: CASHIER,
      customerId: "cust-1",
      lines: [{ itemId: "item-A", quantity: Quantity.of("20.000000") }],
    });
    const exposure = () => checkCredit(db, "cust-1", Money.zero(MYR)).localExposure.toString();
    expect(exposure()).toBe(sale.draft.total.toString());
    await answer(sale.clientRef, shiftRef({ shiftId: shift.id, kind: "open" }));
    // Refused but still re-sent: the server may yet post it, so it still counts against the limit here.
    expect(exposure()).toBe(sale.draft.total.toString());

    closeShift(db, store, {
      shiftId: shift.id,
      cashier: CASHIER,
      countedCash: Money.of("100.0000", MYR),
    });
    await answer(sale.clientRef, shiftRef({ shiftId: shift.id, kind: "close" }));
    // Final: it will never post, so it no longer holds this customer's credit on the till for ever.
    expect(store.catalogueState()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 1 });
    expect(exposure()).toBe("0.0000");
  });

  it("does not refuse re-enrolment for ever over a refused ticket's quick-created customer", async () => {
    const enrol = handlers();
    const shift = openShift(db, store, {
      terminalId: "term-1",
      cashier: CASHIER,
      openingFloat: Money.of("100.0000", MYR),
    });
    const created = quickCreateCustomer(db, CASHIER, { nameEn: "Walk-in" });
    const ticket = sell(db, store, {
      shiftId: shift.id,
      cashier: CASHIER,
      customerId: created.customer.id,
      newCustomer: created.newCustomer,
      lines: [{ itemId: "item-A", quantity: Quantity.of("1.000000") }],
    });
    tender(db, store, {
      clientRef: ticket.clientRef,
      cashier: CASHIER,
      tenders: [{ method: "cash", amount: Money.of("5.0000", MYR) }],
    });
    closeShift(db, store, {
      shiftId: shift.id,
      cashier: CASHIER,
      countedCash: Money.of("105.0000", MYR),
    });
    await answer(ticket.clientRef, shiftRef({ shiftId: shift.id, kind: "open" }));
    // The refused ticket is still retried — beside the close — so there IS work to sync: refused.
    expect(await enrol()).toMatchObject({
      ok: false,
      error: { detail: "finish the shift and sync pending work before enrolment" },
    });

    await answer(ticket.clientRef, shiftRef({ shiftId: shift.id, kind: "close" }));
    // Final. Its customer was never created on the server (the refused savepoint took it with it) and no row
    // will ever create it, so before the fix `pending_customer.acked_at is null` refused enrolment for ever.
    expect(store.unsyncedCustomers()).toBe(0);
    expect(await enrol()).toMatchObject({ ok: true });
  });
});

/** The till's `enrol` IPC handler over this file, with the enrolment endpoint answered locally. */
function handlers(): () => Promise<{ ok: boolean; error?: { code: string; detail: string } }> {
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
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
  registerPosHandlers({
    ipcMain: { handle: (channel, fn) => void listeners.set(channel, fn) },
    channels: Object.fromEntries(names.map((n) => [n, n])),
    db,
    store,
    loops: createSyncLoops({ store, transport: null, terminalId: "term-1", newBatchId: () => "b" }),
    deviceStore: { get: async () => null, set: async () => {}, remove: async () => {} },
    baseUrl: "http://127.0.0.1",
    terminalId: "term-1",
    allowEvent: () => true,
    print: async () => {},
    onEnrolled: async () => {},
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          terminalId: "019aaadb-0000-7000-8000-00000000000a",
          branchId: "019aaadb-0000-7000-8000-00000000000b",
          companyId: "019aaadb-0000-7000-8000-00000000000c",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
  );
  return async () =>
    (await listeners.get("enrol")!("trusted", "A".repeat(32))) as {
      ok: boolean;
      error?: { code: string; detail: string };
    };
}

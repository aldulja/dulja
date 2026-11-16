// R12 (PR 12 review), end to end: the till's SQLite store, its shipped HTTP transport and the real API.
//
// A ticket the server refuses for a reason its payload carries — here a stale tax rate in the till's mirror,
// which `verifyTax` refuses rather than corrects (ADR 0056) — used to stay pending in the till's outbox for
// ever, and `pendingOutbox` held the shift close until it was acknowledged, so the close never left the till:
// the server shift stayed open with no expected cash, over/short or Z-report. A refused ticket no longer holds
// the close: it travels again beside it (`applyBatch` applies tickets before closes), and once the server has
// acknowledged the close the refusal is final — retained in `app.needs_attention`, kept unacked on the till
// with its reason and never re-sent. ADR 0063: it was never posted, so it is not in `expected_cash`, and the
// cash the customer paid for it shows in the drawer's over/short.
//
// The second pass of the review: a refusal is NOT final while its shift is open, because the server can cure
// one with no change to the payload. The second shift below is refused at open for a missing grant — which
// refuses each of its tickets for naming an unknown shift — and once the grant is restored they post.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import { withTenant } from "@dulja/db";
import { shiftRef } from "@dulja/sync";
import { sharedApi } from "../support/api";
import { tillFixture, openTill, type TillFixture } from "./support/till";
import { sell } from "../../apps/pos/src/main/ticket";
import { tender } from "../../apps/pos/src/main/tender";
import { closeShift, openShift } from "../../apps/pos/src/main/shift";

const MYR = currency("MYR");
let f: TillFixture;

beforeAll(async () => {
  f = await tillFixture((await sharedApi()).api, "REFUSED12");
  await openTill(f);
}, 180_000);
afterAll(async () => {
  if (f) await f.close();
});

/** One unit of the fixture's item, paid in cash at the till's own total. */
function cashSale(shiftId = f.shiftId) {
  const sale = sell(f.db, f.store, {
    shiftId,
    cashier: f.cashier!,
    lines: [{ itemId: f.staff.itemId, quantity: Quantity.of("1.000000") }],
  });
  tender(f.db, f.store, {
    clientRef: sale.clientRef,
    cashier: f.cashier!,
    tenders: [{ method: "cash", amount: sale.draft.total }],
  });
  const [paid] = f.db.raw
    .prepare<[string], { amount: string }>("select amount from ticket_tender where ticket_id = ?")
    .all(sale.clientRef);
  return { clientRef: sale.clientRef, cash: Money.of(paid!.amount, MYR) };
}

const outbox = (ref: string) =>
  f.db.raw
    .prepare<[string], { acked_at: string | null; attempts: number; last_error: string | null }>(
      "select acked_at, attempts, last_error from outbox where ref = ?",
    )
    .get(ref)!;

async function serverShift(shiftId: string) {
  const [shift] = await f.api.db.admin<
    { closed_at: string | null; expected_cash: string; over_short: string }[]
  >`select closed_at::text, expected_cash::text, over_short::text from app.shift where id = ${shiftId}`;
  return shift!;
}

async function documents(clientRef: string): Promise<number> {
  const [row] = await f.api.db.admin<{ n: number }[]>`
    select count(*)::int as n from app.document
     where company_id = ${f.staff.seed.company} and client_ref = ${clientRef}`;
  return row!.n;
}

describe("a refused ticket does not keep the shift open (R12, ADR 0056, ADR 0063)", () => {
  let good: ReturnType<typeof cashSale>;
  let refused: ReturnType<typeof cashSale>;

  it("sells one ticket at the server's tax rate and one priced from a stale mirror, then closes", () => {
    good = cashSale();
    const taxCodeId = f.staff.pos.taxCodes["SYN-OUT-STD"]!;
    const mirror = f.db.raw
      .prepare<[string], { row_json: string }>(
        "select row_json from catalogue_tax_code where id = ?",
      )
      .get(taxCodeId)!;
    // The till still holds a rate the office has since changed (SYNTH-MY-v1's code is 11 %): it prices a
    // tax figure the server will not compute, and a re-send of that payload can only be refused again.
    f.db.raw
      .prepare(
        "update catalogue_tax_code set row_json = json_set(row_json, '$.rate', ?) where id = ?",
      )
      .run("0.25000000", taxCodeId);
    refused = cashSale();
    f.db.raw
      .prepare("update catalogue_tax_code set row_json = ? where id = ?")
      .run(mirror.row_json, taxCodeId);

    // The drawer holds the float and BOTH customers' cash.
    closeShift(f.db, f.store, {
      shiftId: f.shiftId,
      cashier: f.cashier!,
      countedCash: Money.of("100.0000", MYR).add(good.cash).add(refused.cash),
    });
    expect(outbox(shiftRef({ shiftId: f.shiftId, kind: "close" })).acked_at).toBeNull();
  });

  it("one drain posts the good ticket, refuses the stale one beside the close and lands the close", async () => {
    await f.loops.drainNow();
    expect(outbox(good.clientRef).acked_at).not.toBeNull();
    expect(outbox(shiftRef({ shiftId: f.shiftId, kind: "open" })).acked_at).not.toBeNull();
    expect(outbox(shiftRef({ shiftId: f.shiftId, kind: "close" })).acked_at).not.toBeNull();
    // Refused twice: once with its neighbours, once beside the close the server applied after it.
    expect(outbox(refused.clientRef)).toEqual({
      acked_at: null,
      attempts: 2,
      last_error: expect.stringContaining("re-pull the catalogue"),
    });
    const state = f.loops.state();
    expect(state).toMatchObject({ online: true, pendingOutbox: 0, refusedOutbox: 1 });
    // The till names the refusal on its status line (it would otherwise read "Pending: 0" and nothing more).
    expect(state.lastError).toContain("1 final");
    expect(state.lastError).toContain("re-pull the catalogue");

    // Final: the next drain has nothing to send, so the till does not hammer the server.
    const calls = f.transport.calls;
    await f.loops.drainNow();
    expect(f.transport.calls).toBe(calls);
  }, 300_000);

  it("the server closed the shift: the refused sale is outside expected_cash and inside over_short", async () => {
    const shift = await serverShift(f.shiftId);
    expect(shift.closed_at).not.toBeNull();
    // ADR 0063: the float plus the 1110 legs of the shift's POSTED documents — the refused ticket has none.
    expect(
      Money.of(shift.expected_cash, MYR).equals(Money.of("100.0000", MYR).add(good.cash)),
    ).toBe(true);
    // Its cash is in the count, so the drawer reads over by exactly that sale until a manager resolves it.
    expect(Money.of(shift.over_short, MYR).equals(refused.cash)).toBe(true);

    const queued = await f.api.db.admin<
      { error_code: string; resolved_at: string | null; terminal_id: string }[]
    >`select error_code, resolved_at::text, terminal_id::text from app.needs_attention
       where company_id = ${f.staff.seed.company} and client_ref = ${refused.clientRef}`;
    expect(queued).toEqual([
      { error_code: "ERR_VALIDATION_FAILED", resolved_at: null, terminal_id: f.terminalId },
    ]);
    expect(await documents(refused.clientRef)).toBe(0);
  });
});

describe("a refusal the server cures while the shift is open still posts (R12, second pass)", () => {
  let shiftId: string;
  let sale: ReturnType<typeof cashSale>;
  const expire = (expiresAt: "past" | "never") =>
    withTenant(
      f.api.db.rw,
      { tenantId: f.staff.seed.tenant, actorId: f.staff.seed.system, requestId: "R12-cure" },
      (tx) =>
        expiresAt === "past"
          ? tx`update app.role_assignment set expires_at = now() - interval '1 day'
                where principal_id = ${f.staff.cashierA}`
          : tx`update app.role_assignment set expires_at = null where principal_id = ${f.staff.cashierA}`,
    );

  it("the server refuses the shift open, so it refuses the shift's ticket too; neither is final", async () => {
    shiftId = openShift(f.db, f.store, {
      terminalId: f.terminalId,
      cashier: f.cashier!,
      openingFloat: Money.of("100.0000", MYR),
    }).id;
    sale = cashSale(shiftId);
    // The cashier's grant has lapsed on the server (a role change the till's mirror has not seen yet).
    await expire("past");
    await f.loops.drainNow();
    expect(outbox(shiftRef({ shiftId, kind: "open" })).last_error).toContain("ERR_RBAC_FORBIDDEN");
    expect(outbox(sale.clientRef).last_error).toContain("ERR_CONFLICT_REFERENCE");

    // The cashier closes the drawer. The refused ticket no longer holds the close, so both go — and the
    // server, which has no open shift, refuses both again. It has closed nothing, so nothing is final.
    closeShift(f.db, f.store, {
      shiftId,
      cashier: f.cashier!,
      countedCash: Money.of("100.0000", MYR).add(sale.cash),
    });
    await f.loops.drainNow();
    expect(outbox(shiftRef({ shiftId, kind: "close" })).last_error).toContain(
      "ERR_CONFLICT_REFERENCE",
    );
    expect(f.loops.state()).toMatchObject({ pendingOutbox: 3, refusedOutbox: 1 });
    expect(await documents(sale.clientRef)).toBe(0);
  }, 300_000);

  it("once the grant is restored the open, the ticket and then the close all land", async () => {
    await expire("never");
    await f.loops.drainNow();
    for (const ref of [
      shiftRef({ shiftId, kind: "open" }),
      sale.clientRef,
      shiftRef({ shiftId, kind: "close" }),
    ])
      expect(outbox(ref).acked_at, ref).not.toBeNull();
    expect(await documents(sale.clientRef)).toBe(1);
    // The sale posted before the server derived the drawer, so the count balances it exactly.
    const shift = await serverShift(shiftId);
    expect(shift.closed_at).not.toBeNull();
    expect(
      Money.of(shift.expected_cash, MYR).equals(Money.of("100.0000", MYR).add(sale.cash)),
    ).toBe(true);
    expect(Money.of(shift.over_short, MYR).isZero()).toBe(true);
    // Only the first shift's refusal remains on the till.
    expect(f.loops.state()).toMatchObject({ pendingOutbox: 0, refusedOutbox: 1 });
  }, 300_000);
});

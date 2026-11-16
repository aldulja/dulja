import { Money, currency } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "@dulja/db";
import { tillEventRef } from "@dulja/db";
import { seedShift, seedTerminal, grantCodes, type Seed } from "@dulja/db/test";
import { withTenant, type Db } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { buildTicket, posFixture, type PosFixture } from "./support/pos";
import { recordingJobs } from "./support/post-inventory";

describe("6D till events — the append-only ticket stream (spec:1354, §4.6.1)", () => {
  let api: StartedApi;
  let db: Db;
  let f: PosFixture;
  let s: Seed;
  let t1: { terminalId: string; principalId: string };
  let t2: { terminalId: string; principalId: string };
  let shiftId: string;
  let foreignShiftId: string;

  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "drawer"); // items with stock, the tax pack, POS_TICKET, one terminal
    db = api.db;
    s = f.s; // `PosFixture`'s member is `s`, not `seed` (6A Task 10 Step 5)
    t1 = f.terminal; // enrolled at s.hq — the branch every case below asserts
    t2 = await seedTerminal(db, s, { code: "T2" });
    shiftId = await seedShift(db, s, { terminalId: t1.terminalId, cashierPrincipalId: s.human });
    await grantCodes(db, s, {
      codes: ["pos.ticket.void"],
      principalId: f.cashierId,
      branchIds: [s.hq],
    });
    foreignShiftId = await seedShift(db, s, {
      terminalId: t2.terminalId,
      cashierPrincipalId: s.human,
    });
  }, 300_000);
  afterAll(async () => {
    await api.stop();
  });

  const ev = (over: Record<string, unknown> = {}) => ({
    clientRef: crypto.randomUUID(),
    shiftId,
    kind: "no_sale",
    ticketClientRef: null,
    cashierPrincipalId: s.human,
    supervisorPrincipalId: null,
    occurredAt: new Date().toISOString(),
    ...over,
  });

  const apply = (tillEvents: unknown[], terminal = t1) =>
    withTenant(db.rw, s.tenant, terminal.principalId, (tx) =>
      applyBatch(
        tx as never,
        { tenantId: s.tenant, actorId: terminal.principalId, requestId: "event-test" },
        {
          terminalId: terminal.terminalId,
          companyId: s.company,
          branchId: s.hq,
          principalId: terminal.principalId,
        },
        {
          terminalId: terminal.terminalId,
          batchId: crypto.randomUUID(),
          tickets: [],
          shifts: [],
          tillEvents,
        },
      ),
    );

  /**
   * One cash `POS_TICKET` at the till's own `clientRef`, in `shift`, posted through the REAL apply path.
   * Returns nothing — the two `void` cases resolve the document by `client_ref`, which is the only handle
   * the till has and therefore the only one worth testing.
   *
   * `buildTicket`'s `clientRef` option is what makes the ref caller-chosen; everything else is 6A's
   * default (`SKU-A`, quantity 1, the seeded output tax code). Global Constraint 1: no `document` or
   * `ledger_entry` insert appears here, so what a `void` resolves against is a document the posting
   * service actually wrote.
   */
  const insertPostedTicket = async (shift: string, clientRef: string): Promise<void> => {
    const out = await withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
      applyBatch(
        tx as never,
        { tenantId: s.tenant, actorId: t1.principalId, requestId: "event-test" },
        {
          terminalId: t1.terminalId,
          companyId: s.company,
          branchId: s.hq,
          principalId: t1.principalId,
        },
        {
          terminalId: t1.terminalId,
          batchId: crypto.randomUUID(),
          shifts: [],
          tillEvents: [],
          tickets: [buildTicket(f, { sku: "SKU-A", shiftId: shift, clientRef, tender: "cash" })],
        },
      ),
    );
    expect(out.results[0]!.status).toBe("accepted");
  };

  /** A ticket OBJECT for the in-batch case, not applied — the point of that case is that the ticket and
   *  the `void` event about it travel in one payload and the event still resolves, which only works
   *  because till events run last (Task 3's `3d`). */
  const buildTicketLocal = (shift: string) =>
    buildTicket(f, {
      sku: "SKU-A",
      shiftId: shift,
      clientRef: crypto.randomUUID(),
      tender: "cash",
    });

  it("tillEventRef is the clientRef, and an unkeyable message acks as the empty string", () => {
    expect(tillEventRef({ clientRef: "abc" })).toBe("abc");
    expect(tillEventRef({})).toBe("");
    expect(tillEventRef(null)).toBe("");
  });

  it("a no_sale is inserted with the branch and terminal from the CONTEXT", async () => {
    const m = ev();
    const out = await apply([m]);
    expect(out.tillEventResults).toEqual([{ ref: m.clientRef, status: "accepted", error: null }]);
    const [row] = await db.admin<
      {
        kind: string;
        branch_id: string;
        terminal_id: string;
        shift_id: string;
        cashier_principal_id: string;
        supervisor_principal_id: string | null;
        ticket_document_id: string | null;
      }[]
    >`select kind, branch_id::text, terminal_id::text, shift_id::text, cashier_principal_id::text,
                supervisor_principal_id::text, ticket_document_id::text
           from app.till_event where client_ref = ${m.clientRef}`;
    expect(row!.kind).toBe("no_sale");
    expect(row!.branch_id).toBe(s.hq);
    expect(row!.terminal_id).toBe(t1.terminalId);
    expect(row!.shift_id).toBe(shiftId);
    expect(row!.supervisor_principal_id).toBeNull();
    expect(row!.ticket_document_id).toBeNull();
  });

  // `void` is the third admitted kind and is NOT sent here: it requires a `ticketClientRef` naming a
  // ticket the server has posted, so admitting it is a three-case story of its own further down
  // ("a void resolves its ticket by CLIENT REF…", "…never seen is rejected…", "…in the SAME batch…").
  // The claim this case makes is the two unconditional kinds plus the CHECK's closed vocabulary; a title
  // saying "all three" while sending two would be a green test asserting less than it claims.
  it("no_sale and drawer_open are admitted, and a kind outside the CHECK is rejected by name", async () => {
    const out = await apply([
      ev({ kind: "no_sale" }),
      ev({ kind: "drawer_open" }),
      ev({ kind: "cash_count" }),
    ]);
    expect(out.tillEventResults.map((r) => r.status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(out.tillEventResults[2]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.tillEventResults[2]!.error!.detail).toContain("cash_count");
    // …and the refusal names the vocabulary, so a till author reads the fix out of the message.
    expect(out.tillEventResults[2]!.error!.detail).toContain("void");
  });

  it("re-sending an event answers duplicate and inserts nothing a second time", async () => {
    const m = ev({ kind: "drawer_open" });
    await apply([m]);
    const out = await apply([m]);
    expect(out.tillEventResults[0]!.status).toBe("duplicate");
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_event where client_ref = ${m.clientRef}`;
    expect(n!.n).toBe(1);
  });

  it("an event naming a shift of ANOTHER terminal is rejected (assertShiftKnown)", async () => {
    const out = await apply([ev({ shiftId: foreignShiftId })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");
  });

  it("a no_sale carrying a ticketClientRef is rejected — the CHECK and the message agree", async () => {
    const out = await apply([ev({ kind: "no_sale", ticketClientRef: crypto.randomUUID() })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.detail).toContain("only a void");
  });

  it("a void resolves its ticket by CLIENT REF to a document id, and a supervisor is recorded", async () => {
    // A real posted ticket in this shift, so the resolution has something to find.
    const ticketRef = crypto.randomUUID();
    await insertPostedTicket(shiftId, ticketRef);
    const m = ev({
      kind: "void",
      ticketClientRef: ticketRef,
      supervisorPrincipalId: f.supervisorId,
      reason: "mis-scan",
    });
    const out = await apply([m]);
    expect(out.tillEventResults[0]).toMatchObject({ status: "accepted", error: null });
    const [row] = await db.admin<{ ticket_document_id: string; supervisor_principal_id: string }[]>`
      select ticket_document_id::text, supervisor_principal_id::text
        from app.till_event where client_ref = ${m.clientRef}`;
    const [doc] = await db.admin<{ id: string }[]>`
      select id::text from app.document where company_id = ${s.company} and client_ref = ${ticketRef}`;
    expect(row!.ticket_document_id).toBe(doc!.id);
    expect(
      (
        await db.admin<
          { status: string }[]
        >`select status::text from app.document where id=${doc!.id}`
      )[0]!.status,
    ).toBe("reversed");
    const [cash] = await db.admin<
      { net: string }[]
    >`select coalesce(sum(le.debit-le.credit),0)::text net from app.ledger_entry le join app.account a on a.id=le.account_id join app.document d on d.id=le.document_id where a.code='1110' and (d.id=${doc!.id} or d.reverses_document_id=${doc!.id})`;
    expect(Money.of(cash!.net, currency("MYR")).isZero()).toBe(true);
    expect(row!.supervisor_principal_id).toBe(f.supervisorId);
  });

  it("a void naming a ticket the server has never seen is rejected, not stored with a null ticket", async () => {
    const out = await apply([ev({ kind: "void", ticketClientRef: crypto.randomUUID() })]);
    expect(out.tillEventResults[0]!.status).toBe("rejected");
    expect(out.tillEventResults[0]!.error!.code).toBe("ERR_CONFLICT_REFERENCE");
    expect(out.tillEventResults[0]!.error!.detail).toContain("ticketClientRef");
  });

  it("a void in the SAME batch as its ticket resolves it (till events run last — Task 3's order)", async () => {
    const shift2 = await seedShift(db, s, {
      terminalId: t1.terminalId,
      cashierPrincipalId: s.human,
    });
    const ticket = buildTicketLocal(shift2);
    const m = ev({
      shiftId: shift2,
      kind: "void",
      ticketClientRef: ticket.clientRef,
      supervisorPrincipalId: f.supervisorId,
      reason: "mis-scan",
    });
    const out = await withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
      applyBatch(
        tx as never,
        { tenantId: s.tenant, actorId: t1.principalId, requestId: "event-test" },
        {
          terminalId: t1.terminalId,
          companyId: s.company,
          branchId: s.hq,
          principalId: t1.principalId,
        },
        {
          terminalId: t1.terminalId,
          batchId: crypto.randomUUID(),
          shifts: [],
          tickets: [ticket],
          tillEvents: [m],
        },
      ),
    );
    expect(out.results[0]!.status).toBe("accepted");
    expect(out.tillEventResults[0]).toMatchObject({ status: "accepted", error: null });
  });

  it("one bad event does not roll back its neighbours (savepoint per message)", async () => {
    const good = ev();
    const out = await apply([good, ev({ kind: "nope" }), ev()]);
    expect(out.tillEventResults.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.till_event where client_ref = ${good.clientRef}`;
    expect(n!.n).toBe(1);
  });

  it("no needs_attention row is written for a refused event (amendment A10)", async () => {
    const before = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.needs_attention`;
    await apply([ev({ kind: "nope" })]);
    const after = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.needs_attention`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("financial void replay after close creates no second reversal or event", async () => {
    const shift = await seedShift(db, s, {
      terminalId: t1.terminalId,
      cashierPrincipalId: f.cashierId,
    });
    const ticketRef = crypto.randomUUID();
    await insertPostedTicket(shift, ticketRef);
    const message = ev({
      shiftId: shift,
      kind: "void",
      ticketClientRef: ticketRef,
      supervisorPrincipalId: f.supervisorId,
      reason: "wrong scan",
    });
    expect((await apply([message])).tillEventResults[0]).toMatchObject({
      status: "accepted",
      error: null,
    });
    const closed = await withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
      applyBatch(
        tx,
        { tenantId: s.tenant, actorId: t1.principalId, requestId: "void-close" },
        {
          terminalId: t1.terminalId,
          companyId: s.company,
          branchId: s.hq,
          principalId: t1.principalId,
        },
        {
          terminalId: t1.terminalId,
          batchId: crypto.randomUUID(),
          tickets: [],
          tillEvents: [],
          shifts: [
            {
              shiftId: shift,
              kind: "close",
              terminalId: t1.terminalId,
              cashierPrincipalId: f.cashierId,
              at: new Date().toISOString(),
              currency: "MYR",
              openingFloat: null,
              countedCash: { amount: "0.0000", currency: "MYR" },
            },
          ],
        },
      ),
    );
    expect(closed.shiftResults[0]).toMatchObject({ status: "accepted", error: null });
    const before = await db.admin<
      { docs: number; events: number }[]
    >`select (select count(*)::int from app.document where shift_id=${shift}) docs,(select count(*)::int from app.till_event where shift_id=${shift}) events`;
    expect((await apply([message])).tillEventResults[0]).toMatchObject({
      status: "duplicate",
      error: null,
    });
    expect(
      await db.admin<
        { docs: number; events: number }[]
      >`select (select count(*)::int from app.document where shift_id=${shift}) docs,(select count(*)::int from app.till_event where shift_id=${shift}) events`,
    ).toEqual(before);
  });
  it("refuses self approval without reversing the posted ticket or retaining an event", async () => {
    const ticketRef = crypto.randomUUID();
    await insertPostedTicket(shiftId, ticketRef);
    const message = ev({
      kind: "void",
      ticketClientRef: ticketRef,
      supervisorPrincipalId: f.cashierId,
      reason: "wrong scan",
    });
    expect((await apply([message])).tillEventResults[0]).toMatchObject({
      status: "rejected",
      error: { code: "ERR_OVERRIDE_NOT_AUTHORISED" },
    });
    expect(
      (
        await db.admin<
          { status: string }[]
        >`select status::text from app.document where company_id=${s.company} and client_ref=${ticketRef}`
      )[0]!.status,
    ).toBe("posted");
    expect(
      (
        await db.admin<
          { n: number }[]
        >`select count(*)::int n from app.till_event where client_ref=${message.clientRef}`
      )[0]!.n,
    ).toBe(0);
  });
  // Review MON-05 (2026-11-15): the void's reversal is a stock movement too — its mirror puts the ticket's
  // goods back — so once a later-dated movement of the item exists it is back-dated, and postDocument's step 14
  // must enqueue the cost replay through the terminal's JobClient. The ticket path passed it (apply.ts); the
  // void path did not, so every such void was refused ERR_INTERNAL on every resend and the books kept a sale
  // that was refunded.
  it("a void whose item has a later-dated movement is accepted and enqueues the cost replay (MON-05)", async () => {
    const jobs = recordingJobs();
    const terminal = {
      terminalId: t1.terminalId,
      companyId: s.company,
      branchId: s.hq,
      principalId: t1.principalId,
      jobs,
    };
    const run = (tickets: unknown[], tillEvents: unknown[]) =>
      withTenant(db.rw, s.tenant, t1.principalId, (tx) =>
        applyBatch(
          tx as never,
          { tenantId: s.tenant, actorId: t1.principalId, requestId: "mon-05" },
          terminal,
          {
            terminalId: t1.terminalId,
            batchId: crypto.randomUUID(),
            shifts: [],
            tickets,
            tillEvents,
          } as never,
        ),
      );
    const ticketRef = crypto.randomUUID();
    const sold = await run(
      [buildTicket(f, { sku: "SKU-A", shiftId, clientRef: ticketRef, tender: "cash" })],
      [],
    );
    expect(sold.results[0]!.status).toBe("accepted");
    // A later-dated sale of the same item: tomorrow (posFixture opens the periods a day either side of now).
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const later = await run(
      [
        {
          ...buildTicket(f, {
            sku: "SKU-A",
            shiftId,
            clientRef: crypto.randomUUID(),
            tender: "cash",
          }),
          soldAt: tomorrow,
        },
      ],
      [],
    );
    expect(later.results[0]!.status).toBe("accepted");
    const enqueuedBefore = jobs.enqueued.length;
    const voided = await run(
      [],
      [
        ev({
          kind: "void",
          ticketClientRef: ticketRef,
          supervisorPrincipalId: f.supervisorId,
          reason: "mis-scan",
        }),
      ],
    );
    expect(voided.tillEventResults[0]).toMatchObject({ status: "accepted", error: null });
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text from app.document where company_id = ${s.company} and client_ref = ${ticketRef}`;
    expect(doc!.status).toBe("reversed");
    // The back-dated mirror asked for its replay; it was not silently skipped.
    expect(jobs.enqueued.slice(enqueuedBefore).map((j) => j.name)).toContain(
      "inventory.cost.replay",
    );
  });
});

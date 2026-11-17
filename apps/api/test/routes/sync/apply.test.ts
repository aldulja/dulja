// apps/api/test/routes/sync/apply.test.ts  (abridged to the cases that fix behaviour; each `it` is one clause)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBatch } from "@dulja/db";
import { seedBranchPosPolicy, grantCodes } from "@dulja/db/test";
import { withTenant as prodWithTenant } from "@dulja/db";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";

const ledgerCount = async (a: StartedApi): Promise<number> =>
  (await a.db.admin<{ n: number }[]>`select count(*)::int as n from app.ledger_entry`)[0]!.n;

describe("applyBatch (§4.10.4) — the server half of zero duplicates, zero lost tickets", () => {
  let api: StartedApi;
  let f: PosFixture;
  beforeAll(async () => {
    api = await startApi();
    f = await posFixture(api, "Alpha");
    // A branch with no policy row authorises NO discount (6C's closed defaults), so "discount within the
    // branch limit" (spec:2161) needs a limit to be within: 10% admits the 5.0000-off-50.0000 case below.
    // Void and blind-return stay at their closed defaults, which is what the override cases rely on.
    await seedBranchPosPolicy(api.db, f.s, {
      branchId: f.s.hq,
      limits: { maxLineDiscountPct: "0.100000", maxTicketDiscountPct: "0.100000" },
    });
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  /** Defined HERE and not imported: Task 12's route suite has its own copy for its own database, and a
   *  three-line count is not a shared-helper row §4.17.1 would accept. */

  const apply = (
    tickets: ReturnType<typeof buildTicket>[],
    shifts: unknown[] = [],
    tillEvents: unknown[] = [],
  ) =>
    // `actorId` is the terminal's PRINCIPAL, never its `pos_terminal.id`. Passing the terminal id here sets
    // `app.actor_id` to a uuid that is not a principal, and `document.created_by`'s FK then fails at the header
    // insert — before dedup ever runs — naming a constraint instead of the mistake.
    prodWithTenant(
      api.db.rw,
      { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "b" },
      async (tx) => {
        const t = {
          terminalId: f.terminal.terminalId,
          companyId: f.s.company,
          branchId: f.s.hq,
          principalId: f.terminal.principalId,
        };
        return applyBatch(tx, { tenantId: f.s.tenant, actorId: t.principalId, requestId: "b" }, t, {
          terminalId: f.terminal.terminalId,
          batchId: uuidv7Sync(),
          tickets,
          shifts,
          tillEvents,
        });
      },
    );

  it("a good ticket posts, and the terminal is the ACTOR while the cashier is ATTRIBUTED (LEGACY-044)", async () => {
    const ticket = buildTicket(f, { sku: "SKU-A", quantity: "2.000000", unitPrice: "50.0000" });
    const out = await apply([ticket]);
    expect(out.results[0]!.status, JSON.stringify(out.results)).toBe("accepted");
    const [doc] = await api.db.admin<
      {
        created_by: string;
        posted_by: string;
        attributed_to: string;
        series: string;
        client_ref: string;
        terminal_id: string;
      }[]
    >`
      select created_by, posted_by, attributed_to, series, client_ref::text as client_ref, terminal_id::text as terminal_id
        from app.document where id = ${out.results[0]!.documentId}`;
    expect(doc!.created_by).toBe(f.terminal.principalId);
    expect(doc!.posted_by).toBe(f.terminal.principalId);
    expect(doc!.attributed_to).toBe(f.cashierId);
    expect(doc!.series).toBe(`POS-${f.terminal.code}`);
    expect(doc!.client_ref).toBe(ticket.clientRef);
    expect(doc!.terminal_id).toBe(f.terminal.terminalId);
  });

  it("re-applying the same ticket answers `duplicate` and writes nothing (spec:1304)", async () => {
    const ticket = buildTicket(f, { sku: "SKU-A" });
    const first = await apply([ticket]);
    const before = await ledgerCount(api);
    const second = await apply([ticket]);
    expect(second.results[0]!.status).toBe("duplicate");
    expect(second.results[0]!.documentId).toBe(first.results[0]!.documentId);
    expect(await ledgerCount(api)).toBe(before);
  });

  it("a bad ticket rolls back to ITS savepoint; the good ones in the same batch still commit (spec:1303)", async () => {
    const good1 = buildTicket(f, { sku: "SKU-A" });
    const bad = buildTicket(f, { sku: "SKU-A", cashierPrincipalId: f.supervisorId }); // holds no pos.ticket.sell
    const good2 = buildTicket(f, { sku: "SKU-B" });
    const out = await apply([good1, bad, good2]);
    expect(out.results.map((r) => r.status)).toEqual(["accepted", "rejected", "accepted"]);
    expect(out.results[1]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    const [na] = await api.db.admin<{ error_code: string; payload: { clientRef: string } }[]>`
      select error_code, payload from app.needs_attention where client_ref = ${bad.clientRef}`;
    expect(na!.error_code).toBe("ERR_RBAC_FORBIDDEN");
    expect(na!.payload.clientRef).toBe(bad.clientRef); // the WHOLE ticket is recoverable from the server
    const [none] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.document where client_ref = ${bad.clientRef}`;
    expect(none!.n).toBe(0); // "never silently into the ledger" (spec:1305)
  });

  it("a void beyond the branch limit needs an override by a different live supervisor", async () => {
    await grantCodes(api.db, f.s, {
      principalId: f.cashierId,
      branchIds: [f.s.hq],
      codes: ["pos.ticket.void"],
    });
    // The base void grant is held, but self-approval cannot lift the closed branch limit.
    const voided = buildTicket(f, {
      sku: "SKU-A",
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "void",
          supervisorPrincipalId: f.cashierId,
          reason: "mis-scan",
        },
      ],
    });
    const out = await apply([voided]);
    expect(out.results[0]!.status).toBe("rejected");
    // The SUPERVISOR is the cashier here, and app.assert_override_authorised refuses a second principal that
    // is the same principal — the exact clause that makes "a second principal" mean something.
    expect(out.results[0]!.error!.code).toBe("ERR_OVERRIDE_NOT_AUTHORISED");

    const ok = buildTicket(f, {
      sku: "SKU-A",
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "void",
          supervisorPrincipalId: f.supervisorId,
          reason: "mis-scan",
        },
      ],
    });
    const out2 = await apply([ok]);
    expect(out2.results[0]!.status).toBe("accepted");
    const [ev] = await api.db.admin<
      { actor_id: string; attributed_to: string; override_code: string; reason: string }[]
    >`
      select actor_id, attributed_to, override_code, reason from app.document_event
       where document_id = ${out2.results[0]!.documentId} and event_kind = 'override'`;
    expect(ev!.actor_id).toBe(f.terminal.principalId); // the TERMINAL acted
    expect(ev!.attributed_to).toBe(f.supervisorId); // the SUPERVISOR is attributed (spec:1324)
    expect(ev!.override_code).toBe("pos.ticket.override");
    expect(ev!.reason).toBe("void: mis-scan"); // "<subject>: <reason>" (§4.10.1)
  });

  it("a tax figure the server does not agree with is REFUSED, not silently corrected (LEGACY-020)", async () => {
    const wrong = buildTicket(f, { sku: "SKU-A" });
    wrong.lines[0]!.taxAmount = { amount: "0.0000", currency: "MYR" };
    const out = await apply([wrong]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_VALIDATION_FAILED");
    expect(out.results[0]!.error!.detail).toContain("line 1");
  });

  it("6D accepts shift opens and actual till events without losing messages (§4.10.1)", async () => {
    const shiftId = uuidv7Sync();
    const eventRef = uuidv7Sync();
    const out = await apply(
      [],
      [
        {
          shiftId,
          kind: "open",
          terminalId: f.terminal.terminalId,
          cashierPrincipalId: f.cashierId,
          at: new Date().toISOString(),
          currency: "MYR",
          openingFloat: { amount: "0.0000", currency: "MYR" },
          countedCash: null,
        },
      ],
      [
        {
          clientRef: eventRef,
          // The shift this same batch opens: opens apply before till events (6D Task 6 Step 5), so the
          // event's parent exists by the time it is checked — an incidental proof of the ordering.
          shiftId,
          kind: "no_sale",
          ticketClientRef: null,
          cashierPrincipalId: f.cashierId,
          supervisorPrincipalId: null,
          occurredAt: new Date().toISOString(),
        },
      ],
    );
    expect(out.shiftResults[0]!.status).toBe("accepted");
    expect(out.shiftResults[0]!.error).toBeNull();
    expect(out.tillEventResults[0]!.status).toBe("accepted");
    expect(out.tillEventResults[0]!.error).toBeNull();
    // `accepted` is a flag; the rows are the proof that both messages persisted, once each.
    const [shifts] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.shift where id = ${shiftId}`;
    expect(shifts!.n).toBe(1);
    const [events] = await api.db.admin<{ n: number; shift: string }[]>`
      select count(*)::int as n, min(shift_id::text) as shift from app.till_event where client_ref = ${eventRef}`;
    expect(events).toEqual({ n: 1, shift: shiftId });
  });

  it("a quick-created customer is applied once, and a re-send creates no second party", async () => {
    const id = uuidv7Sync(); // the party id the till mints OFFLINE: a uuidv7, never a v4
    const t1 = buildTicket(f, {
      sku: "SKU-A",
      customerId: id,
      newCustomer: { id, code: "WALK-1", nameEn: "Ali", phone: null },
    });
    await apply([t1]);
    const t2 = buildTicket(f, {
      sku: "SKU-B",
      customerId: id,
      newCustomer: { id, code: "WALK-1", nameEn: "Ali", phone: null },
    });
    const out = await apply([t2]);
    expect(out.results[0]!.status, JSON.stringify(out.results)).toBe("accepted");
    const [n] = await api.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.party where id = ${id}`;
    expect(n!.n).toBe(1);
  });

  it("selling more than the layers hold is refused at the data layer (acceptance test 18's sync path)", async () => {
    const huge = buildTicket(f, { sku: "SKU-C", quantity: "999999.000000" });
    const out = await apply([huge]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_STOCK_INSUFFICIENT");
  });

  it("a DISCOUNT the cashier holds is applied; a BLIND RETURN she does not is ERR_RBAC_FORBIDDEN", async () => {
    // The required codes come from the ticket's own CONTENT (`requiredCodes`), so neither code is a catalogue
    // row nothing evaluates. spec:2161 verbatim: a cashier may "discount within the branch limit" and may not
    // take a "blind return" — and the fixture grants her exactly the first.
    const discounted = buildTicket(f, { sku: "SKU-A", discount: "5.0000" });
    expect((await apply([discounted])).results[0]!.status, "pos.ticket.discount is held").toBe(
      "accepted",
    );

    // A return with NO `returnsClientRef` is a BLIND return, which asks for pos.ticket.return_blind. The
    // cashier does not hold it, so it is refused BEFORE any write — and the detail names the code and the
    // branch, because "forbidden" alone is unactionable in a shop. 6C's `verifyTicket` made an authority gap
    // never override-able (6c:4466 — a supervisor lifts a LIMIT, not a missing grant), so the detail names
    // the grant and no override; 6c:5094 replaces 6A's wording here rather than keeping a second path alive.
    const blind = buildTicket(f, { sku: "SKU-A", kind: "return", returnsClientRef: null });
    const out = await apply([blind]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(out.results[0]!.error!.detail).toContain("pos.ticket.return_blind");
    expect(out.results[0]!.error!.detail).toContain(f.s.hq);

    // With the base grant held, the branch's closed blind-return limit still refuses it unaided ...
    await grantCodes(api.db, f.s, {
      principalId: f.cashierId,
      branchIds: [f.s.hq],
      codes: ["pos.ticket.return_blind"],
    });
    const unaided = await apply([
      buildTicket(f, { sku: "SKU-A", kind: "return", returnsClientRef: null }),
    ]);
    expect(unaided.results[0]!.status).toBe("rejected");
    expect(unaided.results[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");

    // ... and a different live supervisor can lift it.
    const rescued = buildTicket(f, {
      sku: "SKU-A",
      kind: "return",
      returnsClientRef: null,
      events: [
        {
          kind: "override",
          code: "pos.ticket.override",
          subject: "blind_return",
          supervisorPrincipalId: f.supervisorId,
          reason: "no receipt",
        },
      ],
    });
    expect((await apply([rescued])).results[0]!.status).toBe("accepted");
  });

  it("a refusal cured on the server posts on the re-send and closes its needs-attention row", async () => {
    const setLimit = (pct: string) =>
      prodWithTenant(
        api.db.migrator,
        { tenantId: f.s.tenant, actorId: f.s.system, requestId: "cure" },
        (tx) => tx`update app.branch_pos_policy
          set max_line_discount_pct = ${pct}, max_ticket_discount_pct = ${pct}
          where company_id = ${f.s.company} and branch_id = ${f.s.hq}`,
      );
    const queue = async (clientRef: string) =>
      (
        await api.db.admin<{ resolved_at: Date | null; resolution_note: string | null }[]>`
          select resolved_at, resolution_note from app.needs_attention where client_ref = ${clientRef}`
      )[0];
    const ticket = buildTicket(f, { sku: "SKU-A", discount: "10.0000" });
    const refused = await apply([ticket]);
    expect(refused.results[0]!.error!.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect((await queue(ticket.clientRef))?.resolved_at).toBeNull();
    await setLimit("0.300000");
    try {
      const posted = await apply([ticket]);
      expect(posted.results[0]!.status).toBe("accepted");
      const row = await queue(ticket.clientRef);
      expect(row?.resolved_at).not.toBeNull();
      expect(row?.resolution_note).toContain(posted.results[0]!.number!);
    } finally {
      await setLimit("0.100000");
    }
  });

  it("a failure the classifier cannot place is ERR_SYNC_TICKET_REJECTED — named, never silent", async () => {
    // The default branch of `classify()`. It is exercised through a violation no other branch claims: a
    // NOT NULL on a column the ticket controls (SQLSTATE 23502), which is neither 23505, 23503, 42501 nor a
    // 23514 carrying an ERR_ token. This case is why the row may be in ERRORS at all: §4.2.4's `error-codes`
    // check fails the build for a registered code with no raiser, so a default nothing reaches is a red tree.
    const id = uuidv7Sync();
    const noUnit = buildTicket(f, {
      sku: "SKU-A",
      customerId: id,
      newCustomer: { id, code: "NULL-NAME", nameEn: null as unknown as string, phone: null },
    });
    const out = await apply([noUnit]);
    expect(out.results[0]!.status).toBe("rejected");
    expect(out.results[0]!.error!.code).toBe("ERR_SYNC_TICKET_REJECTED");

    // And it still lands in the queue with the WHOLE ticket — an unclassifiable failure is refused, not lost.
    const [na] = await api.db.admin<{ error_code: string; payload: { clientRef: string } }[]>`
      select error_code, payload from app.needs_attention where client_ref = ${noUnit.clientRef}`;
    expect(na!.error_code).toBe("ERR_SYNC_TICKET_REJECTED");
    expect(na!.payload.clientRef).toBe(noUnit.clientRef);
  });
});

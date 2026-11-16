import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { zReport, salesByCashier, reverseDocument, type ZReport } from "@dulja/db";
import { grantCodes, withTenant } from "@dulja/db/test";
import { shiftRef, type BatchResult, type ShiftOpenClose } from "@dulja/sync";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { staffFixture, type StaffFixture } from "./support/staff";
import { buildTicket, syncRequest } from "./support/pos";

/** The report window: a day either side of the run date, because the day below is synced at `now()` and
 *  the report compares dates in the company's timezone; a fixed calendar year empties it at year end. */
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const FROM = day(-1);
const TO = day(1);
const MYR = currency("MYR");
/** What a CLOSE stored about the drawer: facts about a count, which no later document may move. */
const closeFacts = (z: ZReport) => ({
  countedCash: z.countedCash,
  expectedCash: z.expectedCash,
  overShort: z.overShort,
  overShortDocumentId: z.overShortDocumentId,
  cashControl: z.cashControl,
});
const cardTender = (z: ZReport) => z.tenders.find((t) => t.method === "card")!.amount;

/**
 * Acceptance test 21 — "the shift Z-report ties to the ledger to the cent" (spec:2292, 2439).
 *
 * The day, all through the real signed `POST /v1/sync/tickets`: a 200.0000 float; cash sales 45.50, 12.00,
 * 133.25 and 8.75; card 99.99 and 50.00; a 500.00 transfer and a 20.00 store-credit sale; a 12.00 cash
 * refund of the second sale; a no-sale, a drawer-open and a supervisor void of the 45.50 sale (posted as its
 * reversal); and a close counting 340.5000. Expected is 200 + 199.50 − 12 − 45.50 = 342.0000, so the drawer
 * is 1.5000 short. Nothing here writes a ledger, document or shift row by hand: a fixture that did would
 * prove only that a fixture agrees with a report.
 */
describe("acceptance 21 — signed shift close reconciles to posted ledger exactly", () => {
  let api: StartedApi;
  let f: StaffFixture;
  let shiftId: string;
  const sent: { tickets: unknown[]; shifts: unknown[]; tillEvents: unknown[] } = {
    tickets: [],
    shifts: [],
    tillEvents: [],
  };
  const push = async (body: Partial<typeof sent>, replay = false) => {
    const res = await syncRequest(api, f.terminalA, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminalA.terminalId,
        batchId: crypto.randomUUID(),
        tickets: [],
        shifts: [],
        tillEvents: [],
        ...body,
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BatchResult;
    // Zero lost (spec:1337): every message sent is answered under its OWN ref, exactly once. `every` below is
    // true of an empty array, so a message the server dropped would pass it alone; `drainOutbox` acks only a
    // ref present in a result array, and a ref answered by silence would sit in the till's outbox for ever.
    expect(out.results.map((r) => r.clientRef).toSorted()).toEqual(
      ((body.tickets ?? []) as { clientRef: string }[]).map((t) => t.clientRef).toSorted(),
    );
    expect(out.tillEventResults.map((r) => r.ref).toSorted()).toEqual(
      ((body.tillEvents ?? []) as { clientRef: string }[]).map((e) => e.clientRef).toSorted(),
    );
    expect(out.shiftResults.map((r) => r.ref).toSorted()).toEqual(
      ((body.shifts ?? []) as ShiftOpenClose[]).map((s) => shiftRef(s)).toSorted(),
    );
    for (const rows of [out.results, out.shiftResults, out.tillEventResults])
      expect(
        rows.every((row) => row.status === (replay ? "duplicate" : "accepted")),
        JSON.stringify(out),
      ).toBe(true);
    if (!replay) {
      sent.tickets.push(...(body.tickets ?? []));
      sent.shifts.push(...(body.shifts ?? []));
      sent.tillEvents.push(...(body.tillEvents ?? []));
    }
    return out;
  };
  beforeAll(async () => {
    api = await startApi();
    f = await staffFixture(api, "reconcile21");
    await grantCodes(api.db, f.seed, {
      principalId: f.cashierA,
      branchIds: [f.branchA],
      codes: ["pos.shift.own", "pos.ticket.void"],
      roleCode: "reconcile-own",
    });
    shiftId = crypto.randomUUID();
    await push({
      shifts: [
        {
          shiftId,
          kind: "open",
          terminalId: f.terminalA.terminalId,
          cashierPrincipalId: f.cashierA,
          at: new Date().toISOString(),
          currency: "MYR",
          openingFloat: { amount: "200.0000", currency: "MYR" },
          countedCash: null,
        },
      ],
    });
    const refs = Array.from({ length: 8 }, () => crypto.randomUUID());
    const values = [
      "45.5000",
      "12.0000",
      "133.2500",
      "8.7500",
      "99.9900",
      "50.0000",
      "500.0000",
      "20.0000",
    ];
    const tenders = [
      "cash",
      "cash",
      "cash",
      "cash",
      "card",
      "card",
      "transfer",
      "store_credit",
    ] as const;
    await push({
      tickets: values.map((unitPrice, i) =>
        buildTicket(f.pos, {
          sku: "SKU-A",
          shiftId,
          cashierPrincipalId: f.cashierA,
          clientRef: refs[i]!,
          unitPrice,
          tender: tenders[i]!,
        }),
      ),
    });
    await push({
      tickets: [
        buildTicket(f.pos, {
          sku: "SKU-A",
          shiftId,
          cashierPrincipalId: f.cashierA,
          kind: "return",
          returnsClientRef: refs[1]!,
          unitPrice: "12.0000",
          tender: "cash",
        }),
      ],
    });
    // Financial void precedes close in the SAME signed batch: the count must include its reversal.
    await push({
      tillEvents: ["no_sale", "drawer_open", "void"].map((kind) => ({
        clientRef: crypto.randomUUID(),
        shiftId,
        kind,
        ticketClientRef: kind === "void" ? refs[0] : null,
        cashierPrincipalId: f.cashierA,
        supervisorPrincipalId: kind === "void" ? f.supervisorA : null,
        reason: kind === "void" ? "Cancelled duplicate sale" : null,
        occurredAt: new Date().toISOString(),
      })),
      shifts: [
        {
          shiftId,
          kind: "close",
          terminalId: f.terminalA.terminalId,
          cashierPrincipalId: f.cashierA,
          at: new Date(Date.now() + 1000).toISOString(),
          currency: "MYR",
          openingFloat: null,
          countedCash: { amount: "340.5000", currency: "MYR" },
        },
      ],
    });
  }, 300000);
  afterAll(async () => api.stop());
  const read = <T>(fn: Parameters<typeof withTenant<T>>[3]) =>
    withTenant(api.db.rw, f.seed.tenant, f.seed.system, fn);
  const zOf = async (): Promise<ZReport> => {
    const [z] = await read((tx) =>
      zReport(tx as never, { companyId: f.seed.company, shiftId, limit: 1 }),
    );
    expect(z).toBeDefined();
    return z!;
  };
  /** Each tender line equals the ledger's own net movement on its §4.15 account over the shift's posted and
   *  reversed POS tickets — an independent query, compared as numeric(19,4) text. */
  const tendersTieToLedger = async (z: ZReport) => {
    for (const tender of z.tenders) {
      const [row] = await read(
        (tx) =>
          tx<
            { amount: string }[]
          >`select coalesce(sum(le.debit-le.credit),0)::numeric(19,4)::text amount from app.ledger_entry le join app.document d on d.id=le.document_id join app.account a on a.id=le.account_id join app.document_type dt on dt.id=d.document_type_id where d.shift_id=${shiftId} and d.status in ('posted','reversed') and dt.code='POS_TICKET' and a.code=${tender.accountCode} and le.currency=${z.currency}`,
      );
      expect(tender.amount, tender.method).toBe(row!.amount);
    }
  };
  it("every tender equals the independent posted/reversed ledger movement", async () => {
    await tendersTieToLedger(await zOf());
  });
  it("opening_float + net(1110) over EVERY posted/reversed document of the shift, TILL_OVER_SHORT included, == counted_cash", async () => {
    const z = await zOf();
    expect(z.countedCash).toBe("340.5000");
    // No document-type filter: the over/short correction is IN this sum, which is the difference from ADR
    // 0063's expectation (it excludes TILL_OVER_SHORT). The drawer after the correction must be what the
    // cashier physically counted; the two agree only if the close posted the right amount on the right side.
    // Compared in SQL numeric, never in a JS number.
    const [tie] = await read(
      (tx) => tx<{ closes: boolean; drawer: string }[]>`
        with net as (
          select coalesce(sum(le.debit - le.credit), 0)::numeric(19,4) as movement
            from app.ledger_entry le
            join app.document d on d.id = le.document_id
            join app.account  a on a.id = le.account_id
           where d.shift_id = ${shiftId} and d.status in ('posted', 'reversed')
             and a.code = '1110' and le.currency = ${z.currency})
        select (${z.openingFloat}::numeric(19,4) + movement) = ${z.countedCash}::numeric(19,4) as closes,
               (${z.openingFloat}::numeric(19,4) + movement)::numeric(19,4)::text as drawer
          from net`,
    );
    expect(tie!.drawer).toBe("340.5000");
    expect(tie!.closes).toBe(true);
  });
  it("opening plus ticket cash is expected, and the 1.50 short posts 5120 debit / 1110 credit as TOS-<terminal>", async () => {
    const z = await zOf();
    expect(z.expectedCash).toBe("342.0000");
    expect(z.overShort).toBe("-1.5000");
    const cash = z.tenders.find((t) => t.method === "cash")!;
    expect(Money.of(z.openingFloat, MYR).add(Money.of(cash.amount, MYR)).toString()).toBe(
      z.expectedCash,
    );
    expect(z.cashControl).toEqual([
      { documentTypeCode: "TILL_OVER_SHORT", amount: "-1.5000", currency: "MYR" },
    ]);
    // The three till events, each answered and stored once, per kind.
    expect(z.tillEvents).toEqual([
      { kind: "drawer_open", count: 1 },
      { kind: "no_sale", count: 1 },
      { kind: "void", count: 1 },
    ]);
    // SHORT: the expense is debited and the drawer credited, each leg a positive magnitude (§4.4.2 A9).
    const legs = await read(
      (tx) => tx<{ code: string; debit: string; credit: string; base_debit: string }[]>`
        select a.code, le.debit::text, le.credit::text, le.base_debit::text
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${z.overShortDocumentId} order by a.code`,
    );
    expect(legs).toEqual([
      { code: "1110", debit: "0.0000", credit: "1.5000", base_debit: "0.0000" },
      { code: "5120", debit: "1.5000", credit: "0.0000", base_debit: "1.5000" },
    ]);
    // A real, posted, numbered document in the terminal's own series (amendment A15).
    const [doc] = await read(
      (tx) => tx<{ status: string; series: string; number: string; code: string }[]>`
        select d.status::text, d.series, d.number::text, t.code
          from app.document d join app.document_type t on t.id = d.document_type_id
         where d.id = ${z.overShortDocumentId}`,
    );
    expect(doc!.code).toBe("TILL_OVER_SHORT");
    expect(doc!.status).toBe("posted");
    expect(doc!.series).toBe(`TOS-${f.terminalA.code}`);
    expect(doc!.number).toMatch(/^[1-9]\d*$/);
  });
  it("cashier base revenue equals the independent income ledger movement, attributed to the CASHIER", async () => {
    const rows = await read((tx) =>
      salesByCashier(tx as never, {
        companyId: f.seed.company,
        from: FROM,
        to: TO,
        branchId: f.branchA,
        limit: 50,
      }),
    );
    // Hazard 19: `attributed_to` is the cashier; the terminal only ACTED, and must not head a row of its own.
    expect(rows.map((r) => r.cashierPrincipalId)).toContain(f.cashierA);
    expect(rows.map((r) => r.cashierPrincipalId)).not.toContain(f.terminalA.principalId);
    const row = rows.find((r) => r.cashierPrincipalId === f.cashierA)!;
    const [ledger] = await read(
      (tx) =>
        tx<
          { amount: string }[]
        >`select coalesce(sum(le.credit-le.debit),0)::numeric(19,4)::text amount from app.ledger_entry le join app.account a on a.id=le.account_id join app.document d on d.id=le.document_id where d.shift_id=${shiftId} and d.status in ('posted','reversed') and a.type='income'`,
    );
    expect(row.netSalesBase).toBe(ledger!.amount);
    expect(row.overShortBase).toBe("-1.5000");
  });
  it("resending the whole day with a fresh batch creates no document, ledger or event", async () => {
    const counts = () =>
      read(
        (tx) =>
          tx`select (select count(*) from app.document where shift_id=${shiftId}) documents,(select count(*) from app.ledger_entry le join app.document d on d.id=le.document_id where d.shift_id=${shiftId}) ledger,(select count(*) from app.till_event where shift_id=${shiftId}) events`,
      );
    const before = await counts();
    await push(sent, true);
    expect(await counts()).toEqual(before);
  });
  it("the Z-report's own figures survive a reversal of one of the day's tickets", async () => {
    // A card sale is charged back after the close. The count, the expectation and the difference are stored
    // facts about a drawer that was counted, and must not move; the tender lines read the ledger, and do —
    // the money did come back. This case pins which half is which.
    const before = await zOf();
    const [card] = await read(
      (tx) => tx<{ id: string; date: string; amount: string }[]>`
        select d.id::text, d.effective_date::text as date, le.debit::text as amount
          from app.document d
          join app.document_type t on t.id = d.document_type_id
          join app.ledger_entry le on le.document_id = d.id
          join app.account a on a.id = le.account_id
         where d.shift_id = ${shiftId} and t.code = 'POS_TICKET' and d.status = 'posted'
           and d.reverses_document_id is null and a.code = '1120'
         order by d.id limit 1`,
    );
    expect(card).toBeDefined();
    // As the TERMINAL: the reversal is another POS_TICKET, whose `approval.post` is `pos.sync.push`, and it is
    // dated on the source's own effective date (the reconciliation's Task 5 note).
    await withTenant(api.db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
      reverseDocument(
        tx as never,
        { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "test21-reversal" },
        { documentId: card!.id, effectiveDate: card!.date, reason: "chargeback" },
      ),
    );

    const after = await zOf();
    expect(closeFacts(after)).toEqual(closeFacts(before));
    expect(cardTender(before)).toBe("149.9900");
    expect(cardTender(after)).toBe(
      Money.of("149.9900", MYR).subtract(Money.of(card!.amount, MYR)).toString(),
    );
    await tendersTieToLedger(after);
  });
  it("zero lost tickets — every message is answered under its own ref, a refusal included, none by silence", async () => {
    // Called directly, not through `push`: one ticket here names the CLOSED shift and is refused (the 6D
    // integrity correction), and a refusal is still an answer the till's outbox can act on. The rest open a
    // fresh shift and trade on it, so this case runs last.
    const nextShift = crypto.randomUUID();
    const now = new Date().toISOString();
    const open: ShiftOpenClose = {
      shiftId: nextShift,
      kind: "open",
      terminalId: f.terminalA.terminalId,
      cashierPrincipalId: f.cashierA,
      at: now,
      currency: "MYR",
      openingFloat: { amount: "0.0000", currency: "MYR" },
      countedCash: null,
    };
    const sale = (shift: string) =>
      buildTicket(f.pos, {
        sku: "SKU-A",
        shiftId: shift,
        cashierPrincipalId: f.cashierA,
        unitPrice: "1.0000",
        tender: "cash",
      });
    const onNext = sale(nextShift);
    const onClosed = sale(shiftId);
    const noSale = {
      clientRef: crypto.randomUUID(),
      shiftId: nextShift,
      kind: "no_sale",
      ticketClientRef: null,
      cashierPrincipalId: f.cashierA,
      supervisorPrincipalId: null,
      reason: null,
      occurredAt: now,
    };
    const res = await syncRequest(api, f.terminalA, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminalA.terminalId,
        batchId: crypto.randomUUID(),
        tickets: [onNext, onClosed],
        shifts: [open],
        tillEvents: [noSale],
      },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as BatchResult;
    expect(out.shiftResults.map((r) => [r.ref, r.status])).toEqual([[shiftRef(open), "accepted"]]);
    expect(out.tillEventResults.map((r) => [r.ref, r.status])).toEqual([
      [noSale.clientRef, "accepted"],
    ]);
    expect(Object.fromEntries(out.results.map((r) => [r.clientRef, r.status]))).toEqual({
      [onNext.clientRef]: "accepted",
      [onClosed.clientRef]: "rejected",
    });
    expect(out.results.find((r) => r.clientRef === onClosed.clientRef)!.error).not.toBeNull();
  });
});

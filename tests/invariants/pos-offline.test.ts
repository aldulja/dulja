import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import { createPromotion, withTenant, verifyPromotions, verifyTicket } from "@dulja/db";
import { draftTicket, checkLimits } from "../../apps/pos/src/main/ticket";
import { Quantity } from "@dulja/domain";
import { drainOutbox, SYNC_BATCH_SYNC_LIMIT, CATALOGUE_STREAMS, type Ticket } from "@dulja/sync";
import { sharedApi } from "../support/api";
import { tillFixture, openTill, sellOffline, type TillFixture } from "./support/till";
import { tillUuidv7 } from "../../apps/pos/src/main/ticket";
const MYR = currency("MYR");
let f: TillFixture;
const ctx = () => ({
  tenantId: f.staff.seed.tenant,
  actorId: f.staff.seed.system,
  requestId: tillUuidv7(),
});
beforeAll(async () => {
  f = await tillFixture((await sharedApi()).api, "OFFLINE6B");
  await openTill(f);
}, 180_000);
afterAll(async () => {
  if (f) await f.close();
});
describe("500 real offline tickets, reconnect and replay", () => {
  it("pulls eight durable cursors and authenticates the real cashier PIN", async () => {
    expect(f.cashier?.principalId).toBe(f.staff.cashierA);
    const cursors = Object.fromEntries(
      await Promise.all(
        CATALOGUE_STREAMS.map(async (stream) => [stream, await f.store.getCursor(stream)]),
      ),
    );
    expect(Object.keys(cursors).toSorted()).toEqual([...CATALOGUE_STREAMS].toSorted());
    expect(new Set(Object.values(cursors).map(String)).size).toBe(1);
    expect(f.store.catalogueState().pulledAt).not.toBeNull();
  });
  it("sells 500 tickets with no network call and persists every exact line/tender/outbox", () => {
    f.transport.offline = true;
    const before = f.transport.calls;
    const refs = sellOffline(f, 500);
    expect(refs).toHaveLength(500);
    expect(new Set(refs).size).toBe(500);
    expect(f.transport.calls).toBe(before);
    expect(
      f.db.raw.prepare("select count(*) n from ticket where status='completed'").get(),
    ).toEqual({ n: 500 });
    expect(
      f.db.raw.prepare("select count(*) n from ticket_line where quantity='0.100000'").get(),
    ).toEqual({ n: 500 });
    expect(f.db.raw.prepare("select count(*) n from ticket_tender").get()).toEqual({ n: 500 });
    expect(
      f.db.raw
        .prepare("select count(*) n from outbox where kind='ticket' and acked_at is null")
        .get(),
    ).toEqual({ n: 500 });
  });
  it("an offline drain acknowledges nothing and leaves all 501 messages durable", async () => {
    await f.loops.drainNow();
    expect(f.store.catalogueState().pendingOutbox).toBe(501);
    expect(f.loops.state().online).toBe(false);
    expect(f.loops.state().lastError).toContain("ECONNREFUSED");
  });
  it("reconnects through the shipped HTTP transport and posts all 500 exactly once", async () => {
    f.transport.offline = false;
    const outcome = await drainOutbox(f.store, f.transport, {
      terminalId: f.terminalId,
      newBatchId: () => tillUuidv7(),
      batchSize: SYNC_BATCH_SYNC_LIMIT,
    });
    expect(outcome.accepted).toBe(501);
    expect(outcome.rejected).toBe(0);
    expect(
      f.db.raw
        .prepare("select count(*) n from outbox where kind='ticket' and acked_at is null")
        .get(),
    ).toEqual({ n: 0 });
    const refs = f.db.raw
      .prepare<[], { id: string }>("select id from ticket")
      .all()
      .map((row) => row.id);
    const [count] = await withTenant(
      f.api.db.rw,
      ctx(),
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int n from app.document where company_id=${f.staff.seed.company} and client_ref=any(${refs}::uuid[]) and status='posted'`,
    );
    expect(count!.n).toBe(500);
  }, 300_000);
  it("replays two fresh batch IDs without changing documents, lines or ledger entries", async () => {
    const counts = () =>
      withTenant(
        f.api.db.rw,
        ctx(),
        (tx) =>
          tx<
            { documents: number; lines: number; entries: number }[]
          >`select (select count(*)::int from app.document) documents,(select count(*)::int from app.document_line) lines,(select count(*)::int from app.ledger_entry) entries`,
      );
    const before = await counts();
    const payloads = f.db.raw
      .prepare<[], { payload: string }>(
        "select payload from outbox where kind='ticket' order by created_at,rowid limit 200",
      )
      .all()
      .map((row) => JSON.parse(row.payload) as Ticket);
    for (let n = 0; n < 2; n += 1) {
      const answer = await f.transport.pushTickets({
        terminalId: f.terminalId,
        batchId: tillUuidv7(),
        tickets: payloads,
        shifts: [],
        tillEvents: [],
      });
      expect(answer.results).toHaveLength(200);
      expect(answer.results.every((result) => result.status === "duplicate")).toBe(true);
    }
    expect(await counts()).toEqual(before);
  }, 300_000);
  it("reconciles local exact gross, net, tax and tender totals to server item and tender lines", async () => {
    const local = f.db.raw
      .prepare<[], { total: string; net_total: string; tax_total: string }>(
        "select total,net_total,tax_total from ticket where status='completed'",
      )
      .all();
    const gross = local.reduce((sum, row) => sum.add(Money.of(row.total, MYR)), Money.zero(MYR));
    const net = local.reduce((sum, row) => sum.add(Money.of(row.net_total, MYR)), Money.zero(MYR));
    const tax = local.reduce((sum, row) => sum.add(Money.of(row.tax_total, MYR)), Money.zero(MYR));
    const [remote] = await withTenant(
      f.api.db.rw,
      ctx(),
      (tx) =>
        tx<
          { gross: string; net: string; tax: string; tenders: string }[]
        >`select coalesce(sum(l.total_incl_tax) filter(where l.kind='item'),0)::text gross,coalesce(sum(l.amount) filter(where l.kind='item'),0)::text net,coalesce(sum(l.tax_amount) filter(where l.kind='item'),0)::text tax,coalesce(sum(l.amount) filter(where l.kind='tender'),0)::text tenders from app.document_line l join app.document d on d.id=l.document_id where d.company_id=${f.staff.seed.company} and d.client_ref is not null`,
    );
    expect(Money.of(remote!.gross, MYR).equals(gross)).toBe(true);
    expect(Money.of(remote!.net, MYR).equals(net)).toBe(true);
    expect(Money.of(remote!.tax, MYR).equals(tax)).toBe(true);
    expect(Money.of(remote!.tenders, MYR).equals(gross)).toBe(true);
    expect(gross.toString()).toBe("575.0000");
  });
});

it("pins the till and server's exact over-limit refusal text", async () => {
  if (!f.cashier) throw new Error("cashier missing");
  const draft = draftTicket(f.db, {
    shiftId: f.shiftId,
    cashier: f.cashier,
    lines: [
      {
        itemId: f.staff.itemId,
        quantity: Quantity.of("1.000000"),
        discount: Money.of("5.0000", MYR),
      },
    ],
  });
  const local = checkLimits(f.cashier, draft, {
    catalogueUnitPrices: [draft.lines[0]!.unitPrice],
    blind: false,
    voided: false,
  });
  const wire: Ticket = {
    clientRef: draft.clientRef,
    shiftId: f.shiftId,
    cashierPrincipalId: f.cashier.principalId,
    customerId: null,
    kind: "sale",
    returnsClientRef: null,
    currency: "MYR",
    soldAt: new Date().toISOString(),
    lines: draft.lines.map((line) => ({
      lineNo: line.lineNo,
      itemId: line.itemId,
      lotId: line.lotId,
      quantity: line.quantity.toString(),
      unitId: line.unitId,
      unitPrice: line.unitPrice.toJSON(),
      discount: line.discount.toJSON(),
      taxCodeId: line.taxCodeId,
      taxAmount: line.taxAmount.toJSON(),
      total: line.total.toJSON(),
    })),
    tenders: [],
    events: [],
    attendance: [],
    catalogueRevision: 0n,
  };
  const server = await withTenant(f.api.db.rw, ctx(), (tx) =>
    verifyTicket(
      tx,
      { companyId: f.staff.seed.company, branchId: f.staff.branchA, currency: "MYR" },
      wire,
    ),
  );
  const details = local
    .filter((r) => r.kind !== "price_override")
    .map((r) => r.detail)
    .toSorted();
  expect(details.length).toBeGreaterThan(0);
  expect(server.refusals.map((r) => r.detail).toSorted()).toEqual(details);
});

// The same pin with a promoted line (ADR 0059's PR 12 review amendment): the till leaves the promotion's share
// out of the cashier's discount, the server leaves it out once it has recomputed it from its own row, and the
// two still refuse the over-limit manual part with the same words — naming the manual 5.0000, never the line's
// whole 6.1500.
it("pins the same refusal text for a promoted line, both sides counting the cashier's share alone", async () => {
  if (!f.cashier) throw new Error("cashier missing");
  const created = await withTenant(f.api.db.rw, ctx(), (tx) =>
    createPromotion(tx, {
      companyId: f.staff.seed.company,
      code: "PARITY10",
      nameEn: "Parity ten per cent",
      kind: "percent_off",
      definition: { itemIds: [f.staff.itemId], percent: "0.100000" },
    }),
  );
  await f.loops.pullNow();
  const at = new Date();
  const draft = draftTicket(f.db, {
    shiftId: f.shiftId,
    cashier: f.cashier,
    at,
    lines: [
      {
        itemId: f.staff.itemId,
        quantity: Quantity.of("1.000000"),
        discount: Money.of("5.0000", MYR),
      },
    ],
  });
  const line = draft.lines[0]!;
  expect(line.promotion?.promotionId).toBe(created.id);
  expect(line.promotion?.discount.toString()).toBe("1.1500");
  expect(line.discount.toString()).toBe("6.1500");
  const local = checkLimits(f.cashier, draft, {
    catalogueUnitPrices: [line.unitPrice],
    blind: false,
    voided: false,
  });
  const wire: Ticket = {
    clientRef: draft.clientRef,
    shiftId: f.shiftId,
    cashierPrincipalId: f.cashier.principalId,
    customerId: null,
    kind: "sale",
    returnsClientRef: null,
    currency: "MYR",
    soldAt: at.toISOString(),
    lines: draft.lines.map((l) => ({
      lineNo: l.lineNo,
      itemId: l.itemId,
      lotId: l.lotId,
      quantity: l.quantity.toString(),
      unitId: l.unitId,
      unitPrice: l.unitPrice.toJSON(),
      discount: l.discount.toJSON(),
      taxCodeId: l.taxCodeId,
      taxAmount: l.taxAmount.toJSON(),
      total: l.total.toJSON(),
      promotion: {
        promotionId: l.promotion!.promotionId,
        discount: l.promotion!.discount.toJSON(),
      },
    })),
    tenders: [],
    events: [],
    attendance: [],
    catalogueRevision: 0n,
  };
  const server = await withTenant(f.api.db.rw, ctx(), async (tx) => {
    const scope = { companyId: f.staff.seed.company, branchId: f.staff.branchA };
    const promoted = await verifyPromotions(tx, scope, wire);
    expect(promoted.unhonoured).toEqual([]);
    return verifyTicket(tx, { ...scope, currency: "MYR" }, promoted.ticket);
  });
  const details = local
    .filter((r) => r.kind !== "price_override")
    .map((r) => r.detail)
    .toSorted();
  expect(details.length).toBeGreaterThan(0);
  expect(details.join("; ")).toContain("line 1 discount 5.0000 exceeds");
  expect(details.join("; ")).not.toContain("6.1500");
  expect(server.refusals.map((r) => r.detail).toSorted()).toEqual(details);
});

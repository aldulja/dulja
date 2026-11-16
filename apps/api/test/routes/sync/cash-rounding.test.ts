import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money, Quantity, rational, roundToIncrement } from "@dulja/domain";
import { reverseDocument, salesByCashier } from "@dulja/db";
import {
  grantCodes,
  seedBranchPosPolicy,
  seedEmployee,
  seedCashier,
  withTenant,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  syncRequest,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";
import { recordingJobs } from "../../../../../tests/invariants/support/post-inventory";
import type { Ticket } from "@dulja/sync";
let api: StartedApi, f: PosFixture, clerk: string;
const cur = currency("MYR");
beforeAll(async () => {
  api = await startApi();
  f = await posFixture(api, "ROUNDING");
  await seedBranchPosPolicy(api.db, f.s, { branchId: f.s.hq });
  const e = await seedEmployee(api.db, f.s, { employeeNumber: "ROUND-CLERK" });
  clerk = await seedCashier(api.db, f.s, {
    employeeId: e,
    branchId: f.s.hq,
    permissions: ["pos.ticket.sell", "pos.ticket.return", "pos.ticket.return_blind"],
  });
}, 240_000);
afterAll(async () => api.stop());
function rounded(
  price: string,
  kind: "sale" | "return" = "sale",
  manual = "0.0000",
  quantity = "1.000000",
) {
  const base = buildTicket(f, {
    unitPrice: price,
    quantity,
    kind,
    discount: manual,
    cashierPrincipalId: clerk,
  });
  const original = Money.of(base.lines[0]!.total.amount, cur),
    delta = roundToIncrement(original, "0.05").subtract(original);
  const wire = Money.of(base.lines[0]!.discount.amount, cur).subtract(delta);
  const ticket = buildTicket(f, {
    unitPrice: price,
    quantity,
    kind,
    discount: (kind === "return" ? wire.negate() : wire).toString(),
    cashierPrincipalId: clerk,
  });
  return Object.assign(ticket, {
    cashRounding: { lineNo: 1, adjustment: { amount: delta.toString(), currency: "MYR" } },
  });
}
async function apply(ticket: Ticket) {
  const res = await syncRequest(api, f.terminal, {
    method: "POST",
    path: "/v1/sync/tickets",
    body: {
      terminalId: f.terminal.terminalId,
      batchId: uuidv7Sync(),
      tickets: [ticket],
      shifts: [],
      tillEvents: [],
    },
  });
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      results: {
        status: string;
        documentId: string | null;
        error: { code: string; detail: string } | null;
      }[];
    }
  ).results[0]!;
}
describe("verified cash rounding evidence", () => {
  for (const price of ["50.0300", "50.0200"])
    it(`sale ${price} rounds under closed manual-discount limits without discount authority`, async () => {
      const t = rounded(price),
        r = await apply(t);
      expect(r.status, JSON.stringify(r)).toBe("accepted");
      const [row] = await api.db.admin<
        { discount: string; gross: string }[]
      >`select discount::text,total_incl_tax::text as gross from app.document_line where document_id=${r.documentId} and kind='item'`;
      expect(row).toEqual({
        discount: t.lines[0]!.discount.amount,
        gross: t.lines[0]!.total.amount,
      });
    });
  it("blind returns use signed rounding after their normal branch allowance", async () => {
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set blind_return_allowed=true,max_blind_return_amount=100 where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
    for (const price of ["50.0300", "50.0200"]) {
      const r = await apply(rounded(price, "return"));
      expect(r.status, JSON.stringify(r)).toBe("accepted");
    }
  });
  it("rounds untaxed zero-rate lines using the same evidence", async () => {
    const t = rounded("25.0300");
    t.lines[0]!.taxCodeId = f.taxCodes["SYN-OUT-ZERO"]!;
    t.lines[0]!.taxAmount.amount = "0.0000";
    const r = await apply(t);
    expect(r.status, JSON.stringify(r)).toBe("accepted");
  });
  it("an automatic surcharge cannot hide a manual discount requiring authority", async () => {
    const t = rounded("50.0300", "sale", "0.0100");
    expect(t.lines[0]!.discount.amount).toBe("0.0300");
    const hidden = rounded("50.0400", "sale", "0.0100");
    expect(hidden.lines[0]!.discount.amount).toBe("-0.0100");
    const r = await apply(hidden);
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_RBAC_FORBIDDEN");
  });
  it("cash rounding cannot lift manual discount limits even with a discount grant", async () => {
    await grantCodes(api.db, f.s, { principalId: clerk, codes: ["pos.ticket.discount"] });
    const r = await apply(rounded("50.0400", "sale", "0.0100"));
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
  });
  it("refuses forged adjustment, line identity, total and currency without a document", async () => {
    for (const mutate of [
      (t: ReturnType<typeof rounded>) => {
        t.cashRounding.adjustment.amount = "0.0100";
      },
      (t: ReturnType<typeof rounded>) => {
        t.cashRounding.lineNo = 99;
      },
      (t: ReturnType<typeof rounded>) => {
        t.lines[0]!.total.amount = "50.0600";
        t.tenders[0]!.amount.amount = "50.0600";
      },
      (t: ReturnType<typeof rounded>) => {
        t.cashRounding.adjustment.currency = "USD";
      },
    ]) {
      const t = rounded("50.0300");
      mutate(t);
      const r = await apply(t);
      expect(r.status).toBe("rejected");
      expect(r.documentId).toBeNull();
      expect(r.error?.code).toBe("ERR_VALIDATION_FAILED");
    }
  });
  it("refuses noncash, mixed and account tenders carrying evidence", async () => {
    for (const method of ["card", "mixed", "account"]) {
      const t = rounded("50.0300");
      if (method === "card") t.tenders[0]!.method = "card";
      else if (method === "mixed") {
        t.tenders[0]!.amount.amount = "25.0000";
        t.tenders.push({
          tenderNo: 2,
          method: "card",
          amount: { amount: "25.0500", currency: "MYR" },
          reference: null,
        });
      } else {
        t.tenders = [];
        t.customerId = (
          await api.db.admin<
            { id: string }[]
          >`select id from app.party where company_id=${f.s.company} and code='TAXCUST'`
        )[0]!.id;
      }
      const r = await apply(t);
      expect(r.status).toBe("rejected");
      expect(r.error?.code).toBe("ERR_VALIDATION_FAILED");
    }
  });
  it("selects greatest original gross and lowest line number on ties", async () => {
    const t = rounded("50.0300");
    t.lines.push({
      ...t.lines[0]!,
      lineNo: 2,
      discount: { amount: "0.0000", currency: "MYR" },
      total: { amount: "60.0000", currency: "MYR" },
      unitPrice: { amount: "60.0000", currency: "MYR" },
    });
    const base = buildTicket(f, { unitPrice: "60.0000" });
    t.lines[1]!.taxAmount = base.lines[0]!.taxAmount;
    t.tenders[0]!.amount.amount = "110.0500";
    const r = await apply(t);
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_VALIDATION_FAILED");
  });
  it("uses the lowest original line number for equal grosses and rejects a different tie target", async () => {
    const first = buildTicket(f, {
      unitPrice: "50.0300",
      discount: "0.0100",
      cashierPrincipalId: clerk,
    });
    const other = buildTicket(f, { unitPrice: "50.0300", cashierPrincipalId: clerk });
    first.lines[0]!.lineNo = 10;
    first.lines.push({ ...other.lines[0]!, lineNo: 20 });
    first.tenders[0]!.amount.amount = "100.0500";
    const valid = Object.assign(first, {
      cashRounding: { lineNo: 10, adjustment: { amount: "-0.0100", currency: "MYR" } },
    });
    expect((await apply(valid)).status).toBe("accepted");
    const bad = structuredClone(valid);
    bad.clientRef = uuidv7Sync();
    bad.lines[0]!.lineNo = 20;
    bad.lines[1]!.lineNo = 10;
    bad.cashRounding.lineNo = 20;
    const refused = await apply(bad);
    expect(refused.status).toBe("rejected");
    expect(refused.error?.code).toBe("ERR_VALIDATION_FAILED");
  });
  it("referenced refunds restore source rounding after branch increments change and refuse fresh evidence", async () => {
    const source = rounded("50.0300");
    expect((await apply(source)).status).toBe("accepted");
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set rounding_increment=0.10 where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
    const refund = buildTicket(f, {
      unitPrice: "50.0300",
      discount: "-0.0200",
      kind: "return",
      returnsClientRef: source.clientRef,
      cashierPrincipalId: clerk,
    });
    const forged = Object.assign(structuredClone(refund), {
      cashRounding: { lineNo: 1, adjustment: { amount: "0.0000", currency: "MYR" } },
    });
    const refused = await apply(forged);
    expect(refused.status).toBe("rejected");
    expect(refused.error?.code).toBe("ERR_VALIDATION_FAILED");
    const accepted = await apply(refund);
    expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
    const [row] = await api.db.admin<
      { gross: string; discount: string }[]
    >`select total_incl_tax::text gross,discount::text discount from app.document_line where document_id=${accepted.documentId} and kind='item'`;
    expect(row).toEqual({ gross: "-50.0500", discount: "0.0200" });
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set rounding_increment=0.05 where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
  });
  it("refuses stale branch increments rather than silently repricing", async () => {
    const t = rounded("50.0300");
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set rounding_increment=0.10 where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
    const r = await apply(t);
    expect(r.status).toBe("rejected");
    expect(r.error?.code).toBe("ERR_VALIDATION_FAILED");
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set rounding_increment=0.05 where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
  });
});

// ADR 0059, owner direction 2026-10-22: cash rounding is not a discount. The posted line discount still carries
// the adjustment — the ticket balances only that way, and the ledger is unchanged — and the line records it under
// `custom_fields.posCashRounding`, so `pos.sales_by_cashier` reports manual discounts in `discountBase` and the
// rounding in `cashRoundingBase`. **The sign convention:** `cashRoundingBase` is rounded payable − original
// gross, the till's own `cashRounding.adjustment` sign — positive when rounding raised the takings (50.03
// settled at 50.05 is +0.0200), negative when it lowered them, and a refund gives back its sale's share.
describe("pos.sales_by_cashier reports cash rounding apart from manual discounts", () => {
  beforeAll(async () => {
    await grantCodes(api.db, f.s, { codes: ["pos.report.read"] });
  });
  const cashierWith = async (employeeNumber: string, permissions: string[]) =>
    seedCashier(api.db, f.s, {
      employeeId: await seedEmployee(api.db, f.s, { employeeNumber }),
      branchId: f.s.hq,
      permissions,
    });
  const report = async (cashierPrincipalId: string) => {
    const rows = await withTenant(api.db.rw, f.s.tenant, f.s.human, (tx) =>
      salesByCashier(tx, {
        companyId: f.s.company,
        from: "2000-01-01",
        to: "2099-12-31",
        cashierPrincipalId,
        limit: 50,
      }),
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const itemLine = async (documentId: string | null) =>
    (
      await api.db.admin<{ quantity: string; discount: string; rounding: string | null }[]>`
        select quantity::text, discount::text, custom_fields->>'posCashRounding' as rounding
          from app.document_line where document_id=${documentId} and kind='item'`
    )[0];
  const discountLimits = (pct: string) =>
    withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set max_line_discount_pct=${pct}, max_ticket_discount_pct=${pct}
            where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
  /** A referenced refund by the till's rule (ADR 0056): round(full × cumulative ÷ sold) less what earlier
   *  refunds took, the completing refund taking the exact residue. */
  const refundOf = async (sale: Ticket, quantity: string, before: string, cashier: string) => {
    const [src] = await api.db.admin<{ discount: string; net: string; gross: string }[]>`
      select l.discount::text, l.amount::text as net, l.total_incl_tax::text as gross
        from app.document_line l join app.document d on d.id=l.document_id
       where d.client_ref=${sale.clientRef} and l.kind='item'`;
    const sold = Quantity.of(sale.lines[0]!.quantity);
    const upTo = (full: string, q: Quantity) =>
      q.compare(sold) === 0
        ? Money.of(full, cur)
        : Money.of(full, cur).multiply(
            rational(
              BigInt(q.toString().replace(".", "")),
              BigInt(sold.toString().replace(".", "")),
            ),
            "HALF_AWAY_FROM_ZERO",
          );
    const prior = Quantity.of(before),
      after = prior.add(Quantity.of(quantity));
    const share = (full: string) => upTo(full, after).subtract(upTo(full, prior));
    const refund = buildTicket(f, {
      kind: "return",
      quantity,
      unitPrice: sale.lines[0]!.unitPrice.amount,
      returnsClientRef: sale.clientRef,
      cashierPrincipalId: cashier,
    });
    const line = refund.lines[0]!,
      gross = share(src!.gross),
      net = share(src!.net);
    line.discount.amount = share(src!.discount).negate().toString();
    line.total.amount = gross.negate().toString();
    line.taxAmount.amount = gross.subtract(net).negate().toString();
    refund.tenders[0]!.amount.amount = line.total.amount;
    return refund;
  };

  it("a rounded sale with no manual discount reports no discount and its rounding, in both directions", async () => {
    const cashier = await cashierWith("ROUND-REPORT", ["pos.ticket.sell"]);
    const up = Object.assign(rounded("50.0300"), { cashierPrincipalId: cashier });
    expect(up.lines[0]!.discount.amount).toBe("-0.0200"); // the wire figure is all rounding
    const sold = await apply(up);
    expect(sold.status, JSON.stringify(sold)).toBe("accepted");
    // The ledger treatment is unchanged: the posted discount keeps the adjustment.
    expect(await itemLine(sold.documentId)).toEqual({
      quantity: "1.000000",
      discount: "-0.0200",
      rounding: "0.0200",
    });
    expect(await report(cashier)).toMatchObject({
      ticketCount: 1,
      returnCount: 0,
      discountBase: "0.0000",
      cashRoundingBase: "0.0200",
    });
    // The wire: `discountBase → discount`, `cashRoundingBase → cashRounding`, both in the base currency.
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${f.s.company}/reports/pos.sales_by_cashier?from=2000-01-01&to=2099-12-31&cashierPrincipalId=${cashier}&limit=50`,
      as: f.s.human,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        discount: { amount: "0.0000", currency: "MYR" },
        cashRounding: { amount: "0.0200", currency: "MYR" },
      }),
    ]);

    const down = Object.assign(rounded("50.0200"), { cashierPrincipalId: cashier });
    const lowered = await apply(down);
    expect(lowered.status, JSON.stringify(lowered)).toBe("accepted");
    expect(await itemLine(lowered.documentId)).toMatchObject({
      discount: "0.0200",
      rounding: "-0.0200",
    });
    expect(await report(cashier)).toMatchObject({
      ticketCount: 2,
      discountBase: "0.0000",
      cashRoundingBase: "0.0000", // +0.0200 rounding up, −0.0200 rounding down
    });
  });

  it("a sale with a manual discount and rounding reports exactly the manual discount", async () => {
    const cashier = await cashierWith("ROUND-DISCOUNT", ["pos.ticket.sell", "pos.ticket.discount"]);
    await discountLimits("0.100000");
    try {
      // 50.03 less a manual 1.00 is 49.03, settled at 49.05: the line discount posts 0.98.
      const t = Object.assign(rounded("50.0300", "sale", "1.0000"), {
        cashierPrincipalId: cashier,
      });
      expect(t.lines[0]!.discount.amount).toBe("0.9800");
      const r = await apply(t);
      expect(r.status, JSON.stringify(r)).toBe("accepted");
      expect(await itemLine(r.documentId)).toMatchObject({
        discount: "0.9800",
        rounding: "0.0200",
      });
      expect(await report(cashier)).toMatchObject({
        ticketCount: 1,
        discountBase: "1.0000",
        cashRoundingBase: "0.0200",
      });
    } finally {
      await discountLimits("0.000000");
    }
  });

  it("a referenced partial refund of a rounded sale gives back its rounding share, not a discount", async () => {
    const cashier = await cashierWith("ROUND-REFUND", ["pos.ticket.sell", "pos.ticket.return"]);
    // Three at 16.6770 is 50.0310, settled at 50.0500: +0.0190 of rounding, which thirds do not divide.
    const sale = Object.assign(rounded("16.6770", "sale", "0.0000", "3.000000"), {
      cashierPrincipalId: cashier,
    });
    expect(sale.cashRounding.adjustment.amount).toBe("0.0190");
    expect((await apply(sale)).status).toBe("accepted");

    const first = await refundOf(sale, "1.000000", "0.000000", cashier);
    expect(first.lines[0]!.discount.amount).toBe("0.0063"); // the sale's −0.0190 discount, a third of it
    const one = await apply(first);
    expect(one.status, JSON.stringify(one)).toBe("accepted");
    expect(await itemLine(one.documentId)).toEqual({
      quantity: "-1.000000",
      discount: "0.0063",
      rounding: "0.0063", // stored in the refund line's own direction: its payout was rounded up
    });
    expect(await report(cashier)).toMatchObject({
      ticketCount: 1,
      returnCount: 1,
      discountBase: "0.0000",
      cashRoundingBase: "0.0127", // 0.0190 − 0.0063
    });

    // The completing refund takes the exact residue, so the sale and its refunds net to nothing.
    const rest = await refundOf(sale, "2.000000", "1.000000", cashier);
    const two = await apply(rest);
    expect(two.status, JSON.stringify(two)).toBe("accepted");
    expect(await itemLine(two.documentId)).toMatchObject({
      discount: "0.0127",
      rounding: "0.0127",
    });
    expect(await report(cashier)).toMatchObject({
      ticketCount: 1,
      returnCount: 2,
      discountBase: "0.0000",
      cashRoundingBase: "0.0000",
    });
  });

  it("a blind return's rounding lowers the takings and is not a discount", async () => {
    const cashier = await cashierWith("ROUND-BLIND", [
      "pos.ticket.return",
      "pos.ticket.return_blind",
    ]);
    await withTenant(
      api.db.migrator,
      f.s.tenant,
      f.s.system,
      (tx) =>
        tx`update app.branch_pos_policy set blind_return_allowed=true, max_blind_return_amount=100
            where company_id=${f.s.company} and branch_id=${f.s.hq}`,
    );
    // −50.03 refunded at −50.05: the adjustment is −0.0200, stored +0.0200 in the refund line's direction.
    const r = await apply(
      Object.assign(rounded("50.0300", "return"), { cashierPrincipalId: cashier }),
    );
    expect(r.status, JSON.stringify(r)).toBe("accepted");
    expect(await itemLine(r.documentId)).toEqual({
      quantity: "-1.000000",
      discount: "0.0200",
      rounding: "0.0200",
    });
    expect(await report(cashier)).toMatchObject({
      returnCount: 1,
      discountBase: "0.0000",
      cashRoundingBase: "-0.0200",
    });
  });

  it("a reversed rounded sale unwinds its rounding with its discount", async () => {
    const cashier = await cashierWith("ROUND-REVERSE", ["pos.ticket.sell"]);
    const sold = await apply(Object.assign(rounded("50.0300"), { cashierPrincipalId: cashier }));
    expect(sold.status, JSON.stringify(sold)).toBe("accepted");
    const [doc] = await api.db.admin<
      { d: string }[]
    >`select effective_date::text as d from app.document where id=${sold.documentId}`;
    const ctx = { tenantId: f.s.tenant, actorId: f.terminal.principalId, requestId: "reverse" };
    const { reversalDocumentId } = await withTenant(api.db.rw, ctx.tenantId, ctx.actorId, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: sold.documentId!,
        effectiveDate: doc!.d,
        reason: "rung up twice",
        jobs: recordingJobs(),
      }),
    );
    // The mirror copies `custom_fields` and negates quantity and discount; the record's direction unwinds it.
    expect(await itemLine(reversalDocumentId)).toEqual({
      quantity: "-1.000000",
      discount: "0.0200",
      rounding: "0.0200",
    });
    expect(await report(cashier)).toMatchObject({
      ticketCount: 1,
      returnCount: 1,
      discountBase: "0.0000",
      cashRoundingBase: "0.0000",
    });
  });
});

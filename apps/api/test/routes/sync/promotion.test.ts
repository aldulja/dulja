import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money, Quantity, rational, roundToIncrement } from "@dulja/domain";
import { createPromotion, reverseDocument, salesByCashier, verifyPromotions } from "@dulja/db";
import {
  grantCodes,
  seedBranch,
  seedBranchPosPolicy,
  seedCashier,
  seedEmployee,
  withTenant,
} from "@dulja/db/test";
import type { Ticket } from "@dulja/sync";
import { startApi, type StartedApi } from "../../support/app";
import {
  buildTicket,
  posFixture,
  syncRequest,
  uuidv7Sync,
  type PosFixture,
} from "../../../../../tests/invariants/support/pos";
import { recordingJobs } from "../../../../../tests/invariants/support/post-inventory";

// 6B Task 6 with Task 5's promotions, on the server's side (ADR 0059's PR 12 review amendment): a promotion is
// the shop's decision, so its share of a line's discount needs no `pos.ticket.discount` and counts against no
// branch limit — once the server has recomputed it from its own `app.promotion` row. Evidence it cannot prove
// keeps the ordinary checks, and the refusal says why; malformed evidence is refused outright. The branch here
// keeps the migration's default policy: every manual-discount limit is zero.
let api: StartedApi, f: PosFixture, clerk: string, discounter: string;
const promo: Record<string, string> = {};
const cur = currency("MYR");

beforeAll(async () => {
  api = await startApi();
  f = await posFixture(api, "PROMOTION");
  await seedBranchPosPolicy(api.db, f.s, {
    branchId: f.s.hq,
    limits: { blindReturnAllowed: true, maxBlindReturnAmount: "100.0000" },
  });
  const cashierWith = async (employeeNumber: string, permissions: string[]) =>
    seedCashier(api.db, f.s, {
      employeeId: await seedEmployee(api.db, f.s, { employeeNumber }),
      branchId: f.s.hq,
      permissions,
    });
  clerk = await cashierWith("PROMO-CLERK", [
    "pos.ticket.sell",
    "pos.ticket.return",
    "pos.ticket.return_blind",
  ]);
  discounter = await cashierWith("PROMO-DISC", ["pos.ticket.sell", "pos.ticket.discount"]);
  const otherBranch = await seedBranch(api.db, f.s, { code: "PROMO-BR2" });
  const skuA = f.items["SKU-A"]!.itemId,
    skuB = f.items["SKU-B"]!.itemId;
  const create = (
    code: string,
    kind: "percent_off" | "amount_off",
    definition: Record<string, unknown>,
    extra: { startsAt?: string; endsAt?: string; branchId?: string } = {},
  ) =>
    withTenant(api.db.rw, f.s.tenant, f.s.human, (tx) =>
      createPromotion(tx, {
        companyId: f.s.company,
        code,
        nameEn: code,
        kind,
        definition,
        ...extra,
      }),
    );
  // A JSON number in the definition, as an operator's client may send one: the server reads it in the
  // catalogue stream's normal form (its exact decimal text), as the till does.
  promo["TEN"] = (await create("TEN", "percent_off", { itemIds: [skuA], percent: 0.1 })).id;
  promo["EXPIRED"] = (
    await create(
      "EXPIRED",
      "percent_off",
      { itemIds: [skuA], percent: "0.100000" },
      { startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-12-31T23:59:59Z" },
    )
  ).id;
  promo["ELSEWHERE"] = (
    await create(
      "ELSEWHERE",
      "percent_off",
      { itemIds: [skuA], percent: "0.100000" },
      { branchId: otherBranch },
    )
  ).id;
  promo["THREESEN"] = (
    await create("THREESEN", "amount_off", {
      itemIds: [skuB],
      amountPerUnit: "0.0300",
      currency: "MYR",
    })
  ).id;
}, 240_000);
afterAll(async () => api.stop());

/** A line at 50.0000 whose discount is the promotion's 5.0000 plus `manual`, with the evidence. */
function promoted(
  opts: { kind?: "sale" | "return"; manual?: string; cashier?: string; promotionId?: string } = {},
): Ticket {
  const kind = opts.kind ?? "sale";
  const share = Money.of("5.0000", cur);
  const t = buildTicket(f, {
    unitPrice: "50.0000",
    kind,
    discount: share.add(Money.of(opts.manual ?? "0.0000", cur)).toString(),
    cashierPrincipalId: opts.cashier ?? clerk,
  });
  t.lines[0]!.promotion = {
    promotionId: opts.promotionId ?? promo["TEN"]!,
    discount: (kind === "return" ? share.negate() : share).toJSON(),
  };
  return t;
}

async function send(ticket: Ticket) {
  return syncRequest(api, f.terminal, {
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
}
async function apply(ticket: Ticket) {
  const res = await send(ticket);
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

describe("verified promotion evidence", () => {
  it("a promoted sale from a cashier without pos.ticket.discount applies at zero manual-discount limits", async () => {
    const t = promoted();
    const r = await apply(t);
    expect(r.status, JSON.stringify(r)).toBe("accepted");
    // The ledger is unchanged: the posted line keeps the whole discount the ticket carried.
    const [row] = await api.db.admin<
      { discount: string; gross: string }[]
    >`select discount::text, total_incl_tax::text as gross from app.document_line where document_id=${r.documentId} and kind='item'`;
    expect(row).toEqual({ discount: "5.0000", gross: "45.0000" });
    // The same ticket WITHOUT the evidence is an old till's: the 5.0000 is the cashier's, and is refused.
    const bare = promoted();
    delete bare.lines[0]!.promotion;
    const refused = await apply(bare);
    expect(refused.status).toBe("rejected");
    expect(refused.error?.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a promoted blind return applies, its evidence signed like the line", async () => {
    const r = await apply(promoted({ kind: "return" }));
    expect(r.status, JSON.stringify(r)).toBe("accepted");
  });

  it("the cashier's own part of the discount still needs the code and the limit", async () => {
    const noCode = await apply(promoted({ manual: "1.0000" }));
    expect(noCode.status).toBe("rejected");
    expect(noCode.error?.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(noCode.error?.detail).toContain("pos.ticket.discount");
    const overLimit = await apply(promoted({ manual: "1.0000", cashier: discounter }));
    expect(overLimit.status).toBe("rejected");
    expect(overLimit.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    // The figure is the manual 1.0000, never the 6.0000 the line carries in all.
    expect(overLimit.error?.detail).toContain(
      "line 1 discount 1.0000 exceeds 0.000000 of 50.0000 (0.0000)",
    );
    expect(overLimit.error?.detail).not.toContain("6.0000");
    expect(overLimit.error?.detail).not.toContain("not honoured");
  });

  it("forged, expired, other-branch and wrong-amount claims keep the manual checks and are refused, saying why", async () => {
    const cases: [string, (t: Ticket) => void, string][] = [
      [
        "unknown",
        (t) => (t.lines[0]!.promotion!.promotionId = uuidv7Sync()),
        "is not a promotion of this company and branch",
      ],
      [
        "expired",
        (t) => (t.lines[0]!.promotion!.promotionId = promo["EXPIRED"]!),
        "is not active at",
      ],
      [
        "elsewhere",
        (t) => (t.lines[0]!.promotion!.promotionId = promo["ELSEWHERE"]!),
        // The terminal's branch-isolated session cannot even see another branch's promotion (Form B).
        "is not a promotion of this company and branch",
      ],
      [
        "other item",
        (t) => (t.lines[0]!.promotion!.promotionId = promo["THREESEN"]!),
        "does not apply to item",
      ],
      [
        "wrong amount",
        (t) => {
          // 10 % of 50.0000 is 5.0000; claim 6.0000 of a 6.0000 discount.
          t.lines[0]!.promotion!.discount.amount = "6.0000";
        },
        "gives 5.0000 on this line, not 6.0000",
      ],
    ];
    for (const [name, mutate, reason] of cases) {
      const t = name === "wrong amount" ? promoted({ manual: "1.0000" }) : promoted();
      mutate(t);
      const r = await apply(t);
      expect(r.status, name).toBe("rejected");
      expect(r.documentId).toBeNull();
      expect(r.error?.code, name).toBe("ERR_RBAC_FORBIDDEN");
      expect(r.error?.detail, name).toContain(
        "promotion evidence not honoured — line 1: promotion",
      );
      expect(r.error?.detail, name).toContain(reason);
      // Recoverable: the payload waits in the manager's queue, as every business refusal's does.
      const [queued] = await api.db.admin<
        { error_code: string }[]
      >`select error_code from app.needs_attention where client_ref=${t.clientRef} and resolved_at is null`;
      expect(queued?.error_code, name).toBe("ERR_RBAC_FORBIDDEN");
    }
    // A session that is not branch-restricted does see it, and the verifier still refuses it for this branch.
    const elsewhere = promoted({ promotionId: promo["ELSEWHERE"]! });
    const seen = await withTenant(api.db.rw, f.s.tenant, f.s.human, (tx) =>
      verifyPromotions(tx, { companyId: f.s.company, branchId: f.s.hq }, elsewhere),
    );
    expect(seen.unhonoured).toEqual([
      `line 1: promotion ${promo["ELSEWHERE"]!} belongs to another branch`,
    ]);
    expect(seen.ticket.lines[0]!.discount.amount).toBe("5.0000");
    // The verified claim is what takes the share out, and nothing else does.
    const honoured = await withTenant(api.db.rw, f.s.tenant, f.s.human, (tx) =>
      verifyPromotions(
        tx,
        { companyId: f.s.company, branchId: f.s.hq },
        promoted({ manual: "1.0000" }),
      ),
    );
    expect(honoured.unhonoured).toEqual([]);
    expect(honoured.ticket.lines[0]!.discount.amount).toBe("1.0000");
    // A cashier who holds the code meets the zero limit instead — the claim exempted nothing.
    const t = promoted({ cashier: discounter, promotionId: promo["EXPIRED"]! });
    const r = await apply(t);
    expect(r.error?.code).toBe("ERR_POS_LIMIT_EXCEEDED");
    expect(r.error?.detail).toContain("line 1 discount 5.0000 exceeds 0.000000 of 50.0000");
    expect(r.error?.detail).toContain("is not active at");
  });

  it("refuses malformed evidence outright, and a referenced refund that carries any", async () => {
    const malformed: ((t: Ticket) => void)[] = [
      (t) => (t.lines[0]!.promotion!.discount.currency = "USD"),
      (t) => (t.lines[0]!.promotion!.discount.amount = "-5.0000"),
      (t) => (t.lines[0]!.promotion!.discount.amount = "0.0000"),
      (t) => {
        // A promotion larger than the line's whole discount would leave a negative manual discount.
        t.lines[0]!.promotion!.discount.amount = "5.0000";
        t.lines[0]!.discount.amount = "4.0000";
        t.lines[0]!.total.amount = "46.0000";
        t.tenders[0]!.amount.amount = "46.0000";
      },
    ];
    for (const mutate of malformed) {
      const t = promoted();
      mutate(t);
      const r = await apply(t);
      expect(r.status).toBe("rejected");
      expect(r.error?.code).toBe("ERR_VALIDATION_FAILED");
    }
    // An honoured promotion never lets the line's WHOLE discount pass its gross. The manual 46.0000 alone is
    // within the 50.0000 gross that `validateShape` checks; with the promotion's 5.0000 the line would total
    // −1.0000 inside an otherwise positive sale, so the refusal names the shape, not the cashier's authority.
    const overGross = buildTicket(f, {
      lines: [
        { unitPrice: "50.0000", discount: "51.0000" },
        { sku: "SKU-B", unitPrice: "50.0000" },
      ],
      cashierPrincipalId: clerk,
    });
    overGross.lines[0]!.promotion = {
      promotionId: promo["TEN"]!,
      discount: { amount: "5.0000", currency: "MYR" },
    };
    const tooMuch = await apply(overGross);
    expect(tooMuch.status).toBe("rejected");
    expect(tooMuch.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(tooMuch.error?.detail).toContain("line 1: discount exceeds gross price");
    await expect(
      withTenant(api.db.rw, f.s.tenant, f.s.human, (tx) =>
        verifyPromotions(tx, { companyId: f.s.company, branchId: f.s.hq }, overGross),
      ),
    ).rejects.toMatchObject({ code: "ERR_VALIDATION_FAILED" });

    // The strict wire schema admits exactly the two fields.
    const extra = promoted();
    Object.assign(extra.lines[0]!.promotion!, { kind: "percent_off" });
    expect((await send(extra)).status).toBe(400);

    const sale = promoted();
    expect((await apply(sale)).status).toBe("accepted");
    const refund = buildTicket(f, {
      unitPrice: "50.0000",
      kind: "return",
      discount: "5.0000",
      returnsClientRef: sale.clientRef,
      cashierPrincipalId: clerk,
    });
    const claimed = structuredClone(refund);
    claimed.lines[0]!.promotion = {
      promotionId: promo["TEN"]!,
      discount: { amount: "-5.0000", currency: "MYR" },
    };
    const refused = await apply(claimed);
    expect(refused.status).toBe("rejected");
    expect(refused.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(refused.error?.detail).toContain("cannot carry promotion evidence");
    // Without evidence, the refund restores the sale's discount as it was, with no discount authority.
    const restored = await apply(refund);
    expect(restored.status, JSON.stringify(restored)).toBe("accepted");
  });

  it("verifies cash rounding and a promotion on the same line together", async () => {
    // 50.0000 less 0.0300 off is 49.9700, settled in cash at 49.9500: the wire discount is the promotion's
    // 0.0300 plus the rounding's 0.0200, and the evidence names each share.
    const share = Money.of("0.0300", cur);
    const original = Money.of("49.9700", cur);
    const adjustment = roundToIncrement(original, "0.05").subtract(original);
    expect(adjustment.toString()).toBe("-0.0200");
    const t = buildTicket(f, {
      sku: "SKU-B",
      unitPrice: "50.0000",
      discount: share.subtract(adjustment).toString(),
      cashierPrincipalId: clerk,
    });
    t.lines[0]!.promotion = { promotionId: promo["THREESEN"]!, discount: share.toJSON() };
    t.cashRounding = { lineNo: 1, adjustment: adjustment.toJSON() };
    expect(t.lines[0]!.total.amount).toBe("49.9500");
    const r = await apply(t);
    expect(r.status, JSON.stringify(r)).toBe("accepted");
    const [row] = await api.db.admin<
      { discount: string; rounding: string | null }[]
    >`select discount::text, custom_fields->>'posCashRounding' as rounding from app.document_line where document_id=${r.documentId} and kind='item'`;
    expect(row).toEqual({ discount: "0.0500", rounding: "-0.0200" });
  });
});

// The report half (ADR 0059's PR 12 review amendment): a verified promotion is not the cashier's discount in
// `pos.sales_by_cashier` either. The posted line keeps the whole discount — the ledger is unchanged — and records
// the verified share under `custom_fields.posPromotion` in its own direction, so `discountBase` is what the
// cashier discounted. A claim the server could not prove records nothing: its whole discount stays the cashier's.
describe("pos.sales_by_cashier leaves a verified promotion out of the cashier's discount", () => {
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
      await api.db.admin<{ quantity: string; discount: string; promotion: string | null }[]>`
        select quantity::text, discount::text, custom_fields->>'posPromotion' as promotion
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

  it("reports only the manual part of a promoted sale, and its referenced refunds give back the same split", async () => {
    const cashier = await cashierWith("PROMO-REP-REFUND", [
      "pos.ticket.sell",
      "pos.ticket.return",
      "pos.ticket.discount",
    ]);
    await discountLimits("0.100000");
    try {
      // Two at 50.0000: the promotion's 10 % is 10.0000, and the cashier adds 3.0000 of their own.
      const sale = buildTicket(f, {
        quantity: "2.000000",
        unitPrice: "50.0000",
        discount: "13.0000",
        cashierPrincipalId: cashier,
      });
      sale.lines[0]!.promotion = {
        promotionId: promo["TEN"]!,
        discount: { amount: "10.0000", currency: "MYR" },
      };
      const sold = await apply(sale);
      expect(sold.status, JSON.stringify(sold)).toBe("accepted");
      expect(await itemLine(sold.documentId)).toEqual({
        quantity: "2.000000",
        discount: "13.0000", // the ledger is unchanged
        promotion: "10.0000",
      });
      expect(await report(cashier)).toMatchObject({ ticketCount: 1, discountBase: "3.0000" });

      const first = await refundOf(sale, "1.000000", "0.000000", cashier);
      expect(first.lines[0]!.discount.amount).toBe("-6.5000");
      const one = await apply(first);
      expect(one.status, JSON.stringify(one)).toBe("accepted");
      // Stored in the refund line's own direction, like the cash rounding.
      expect(await itemLine(one.documentId)).toEqual({
        quantity: "-1.000000",
        discount: "-6.5000",
        promotion: "5.0000",
      });
      expect(await report(cashier)).toMatchObject({ returnCount: 1, discountBase: "1.5000" });

      // The completing refund takes the residue of the history, so the sale and its refunds net to nothing.
      const two = await apply(await refundOf(sale, "1.000000", "1.000000", cashier));
      expect(two.status, JSON.stringify(two)).toBe("accepted");
      expect(await itemLine(two.documentId)).toMatchObject({ promotion: "5.0000" });
      expect(await report(cashier)).toMatchObject({ returnCount: 2, discountBase: "0.0000" });
    } finally {
      await discountLimits("0.000000");
    }
  });

  it("a promoted blind return reports no discount", async () => {
    const cashier = await cashierWith("PROMO-REP-BLIND", [
      "pos.ticket.return",
      "pos.ticket.return_blind",
    ]);
    const r = await apply(promoted({ kind: "return", cashier }));
    expect(r.status, JSON.stringify(r)).toBe("accepted");
    expect(await itemLine(r.documentId)).toEqual({
      quantity: "-1.000000",
      discount: "-5.0000",
      promotion: "5.0000",
    });
    expect(await report(cashier)).toMatchObject({ returnCount: 1, discountBase: "0.0000" });
  });

  it("a claim the server could not prove stays the cashier's discount", async () => {
    const cashier = await cashierWith("PROMO-REP-UNPROVED", [
      "pos.ticket.sell",
      "pos.ticket.discount",
    ]);
    await discountLimits("0.100000");
    try {
      // An expired promotion's 4.0000 is accepted only as the cashier's own discount, within their 10 %.
      const t = buildTicket(f, {
        unitPrice: "50.0000",
        discount: "4.0000",
        cashierPrincipalId: cashier,
      });
      t.lines[0]!.promotion = {
        promotionId: promo["EXPIRED"]!,
        discount: { amount: "4.0000", currency: "MYR" },
      };
      const r = await apply(t);
      expect(r.status, JSON.stringify(r)).toBe("accepted");
      expect(await itemLine(r.documentId)).toEqual({
        quantity: "1.000000",
        discount: "4.0000",
        promotion: null,
      });
      expect(await report(cashier)).toMatchObject({ discountBase: "4.0000" });
    } finally {
      await discountLimits("0.000000");
    }
  });

  it("a reversed promoted sale unwinds its promotion with its discount", async () => {
    const cashier = await cashierWith("PROMO-REP-REVERSE", ["pos.ticket.sell"]);
    const sold = await apply(promoted({ cashier }));
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
      discount: "-5.0000",
      promotion: "5.0000",
    });
    expect(await report(cashier)).toMatchObject({ discountBase: "0.0000" });
  });
});

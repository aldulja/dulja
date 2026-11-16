// packages/db/test/tax/pos-return-tax.test.ts
//
// PR 12 review finding 13: a referenced POS refund's tax is written by `computeDocumentTax`'s historical
// branch and validated against the wire by `prepareReturns`, and the two must derive ONE share by ONE rule
// (ADR 0056: rounded cumulative budgets of the ENTERED quantity, the completing refund taking the residue) —
// and the historical branch must refuse a refund line that is not its linked sale line.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money, rational, type RoundingMode } from "@dulja/domain";
import { withTenant as prodWithTenant } from "../../src";
import { chartOfAccountsLoader } from "../../src/seed";
import { linkFulfilment } from "../../src/documents/link";
import { applyBatch, type TicketInput } from "../../src/sync/apply";
import { SENTINEL_LOT_CODE } from "../../src/inventory/lots";
import { computeDocumentTax } from "../../src/tax/compute";
import { PACK_ROOT } from "../ar-ap/_support";
import { startDb, uuidv7, type Db } from "../harness";
import {
  grantCodes,
  seedBranchPosPolicy,
  seedCashier,
  seedDocumentType,
  seedEmployee,
  seedItem,
  seedShift,
  seedTerminal,
  seedUnit,
  seedWarehouse,
} from "../fixtures";
import {
  ensureOpenPeriods,
  postInventoryDocument,
  recordingJobs,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { taxFixture, type TaxFixture } from "../../../../tests/invariants/support/tax";

const MYR = currency("MYR");
const STD = "SYN-OUT-STD";

let db: Db;
let f: TaxFixture;
let terminal: { terminalId: string; principalId: string };
let shiftId: string;
let warehouseId: string;
let baseUnitId: string;
let thirdUnitId: string;
let halfUnitId: string;
let pairUnitId: string;
const items: Record<string, string> = {};
/** `(1 + rate)` computed by Postgres and the code's own mode: no rate literal in a fixture (hazard 1). */
let inclusive: { divisor: string; roundingMode: RoundingMode };

const terminalCtx = () => ({
  tenantId: f.s.tenant,
  actorId: terminal.principalId,
  requestId: "pos-return-tax",
});

beforeAll(async () => {
  db = await startDb();
  f = await taxFixture(db, "pos-return-tax");
  const s = f.s;
  // A ticket is sold "now"; open the run's year (a day either side covers the +08:00 offset at New Year).
  const day = 86_400_000;
  for (const ms of [-day, 0, day])
    await ensureOpenPeriods(db, s, new Date(Date.now() + ms).getUTCFullYear());
  // POS_TICKET's tender rules resolve `1110`/`1120`/`2200` by code, from the pack's own chart.
  await prodWithTenant(
    db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: "pos-chart" },
    (tx) =>
      chartOfAccountsLoader.load(tx, {
        config: { tenantId: s.tenant } as never,
        tenantId: s.tenant,
        companyId: s.company,
        systemPrincipalId: s.system,
        packRoot: PACK_ROOT,
      }),
  );
  warehouseId = await seedWarehouse(db, s, { code: "WH-POS" });
  baseUnitId = await seedUnit(db, s, { code: "EA" });
  for (const sku of ["SKU-A", "SKU-B", "SKU-T"]) {
    items[sku] = (
      await seedItem(db, s, {
        code: sku,
        trackLots: false,
        baseUnitId,
        accounts: {
          revenueAccountId: f.accounts["4000"]!,
          inventoryAccountId: f.accounts["1300"]!,
          cogsAccountId: f.accounts["5000"]!,
        },
      })
    ).itemId;
  }
  // One THIRD is a third of a base unit: seven of them are 2.333333 base units, a NONINTEGRAL base quantity.
  // A HALF of SKU-T lets four refunds share two base units; a PAIR of SKU-A is a unit the sale did not use.
  thirdUnitId = await seedUnit(db, s, { code: "THIRD" });
  halfUnitId = await seedUnit(db, s, { code: "HALF" });
  pairUnitId = await seedUnit(db, s, { code: "PAIR" });
  for (const [sku, unitId, numerator, denominator] of [
    ["SKU-B", thirdUnitId, 1, 3],
    ["SKU-T", halfUnitId, 1, 2],
    ["SKU-A", pairUnitId, 2, 1],
  ] as const)
    await prodWithTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: `conversion-${sku}` },
      (tx) =>
        tx`insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
         values (${s.tenant}, ${items[sku]!}, ${unitId}, ${numerator}, ${denominator})`,
    );
  const envelope = JSON.parse(
    readFileSync(join(PACK_ROOT, "document-types", "POS_TICKET.json"), "utf8"),
  ) as { policy: Record<string, unknown> };
  await seedDocumentType(db, s, { code: "POS_TICKET", module: "pos", policy: envelope.policy });
  const receiptType = await seedDocumentType(db, s, {
    code: "STOCK_RECEIPT_TEST",
    module: "inventory",
    policy: STOCK_RECEIPT_COST_POLICY,
  });
  await postInventoryDocument(db, s, {
    documentTypeId: receiptType,
    warehouseId,
    jobs: recordingJobs(),
    lines: [
      ...["SKU-A", "SKU-B"].map((sku) => ({
        itemId: items[sku]!,
        warehouseId,
        unitId: baseUnitId,
        quantity: "200.000000",
        unitPrice: "30.0000",
      })),
      // Two base units worth 0.0002 in all: a sale of both carries a cost of two ten-thousandths.
      {
        itemId: items["SKU-T"]!,
        warehouseId,
        unitId: baseUnitId,
        quantity: "2.000000",
        unitPrice: "0.0001",
      },
    ],
  });
  await grantCodes(db, s, {
    principalId: s.human,
    roleCode: "pos-cashier",
    branchIds: [s.hq],
    codes: ["pos.ticket.sell", "pos.ticket.discount", "pos.ticket.return"],
  });
  await seedCashier(db, s, {
    employeeId: await seedEmployee(db, s, { employeeNumber: "RETURN-TAX" }),
    branchId: s.hq,
    principalId: s.human,
  });
  // The one sale below that carries a discount needs a branch limit that admits it.
  await seedBranchPosPolicy(db, s, {
    branchId: s.hq,
    limits: { maxLineDiscountPct: "1.000000", maxTicketDiscountPct: "1.000000" },
  });
  terminal = await seedTerminal(db, s, { code: "KL01" });
  shiftId = await seedShift(db, s, {
    terminalId: terminal.terminalId,
    cashierPrincipalId: s.human,
  });
  const [rate] = await db.admin<{ divisor: string; rounding_mode: RoundingMode }[]>`
    select (1 + rate)::text as divisor, rounding_mode from app.tax_code where id = ${f.codes[STD]!}`;
  inclusive = { divisor: rate!.divisor, roundingMode: rate!.rounding_mode };
}, 240_000);

afterAll(async () => {
  await db.stop();
});

async function apply(input: TicketInput) {
  const ctx = terminalCtx();
  const out = await prodWithTenant(db.rw, ctx, async (tx) =>
    applyBatch(
      tx,
      ctx,
      {
        terminalId: terminal.terminalId,
        companyId: f.s.company,
        branchId: f.s.hq,
        principalId: terminal.principalId,
        jobs: recordingJobs(),
      },
      {
        terminalId: terminal.terminalId,
        batchId: await uuidv7(db.admin),
        tickets: [input],
        shifts: [],
        tillEvents: [],
      },
    ),
  );
  return out.results[0]!;
}

async function accepted(input: TicketInput): Promise<string> {
  const out = await apply(input);
  expect(out.status, JSON.stringify(out)).toBe("accepted");
  return out.documentId!;
}

interface LineFigures {
  itemId: string;
  unitId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  total: string;
  taxAmount: string;
}

const amount = (value: string) => ({ amount: value, currency: "MYR" });

async function ticket(
  kind: "sale" | "return",
  line: LineFigures,
  returnsClientRef: string | null = null,
): Promise<TicketInput> {
  return {
    clientRef: await uuidv7(db.admin),
    shiftId,
    cashierPrincipalId: f.s.human,
    customerId: null,
    newCustomer: null,
    kind,
    returnsClientRef,
    currency: "MYR",
    soldAt: new Date().toISOString(),
    lines: [
      {
        lineNo: 1,
        itemId: line.itemId,
        lotId: null,
        quantity: line.quantity,
        unitId: line.unitId,
        unitPrice: amount(line.unitPrice),
        discount: amount(line.discount),
        taxCodeId: f.codes[STD]!,
        taxAmount: amount(line.taxAmount),
        total: amount(line.total),
      },
    ],
    tenders: [{ tenderNo: 1, method: "cash", amount: amount(line.total), reference: null }],
    events: [],
    attendance: [],
    catalogueRevision: 0n,
  };
}

/** A sale line priced the way the till prices one: gross = price × quantity − discount, inclusive tax. */
async function sale(line: Omit<LineFigures, "total" | "taxAmount">) {
  const gross = Money.of(line.unitPrice, MYR)
    .multiply(line.quantity, "HALF_AWAY_FROM_ZERO")
    .subtract(Money.of(line.discount, MYR));
  const base = gross.divide(inclusive.divisor, inclusive.roundingMode);
  const t = await ticket("sale", {
    ...line,
    total: gross.toString(),
    taxAmount: gross.subtract(base).toString(),
  });
  const documentId = await accepted(t);
  const [source] = await db.admin<{ id: string; net: string; gross: string; discount: string }[]>`
    select id, amount::text as net, total_incl_tax::text as gross, discount::text as discount
      from app.document_line where document_id = ${documentId} and kind = 'item'`;
  return { clientRef: t.clientRef, documentId, line: source! };
}

/** The refund line the till sends: ADR 0056's cumulative budgets, priced independently of the server. */
function refundFigures(
  source: { net: string; gross: string; discount: string },
  done: { net: Money<typeof MYR>; gross: Money<typeof MYR>; discount: Money<typeof MYR> },
  cumulative: bigint,
  whole: bigint,
) {
  const ratio = rational(cumulative, whole);
  const share = (full: string, previous: Money<typeof MYR>) =>
    (cumulative === whole
      ? Money.of(full, MYR)
      : Money.of(full, MYR).multiply(ratio, "HALF_AWAY_FROM_ZERO")
    ).subtract(previous);
  const gross = share(source.gross, done.gross);
  const net = share(source.net, done.net);
  const discount = share(source.discount, done.discount);
  return { gross, net, discount };
}

async function refundLine(documentId: string) {
  const [row] = await db.admin<
    {
      quantity: string;
      unit_quantity: string;
      amount: string;
      tax_amount: string;
      total_incl_tax: string;
      link_quantity: string;
    }[]
  >`
    select l.quantity::text, l.unit_quantity::text, l.amount::text, l.tax_amount::text,
           l.total_incl_tax::text, k.quantity::text as link_quantity
      from app.document_line l join app.document_link k on k.target_line_id = l.id
     where l.document_id = ${documentId} and l.kind = 'item'`;
  return row!;
}

describe("referenced POS refunds share one entered-quantity rule (PR 12 finding 13)", () => {
  it("a one-third partial refund of seven nonintegral units refunds 1000.0000 and the rest completes exactly", async () => {
    const source = await sale({
      itemId: items["SKU-B"]!,
      unitId: thirdUnitId,
      quantity: "7.000000",
      unitPrice: "1000.0000",
      discount: "0.0000",
    });
    expect(source.line.gross).toBe("7000.0000");
    const zero = Money.zero(MYR);
    const first = refundFigures(source.line, { net: zero, gross: zero, discount: zero }, 1n, 7n);
    expect(first.gross.toString()).toBe("1000.0000");
    const one = await accepted(
      await ticket(
        "return",
        {
          itemId: items["SKU-B"]!,
          unitId: thirdUnitId,
          quantity: "-1.000000",
          unitPrice: "1000.0000",
          discount: first.discount.negate().toString(),
          total: first.gross.negate().toString(),
          taxAmount: first.gross.subtract(first.net).negate().toString(),
        },
        source.clientRef,
      ),
    );
    // A BASE ratio (0.333333 ÷ 2.333333) would have rewritten this line to 999.9991 and refused the refund.
    expect(await refundLine(one)).toEqual({
      quantity: "-0.333333",
      unit_quantity: "-1.000000",
      amount: first.net.negate().toString(),
      tax_amount: first.gross.subtract(first.net).negate().toString(),
      total_incl_tax: "-1000.0000",
      link_quantity: "0.333333",
    });

    const rest = refundFigures(source.line, first, 7n, 7n);
    const six = await accepted(
      await ticket(
        "return",
        {
          itemId: items["SKU-B"]!,
          unitId: thirdUnitId,
          quantity: "-6.000000",
          unitPrice: "1000.0000",
          discount: rest.discount.negate().toString(),
          total: rest.gross.negate().toString(),
          taxAmount: rest.gross.subtract(rest.net).negate().toString(),
        },
        source.clientRef,
      ),
    );
    const completing = await refundLine(six);
    expect(completing.total_incl_tax).toBe("-6000.0000");
    expect(completing.link_quantity).toBe("2.000000");
    // Conserved: the two refunds return the sale's net and gross to the ten-thousandth.
    expect(Money.of(completing.amount, MYR).add(first.net.negate()).negate().toString()).toBe(
      source.line.net,
    );
  });

  it("a second partial refund takes the cumulative budget less the first, as the till prices it", async () => {
    // 2.9999 over three units: per-refund thirds would be 1.0000, 1.0000, 0.9999; cumulative budgets are
    // round(2.9999 × 1/3) = 1.0000, round(2.9999 × 2/3) − 1.0000 = 0.9999, and the residue 1.0000.
    const source = await sale({
      itemId: items["SKU-A"]!,
      unitId: baseUnitId,
      quantity: "3.000000",
      unitPrice: "1.0000",
      discount: "0.0001",
    });
    let done = { net: Money.zero(MYR), gross: Money.zero(MYR), discount: Money.zero(MYR) };
    const grosses: string[] = [];
    for (const cumulative of [1n, 2n, 3n]) {
      const share = refundFigures(source.line, done, cumulative, 3n);
      await accepted(
        await ticket(
          "return",
          {
            itemId: items["SKU-A"]!,
            unitId: baseUnitId,
            quantity: "-1.000000",
            unitPrice: "1.0000",
            discount: share.discount.negate().toString(),
            total: share.gross.negate().toString(),
            taxAmount: share.gross.subtract(share.net).negate().toString(),
          },
          source.clientRef,
        ),
      );
      grosses.push(share.gross.toString());
      done = {
        net: done.net.add(share.net),
        gross: done.gross.add(share.gross),
        discount: done.discount.add(share.discount),
      };
    }
    expect(grosses).toEqual(["1.0000", "0.9999", "1.0000"]);
    expect(done.gross.toString()).toBe(source.line.gross);
    expect(done.net.toString()).toBe(source.line.net);
  });

  it("a tiny cost and discount refunded in quarters follow the cumulative budgets, never exhausted early", async () => {
    // Plan Contracts' 6A return hardening, "Prove tiny-cost exhaustion": two base units worth 0.0002 sold as
    // four HALVES with a 0.0002 discount. Rounding each quarter alone takes round(0.00005) = 0.0001 three
    // times and leaves −0.0001 for the last refund; the cumulative budgets round(0.0002 × k/4) take 0.0001,
    // 0.0000, 0.0001 and the 0.0000 residue — every share nonnegative, and the four sum to the sale's.
    const source = await sale({
      itemId: items["SKU-T"]!,
      unitId: halfUnitId,
      quantity: "4.000000",
      unitPrice: "1.0000",
      discount: "0.0002",
    });
    const [sold] = await db.admin<{ cost: string }[]>`
      select cost::text from app.document_line where id = ${source.line.id}`;
    expect(sold!.cost).toBe("0.0002");
    let done = { net: Money.zero(MYR), gross: Money.zero(MYR), discount: Money.zero(MYR) };
    const refunds: { cost: string; discount: string }[] = [];
    for (const cumulative of [1n, 2n, 3n, 4n]) {
      const share = refundFigures(source.line, done, cumulative, 4n);
      const refund = await accepted(
        await ticket(
          "return",
          {
            itemId: items["SKU-T"]!,
            unitId: halfUnitId,
            quantity: "-1.000000",
            unitPrice: "1.0000",
            discount: share.discount.negate().toString(),
            total: share.gross.negate().toString(),
            taxAmount: share.gross.subtract(share.net).negate().toString(),
          },
          source.clientRef,
        ),
      );
      const [line] = await db.admin<{ cost: string; discount: string }[]>`
        select cost::text, discount::text from app.document_line
         where document_id = ${refund} and kind = 'item'`;
      refunds.push(line!);
      done = {
        net: done.net.add(share.net),
        gross: done.gross.add(share.gross),
        discount: done.discount.add(share.discount),
      };
    }
    expect(refunds).toEqual([
      { cost: "0.0001", discount: "-0.0001" },
      { cost: "0.0000", discount: "0.0000" },
      { cost: "0.0001", discount: "-0.0001" },
      { cost: "0.0000", discount: "0.0000" },
    ]);
    expect(done.gross.toString()).toBe(source.line.gross);
  });

  it("a nonintegral residue is refused before drafting, naming both quantities, and another split completes", async () => {
    // ADR 0056 refuses an ambiguous nonintegral residue. Seven thirds (2.333333 base) returned as 2 then 5:
    // two thirds link round(2.333333 × 2/7) = 0.666667, so the completing link would be 1.666666 where five
    // thirds convert to 1.666667 — refused, and returning the remainder whole is not the way out. 1 then 4
    // links 0.333333 and 1.333333, which the trigger's conversions match.
    const source = await sale({
      itemId: items["SKU-B"]!,
      unitId: thirdUnitId,
      quantity: "7.000000",
      unitPrice: "1000.0000",
      discount: "0.0000",
    });
    let done = { net: Money.zero(MYR), gross: Money.zero(MYR), discount: Money.zero(MYR) };
    const refund = async (cumulative: bigint, quantity: string) => {
      const share = refundFigures(source.line, done, cumulative, 7n);
      const input = await ticket(
        "return",
        {
          itemId: items["SKU-B"]!,
          unitId: thirdUnitId,
          quantity,
          unitPrice: "1000.0000",
          discount: share.discount.negate().toString(),
          total: share.gross.negate().toString(),
          taxAmount: share.gross.subtract(share.net).negate().toString(),
        },
        source.clientRef,
      );
      return { input, share };
    };
    const take = async (cumulative: bigint, quantity: string) => {
      const { input, share } = await refund(cumulative, quantity);
      const id = await accepted(input);
      done = {
        net: done.net.add(share.net),
        gross: done.gross.add(share.gross),
        discount: done.discount.add(share.discount),
      };
      return (await refundLine(id)).link_quantity;
    };
    expect(await take(2n, "-2.000000")).toBe("0.666667");
    const whole = await apply((await refund(7n, "-5.000000")).input);
    expect(whole.status).toBe("rejected");
    expect(whole.error?.code).toBe("ERR_VALIDATION_FAILED");
    expect(whole.error?.detail).toContain("ambiguous rounding");
    expect(whole.error?.detail).toContain("5.000000 of this unit is 1.666667 base units");
    expect(whole.error?.detail).toContain("proportional share is 1.666666");
    expect(whole.error?.detail).not.toContain("whole");
    expect(await take(3n, "-1.000000")).toBe("0.333333");
    expect(await take(7n, "-4.000000")).toBe("1.333333");
    expect(done.gross.toString()).toBe("7000.0000");
  });

  /** A refund draft built by hand, linked to the sale, whose line is NOT the sale's line. `applyBatch` never
   *  drafts one (`prepareReturns` matches item, lot and unit and checks the code), so the historical tax
   *  branch is called directly: it is exported, and it must not write a sale's shares onto another line. */
  interface LineChange {
    sku?: "SKU-B";
    code?: "SYN-OUT-ZERO";
    /** One PAIR is two base units: half a PAIR is the one base unit the link claims, in another unit. */
    pair?: true;
    /** SKU-A's `NONE` sentinel, where the sale line carries no lot. */
    lot?: true;
  }
  async function draftRefund(change: LineChange) {
    const source = await sale({
      itemId: items["SKU-A"]!,
      unitId: baseUnitId,
      quantity: "2.000000",
      unitPrice: "50.0000",
      discount: "0.0000",
    });
    const ctx = terminalCtx();
    const clientRef = await uuidv7(db.admin);
    return prodWithTenant(db.rw, ctx, async (tx) => {
      const [doc] = await tx<{ id: string; effective_date: string }[]>`
        insert into app.document (tenant_id, company_id, branch_id, document_type_id, status, series,
                                  effective_date, currency, exchange_rate, client_ref, terminal_id, shift_id,
                                  attributed_to, warehouse_id, tax_inclusive)
        select ${f.s.tenant}, ${f.s.company}, ${f.s.hq}, dt.id, 'draft', 'POS', d.effective_date, 'MYR', 1,
               ${clientRef}, ${terminal.terminalId}, ${shiftId}, ${f.s.human}, ${warehouseId}, true
          from app.document_type dt, app.document d
         where dt.company_id = ${f.s.company} and dt.code = 'POS_TICKET' and d.id = ${source.documentId}
        returning id, effective_date::text`;
      const itemId = items[change.sku ?? "SKU-A"]!;
      const [line] = await tx<{ id: string }[]>`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, item_id, lot_id,
                                       quantity, unit_quantity, unit_id, unit_price, discount, amount,
                                       tax_code_id, tax_amount, total_incl_tax, custom_fields)
        values (${f.s.tenant}, ${f.s.company}, ${doc!.id}, 1, 'item', ${itemId},
                ${change.lot ? tx`(select id from app.lot where item_id = ${itemId} and code = ${SENTINEL_LOT_CODE})` : null},
                null, ${change.pair ? "-0.500000" : "-1.000000"}, ${change.pair ? pairUnitId : baseUnitId},
                '50.0000', '0.0000', '-50.0000', ${f.codes[change.code ?? STD]!},
                '0.0000', '-50.0000', ${tx.json({ posReturnSource: source.documentId })})
        returning id`;
      await linkFulfilment(tx, ctx, {
        sourceDocumentId: source.documentId,
        targetDocumentId: doc!.id,
        linkKind: "returns",
        priceFromSource: false,
        lines: [{ sourceLineId: source.line.id, targetLineId: line!.id, quantity: "1.000000" }],
      });
      return computeDocumentTax(tx, ctx, doc!.id, { historicalSourceId: source.documentId });
    });
  }

  it("the same hand-drafted refund line, unchanged, takes half the sale's figures", async () => {
    const [line] = await draftRefund({});
    expect(line!.totalInclTax).toBe("-50.0000");
  });

  it.each([
    ["tax code", { code: "SYN-OUT-ZERO" }],
    ["item", { sku: "SKU-B" }],
    ["unit", { pair: true }],
    ["lot", { lot: true }],
  ] as const)(
    "a refund line whose %s differs from its linked sale line is refused",
    async (_, change) => {
      await expect(draftRefund(change)).rejects.toMatchObject({
        code: "ERR_VALIDATION_FAILED",
        detail: expect.stringContaining("item, lot, unit and tax code"),
      });
    },
  );
});

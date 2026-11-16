import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Money, Quantity, currency } from "@dulja/domain";
import {
  ITEM_PROFITABILITY_CHECK,
  JOBS,
  NON_SALE_MOVEMENT_TYPES,
  SALE_MOVEMENT_TYPES,
  compareItemProfitability,
  convertToInvoice,
  createJobClient,
  creditNoteFrom,
  issueDocument,
  itemProfitabilityRows,
  postDocument,
  projectionChecks,
  rebuildItemProfitability,
  reverseDocument,
  salesByItem,
  type JobClient,
  type TenantContext,
} from "../../src";
import { installBoss, stopBoss } from "../boss";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedItem, seedTenantV2, seedWarehouse, type Seed } from "../fixtures";
import {
  PACK_DIR,
  arApFixture,
  postFromPack,
  type ArApFixture,
  type DocumentTypeEnvelope,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

/**
 * 4B Task 4 — `item_profitability`: the TypeScript over migration 0048's `app.item_profitability_rows`, the
 * MERGE-and-zero rebuild, its place in 1B's `projectionChecks`, the revenue half of acceptance test 7, and
 * step 14's `accounting.projection.rebuild` enqueue (contracts §4.6.1 amendments 6 and 7, §4.3.2 amendment 2).
 *
 * The fixture is the tree's two-document sales path, not the plan's single unlinked invoice. Under 4A's ADR
 * 0044 (`SALES_INVOICE.json`'s `inventory.effect` is `"none"`) an invoice NEVER carries a movement, so the
 * plan's "one invoice, one movement" fixture cannot exist: the stock leaves on a `DELIVERY_ORDER` and the
 * revenue arrives on the `SALES_INVOICE` 4A's `convertToInvoice` drafts from it, which copies the delivery's
 * cost so the invoice relieves `1250` by the figure that filled it. Both are January documents, so both halves
 * land on one `(item, fiscal_period)` row — amendment 7's "exactly how the two-document path lands both
 * halves on one row". Every document is posted through the REAL posting service.
 */
const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let invoiceId: string;

const ctxOf = async (): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});

const profitRows = () =>
  withTenant(db.rw, s.tenant, s.human, (tx) => itemProfitabilityRows(tx, { companyId: s.company }));

/** One item line on the fixture's item and warehouse; `amount` is a constant, never a float product. */
const itemLine = (quantity: string, unitPrice: string, amount: string) => ({
  kind: "item" as const,
  itemId,
  warehouseId,
  unitId: baseUnitId,
  quantity,
  unitPrice,
  amount,
});

/** A pack envelope's `policy.inventory.effect`, or undefined when the policy declares none. */
const effectOf = (e: DocumentTypeEnvelope): string | undefined =>
  (e.policy as { inventory?: { effect?: string } }).inventory?.effect;

/** A DELIVERY_ORDER of `quantity` at 25.0000 through the pack envelope (3D). */
async function deliver(effectiveDate: string, quantity: string, amount: string): Promise<string> {
  const { documentId } = await postFromPack(db, s, {
    code: "DELIVERY_ORDER",
    effectiveDate,
    partyId: f.partyIds.customer,
    warehouseId,
    lines: [itemLine(quantity, "25.0000", amount)],
  });
  return documentId;
}

/** 4A's `convertToInvoice` over a posted delivery (every open line, whole), issued and posted. */
async function invoiceOf(deliveryId: string, effectiveDate: string): Promise<string> {
  const ctx = await ctxOf();
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const r = await convertToInvoice(tx, ctx, {
      companyId: s.company,
      sourceDocumentId: deliveryId,
      targetDocumentTypeId: f.documentTypeIds["SALES_INVOICE"]!,
      targetSeries: "INV",
      effectiveDate,
      lines: [],
    });
    await issueDocument(tx, ctx, { documentId: r.documentId });
    await postDocument(tx, ctx, { documentId: r.documentId });
    return r.documentId;
  });
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "profit");
  f = await arApFixture(db, s);
  // `trackLots: false`: seedItem's default is a lot-tracked item, and every line below would then need a lot.
  ({ itemId, baseUnitId } = await seedItem(db, s, {
    code: "IT-1",
    kind: "product",
    trackLots: false,
  }));
  warehouseId = await seedWarehouse(db, s, { code: "WH-1" });

  // 1. Receive 100 @ 10.00 base, so a cost layer exists (3C's GOODS_RECEIPT). `warehouseId` goes in the
  //    HEADER as well as on the line: the type declares `requires: ["party", "warehouse"]`.
  await postFromPack(db, s, {
    code: "GOODS_RECEIPT",
    effectiveDate: "2026-01-05",
    partyId: f.partyIds.vendor,
    warehouseId,
    lines: [itemLine("100.000000", "10.0000", "1000.0000")],
  });
  // 2. Deliver 30 (the movement and its 300.0000 consumption), then invoice them at 25.00 (the revenue).
  const deliveryId = await deliver("2026-01-10", "30.000000", "750.0000");
  invoiceId = await invoiceOf(deliveryId, "2026-01-12");
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("item_profitability — the attribution (§4.6.1, amendments 6 and 7)", () => {
  it("the two-document sales path lands the delivery's quantity and cost and the invoice's revenue on ONE row", async () => {
    const rows = await profitRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId,
      fiscalPeriodId: s.period,
      quantitySold: "30.000000", // the DELIVERY_ORDER's movement — the invoice carries none (ADR 0044)
      revenueBase: "750.0000", // the SALES_INVOICE's item lines, which have a revenue ledger row
      cogsBase: "300.0000", // 30 × 10.00 from cost_consumption, never from document_line.cost
      marginBase: "450.0000",
    });
  });

  it("a PARTIAL credit note (4A's creditNoteFrom, negated magnitudes) reduces revenue and moves no stock", async () => {
    const [line] = await db.admin<{ id: string }[]>`
      select id from app.document_line where document_id = ${invoiceId} order by line_no limit 1`;
    const ctx = await ctxOf();
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const cn = await creditNoteFrom(tx, ctx, {
        companyId: s.company,
        settledDocumentId: invoiceId,
        targetDocumentTypeId: f.documentTypeIds["SALES_CREDIT_NOTE"]!,
        targetSeries: "CN",
        effectiveDate: "2026-01-20",
        reason: "five units rejected",
        lines: [{ settledLineId: line!.id, quantity: "5.000000" }],
      });
      await issueDocument(tx, ctx, { documentId: cn.documentId });
      await postDocument(tx, ctx, { documentId: cn.documentId });
    });
    const rows = await profitRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revenueBase).toBe("625.0000"); // 750 − 125
    // The note is financial-only (ADR 0044): the goods are still out, so quantity and cost do not move.
    expect(rows[0]!.quantitySold).toBe("30.000000");
    expect(rows[0]!.cogsBase).toBe("300.0000");
    expect(Money.of(rows[0]!.marginBase, MYR).isPositive()).toBe(true);
  });

  it("a REVERSAL-produced credit note reduces revenue too, though its line amounts are NEGATED (§4.4.2 A9)", async () => {
    // A second invoice: the first is partly credited, and reverseDocument refuses a partly credited document
    // (4A, d63ff51). Its delivery moves quantity and cost, so `before` is read after both have posted.
    const second = await invoiceOf(
      await deliver("2026-01-22", "10.000000", "250.0000"),
      "2026-01-23",
    );
    const before = await profitRows();
    const ctx = await ctxOf();
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: second,
        effectiveDate: "2026-01-25",
        reason: "revenue reversal, item_profitability sign case",
      }),
    );
    const after = await profitRows();
    // The invoice ('reversed') and its mirror both count, so the pair nets to zero in revenue — the ledger's
    // answer for a per-period projection, and 4A's sales_by_item rule (posted and reversed).
    expect(Money.of(after[0]!.revenueBase, MYR).toString()).toBe(
      Money.of(before[0]!.revenueBase, MYR).subtract(Money.of("250.0000", MYR)).toString(),
    );
    expect(after[0]!.quantitySold).toBe(before[0]!.quantitySold);
    expect(after[0]!.cogsBase).toBe(before[0]!.cogsBase);
  });

  it("an EXPIRY_WRITE_OFF is not a sale — neither its quantity nor its cost reaches the row", async () => {
    const before = await profitRows();
    await postFromPack(db, s, {
      code: "EXPIRY_WRITE_OFF",
      effectiveDate: "2026-01-28",
      warehouseId,
      lines: [itemLine("2.000000", "10.0000", "20.0000")],
    });
    // The write-off DID post a movement and a consumption — the row is unmoved because of membership.
    const [moved] = await db.admin<{ n: number }[]>`
      select count(*)::int as n
        from app.inventory_movement m
        join app.document d on d.id = m.document_id
        join app.document_type t on t.id = d.document_type_id
       where m.company_id = ${s.company} and t.code = 'EXPIRY_WRITE_OFF'`;
    expect(moved!.n).toBe(1);
    const after = await profitRows();
    expect(after[0]!.quantitySold).toBe(before[0]!.quantitySold);
    expect(after[0]!.cogsBase).toBe(before[0]!.cogsBase);
    expect(after[0]!.revenueBase).toBe(before[0]!.revenueBase);
  });

  // LAST in the block, because it adds a stock issue: every assertion above is written against the rows
  // the earlier cases produced.
  it("a DELIVERY_ORDER contributes quantity and cost but NEVER revenue (amendment 7)", async () => {
    const before = await profitRows();
    await deliver("2026-01-30", "10.000000", "250.0000");
    const after = await profitRows();

    // The delivery's own line carries amount 250.0000 and a unit price. If revenue were read from
    // `document_line` rather than anchored to a REVENUE LEDGER ROW, this would rise by 250 — the double-count
    // amendment 7 exists to prevent, and the defect SAH-012 is the ledger analogue of.
    expect(after[0]!.revenueBase).toBe(before[0]!.revenueBase);

    // …while quantity and cost DO move, because the movement and its cost_consumption are real.
    expect(Quantity.of(after[0]!.quantitySold).toString()).toBe(
      Quantity.of(before[0]!.quantitySold).add(Quantity.of("10.000000")).toString(),
    );
    expect(Money.of(after[0]!.cogsBase, MYR).toString()).toBe(
      Money.of(before[0]!.cogsBase, MYR).add(Money.of("100.0000", MYR)).toString(), // 10 × 10.00
    );

    // And the margin stays the difference of the two, which is the only invariant the row must hold.
    expect(Money.of(after[0]!.marginBase, MYR).toString()).toBe(
      Money.of(after[0]!.revenueBase, MYR).subtract(Money.of(after[0]!.cogsBase, MYR)).toString(),
    );
  });
});

describe("item_profitability — the two type lists (amendment 6)", () => {
  it("SALE_MOVEMENT_TYPES classifies POS sales and returns without a separate sign list", () => {
    expect([...SALE_MOVEMENT_TYPES].toSorted()).toEqual([
      "DELIVERY_ORDER",
      "POS_TICKET",
      "SALES_CREDIT_NOTE",
      "SALES_INVOICE",
    ]);
    expect(SALE_MOVEMENT_TYPES).toContain("POS_TICKET");
  });

  it("every SHIPPED type with a stock effect is classified in exactly one of the two lists", () => {
    // Read the SEED PACK off disk, not app.document_type: the DB only holds what THIS test seeded, so a
    // DB-driven check could never fail. The guard has to see every envelope the repository ships, which is
    // what makes it bind on 6A when POS_TICKET lands with a stock effect and nobody has classified it.
    const dir = join(PACK_DIR, "document-types");
    const envelopes = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as DocumentTypeEnvelope);
    const stockEffect = envelopes
      .filter((e) => effectOf(e) !== undefined && effectOf(e) !== "none")
      .map((e) => e.code);
    expect(
      stockEffect.length,
      "no shipped envelope declares a stock effect — the glob is wrong",
    ).toBeGreaterThan(0);
    const classified = new Set<string>([...SALE_MOVEMENT_TYPES, ...NON_SALE_MOVEMENT_TYPES]);
    expect(
      stockEffect.filter((code) => !classified.has(code)),
      "a SHIPPED stock-effect document type is in neither SALE_MOVEMENT_TYPES nor " +
        "NON_SALE_MOVEMENT_TYPES — the slice that added it must classify it (amendment 6)",
    ).toEqual([]);
    // NON_SALE_MOVEMENT_TYPES is exactly the shipped stock-effect types that are not sales: a financial-only
    // type listed there (PURCHASE_INVOICE, ADR 0044) would say something false about its movements.
    expect(
      [...NON_SALE_MOVEMENT_TYPES].toSorted(),
      "NON_SALE_MOVEMENT_TYPES must list every shipped non-sale stock-effect type and nothing else",
    ).toEqual(stockEffect.filter((code) => !SALE_MOVEMENT_TYPES.includes(code)).toSorted());
  });

  it("the two lists are disjoint", () => {
    for (const code of SALE_MOVEMENT_TYPES) expect(NON_SALE_MOVEMENT_TYPES).not.toContain(code);
  });
});

describe("item_profitability — the projection registry (test 2, ADR 0046)", () => {
  it("joins 1B's projectionChecks under its table name", () => {
    expect(ITEM_PROFITABILITY_CHECK.name).toBe("item_profitability");
    expect(ITEM_PROFITABILITY_CHECK.run).toBe(compareItemProfitability);
    expect(projectionChecks().map((c) => c.name)).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
  });

  it("before any rebuild the stored table is empty, so compare reports the fresh row missing_in_projection", async () => {
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      compareItemProfitability(tx),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      projection: "item_profitability",
      key: { company_id: s.company, item_id: itemId, fiscal_period_id: s.period },
      side: "missing_in_projection",
    });
  });

  it("rebuild then compare finds nothing; a corrupted row is reported naming the column", async () => {
    const first = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildItemProfitability(tx, { companyId: s.company }),
    );
    expect(first).toEqual({ merged: 1, zeroed: 0 });
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx)),
    ).toEqual([]);
    // The stored row IS the function's row, figure for figure (test 2: bit-identical).
    const [stored] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        { quantitySold: string; revenueBase: string; cogsBase: string; marginBase: string }[]
      >`
        select quantity_sold::text as "quantitySold", revenue_base::text as "revenueBase",
               cogs_base::text as "cogsBase", margin_base::text as "marginBase"
          from app.item_profitability where company_id = ${s.company} and item_id = ${itemId}`,
    );
    const [fresh] = await profitRows();
    expect(stored).toEqual({
      quantitySold: fresh!.quantitySold,
      revenueBase: fresh!.revenueBase,
      cogsBase: fresh!.cogsBase,
      marginBase: fresh!.marginBase,
    });

    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.item_profitability set cogs_base = cogs_base + 3 where company_id = ${s.company}`,
    );
    const mismatches = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      compareItemProfitability(tx),
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      projection: "item_profitability",
      side: "amount_differs",
    });
    expect(mismatches[0]!.detail).toContain("cogs_base");
    expect(mismatches[0]!.detail).not.toContain("revenue_base");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildItemProfitability(tx, { companyId: s.company }),
    );
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx)),
    ).toEqual([]);
  });

  it("a stale stored key is reported missing_in_rebuild, and the next rebuild ZEROES it rather than deleting it", async () => {
    // A stored figure for a key the function no longer returns — the state a key reaches when its documents
    // come to net to zero (a delivery reversed inside its own period drops out under the function's HAVING).
    // Written directly, so the case does not depend on which rebuild ran between the two posts.
    const [february] = await db.admin<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company} and starts_on = '2026-02-01'`;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.item_profitability
          (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base)
        values (${s.tenant}, ${s.company}, ${itemId}, ${february!.id}, 1, 5, 2, 3)`,
    );
    const stale = await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      key: { fiscal_period_id: february!.id },
      side: "missing_in_rebuild",
    });

    const counts = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      rebuildItemProfitability(tx, { companyId: s.company }),
    );
    expect(counts).toEqual({ merged: 1, zeroed: 1 });
    const [zeroed] = await db.admin<{ n: number; total: string }[]>`
      select count(*)::int as n,
             sum(quantity_sold + revenue_base + cogs_base + margin_base)::text as total
        from app.item_profitability where fiscal_period_id = ${february!.id}`;
    expect(zeroed).toEqual({ n: 1, total: "0.000000" }); // still there (no DELETE, §3.5.4), all zero
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => compareItemProfitability(tx)),
    ).toEqual([]);
    // Idempotent: a zeroed row is not zeroed again.
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        rebuildItemProfitability(tx, { companyId: s.company }),
      ),
    ).toEqual({ merged: 1, zeroed: 0 });
  });

  it("a second tenant sees none of these rows, through the table or the function (test 12)", async () => {
    const other = await seedTenantV2(db, "profit-other");
    const seen = await withTenant(db.rw, other.tenant, other.human, async (tx) => ({
      stored: await tx<{ n: number }[]>`select count(*)::int as n from app.item_profitability`,
      fresh: await itemProfitabilityRows(tx, { companyId: s.company }),
      compared: await compareItemProfitability(tx),
    }));
    expect(seen.stored[0]!.n).toBe(0);
    expect(seen.fresh).toEqual([]);
    expect(seen.compared).toEqual([]);
  });
});

describe("acceptance test 7 — the revenue half of one costing answer (spec:2425)", () => {
  it("TIE-OUT A: Σ revenue_base equals the item's revenue-account balance to the cent", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await itemProfitabilityRows(tx, { companyId: s.company });
      const projection = rows.reduce(
        (sum, r) => sum.add(Money.of(r.revenueBase, MYR)),
        Money.zero(MYR),
      );
      const [ledger] = await tx<{ signed: string }[]>`
        select coalesce(sum(b.base_credit) - sum(b.base_debit), 0)::numeric(19,4)::text as signed
          from app.account_balance b
          join app.item i on i.revenue_account_id = b.account_id
         where b.company_id = ${s.company} and i.id = ${itemId}`;
      expect(projection.toString()).toBe("625.0000"); // 750 − 125 + 250 − 250
      expect(projection.toString()).toBe(Money.of(ledger!.signed, MYR).toString());
    });
  });

  it("TIE-OUT B: Σ cogs_base equals 3D's salesByItem cost — the identical cost_consumption source", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await itemProfitabilityRows(tx, { companyId: s.company });
      const projection = rows.reduce(
        (sum, r) => sum.add(Money.of(r.cogsBase, MYR)),
        Money.zero(MYR),
      );
      const report = await salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
        limit: 50,
      });
      const reported = report.reduce((sum, r) => sum.add(Money.of(r.cost, MYR)), Money.zero(MYR));
      expect(projection.toString()).toBe("500.0000"); // three deliveries: 30, 10 and 10 at 10.00
      expect(projection.toString()).toBe(reported.toString());
    });
  });

  it("TIE-OUT C: margin_base is revenue_base − cogs_base on every row, never recomputed by a reader", async () => {
    for (const r of await profitRows()) {
      expect(r.marginBase).toBe(
        Money.of(r.revenueBase, MYR).subtract(Money.of(r.cogsBase, MYR)).toString(),
      );
    }
  });

  it("TIE-OUT D: revenue, quantity and margin equal 4A's sales_by_item over the year — a full reversal nets, a partial credit counts", async () => {
    // Consequence (1) of amendment 7: on 4A's documents revenue_base IS sales_by_item's revenue (posted and
    // reversed invoices and credit notes, the negated magnitudes doing the subtraction), which is what lets
    // 7B re-express that report over this projection unchanged. This fixture holds both hard cases.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = (await itemProfitabilityRows(tx, { companyId: s.company })).filter(
        (r) => r.itemId === itemId,
      );
      const [report] = await salesByItem(tx, {
        companyId: s.company,
        fromDate: "2026-01-01",
        toDate: "2026-12-31",
        itemId,
        limit: 50,
      });
      const sum = (pick: (r: (typeof rows)[number]) => string) =>
        rows.reduce((acc, r) => acc.add(Money.of(pick(r), MYR)), Money.zero(MYR)).toString();
      const quantity = rows
        .reduce((acc, r) => acc.add(Quantity.of(r.quantitySold)), Quantity.zero())
        .toString();
      expect(sum((r) => r.revenueBase)).toBe(report!.revenue);
      expect(sum((r) => r.marginBase)).toBe(report!.margin);
      expect(quantity).toBe(report!.deliveredQuantity);
    });
  });
});

describe("step 14 — postDocument enqueues accounting.projection.rebuild (amendment 2)", () => {
  it("a party document enqueues once per company, keyed by singletonKey = companyId", async () => {
    const jobs = recordingJobs();
    const { result } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-02-02",
      partyId: f.partyIds.customer,
      jobs,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "10.0000" }],
    });
    const enqueued = jobs.enqueued.filter((j) => j.name === "accounting.projection.rebuild");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.singletonKey).toBe(s.company);
    expect(enqueued[0]!.payload).toEqual({ companyId: s.company });
    expect(result.enqueuedJobIds).toEqual([`accounting.projection.rebuild:${s.company}`]);
    expect(result.warnings.filter((w) => w.includes("accounting.projection.rebuild"))).toEqual([]);
  });

  it("a party-less document with movements enqueues too — the second arm of the condition", async () => {
    const jobs = recordingJobs();
    const { result } = await postFromPack(db, s, {
      code: "EXPIRY_WRITE_OFF",
      effectiveDate: "2026-02-04",
      warehouseId,
      jobs,
      lines: [itemLine("1.000000", "10.0000", "10.0000")],
    });
    expect(result.movementIds).toHaveLength(1);
    expect(jobs.enqueued.map((j) => j.name)).toEqual(["accounting.projection.rebuild"]);
  });

  it("a JOURNAL — no party and no movement — enqueues nothing and warns nothing", async () => {
    const jobs = recordingJobs();
    const documentId = await draftDocument(db, s, { effectiveDate: "2026-02-05" });
    const ctx = await ctxOf();
    const result = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
        values (${s.tenant}, ${s.company}, ${documentId}, 1, ${s.cash}, 7, 0),
               (${s.tenant}, ${s.company}, ${documentId}, 2, ${s.sales}, 0, 7)`;
      return postDocument(tx, ctx, { documentId, jobs });
    });
    expect(jobs.enqueued).toEqual([]);
    expect(result.enqueuedJobIds).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("with the REAL JobClient a burst of posts collapses into ONE queued job per company, and every post commits", async () => {
    // accounting.projection.rebuild's queue is stately (contracts §4.2.6): while the company's job is QUEUED
    // and not started, a second request collapses into it and createJobClient resolves with its id — no
    // error, no warning — because the queued job reads the ledger when it runs. A post while the job is
    // ACTIVE queues the next one, so the lag behind the ledger is one job, never "until the nightly run".
    const boss = await installBoss(db, Object.keys(JOBS));
    try {
      const jobs = createJobClient(boss);
      const first = await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-06",
        partyId: f.partyIds.customer,
        jobs,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "12.0000" }],
      });
      const second = await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-07",
        partyId: f.partyIds.customer,
        jobs,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "13.0000" }],
      });
      const queued = await db.admin<{ singletonKey: string; data: { payload: unknown } }[]>`
        select singleton_key as "singletonKey", data from pgboss.job
         where name = 'accounting.projection.rebuild' and singleton_key = ${s.company}`;
      expect(queued).toHaveLength(1);
      expect(queued[0]!.data.payload).toEqual({ companyId: s.company });
      for (const posted of [first, second]) {
        expect(posted.result.enqueuedJobIds).toEqual([
          `accounting.projection.rebuild:${s.company}`,
        ]);
        expect(posted.result.warnings.filter((w) => w.includes("rebuild"))).toEqual([]);
      }
      const [committed] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from app.document
         where id in (${first.documentId}, ${second.documentId}) and status = 'posted'`;
      expect(committed!.n).toBe(2);

      // The worker claims the queued rebuild (`ignoreStartAfter`: step 14 defers it by 60 s). A post now must
      // NOT collapse into it — it may already have read the ledger — so a second job is queued behind it.
      const [active] = await boss.fetch("accounting.projection.rebuild", {
        ignoreStartAfter: true,
      });
      expect(active).toBeDefined();
      const third = await postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-09",
        partyId: f.partyIds.customer,
        jobs,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "15.0000" }],
      });
      expect(third.result.warnings.filter((w) => w.includes("rebuild"))).toEqual([]);
      const states = await db.admin<{ state: string; asOf: string | null }[]>`
        select state::text as state, data->'payload'->>'asOf' as "asOf" from pgboss.job
         where name = 'accounting.projection.rebuild' and singleton_key = ${s.company}
         order by created_on`;
      expect(states).toEqual([
        // No post names an asOf (code review B2): each job rebuilds the snapshot of the day it runs.
        { state: "active", asOf: null },
        { state: "created", asOf: null },
      ]);
    } finally {
      await stopBoss(boss);
    }
  });

  it("any OTHER enqueue failure still fails the post — only the collision is the collapse", async () => {
    const broken: JobClient = {
      enqueue: () => Promise.reject(new Error("the queue is unreachable")),
    };
    const [before] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where company_id = ${s.company} and status = 'posted'`;
    await expect(
      postFromPack(db, s, {
        code: "SALES_INVOICE",
        effectiveDate: "2026-02-08",
        partyId: f.partyIds.customer,
        jobs: broken,
        lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "14.0000" }],
      }),
    ).rejects.toThrow("the queue is unreachable");
    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where company_id = ${s.company} and status = 'posted'`;
    expect(after!.n).toBe(before!.n); // the posting transaction rolled back whole
  });

  it("without a JobClient it WARNS and posts — it never throws (amendment 2 is not 3B's fail-closed branch)", async () => {
    const { result } = await postFromPack(db, s, {
      code: "SALES_INVOICE",
      effectiveDate: "2026-02-03",
      partyId: f.partyIds.customer,
      lines: [{ kind: "account", accountId: f.accountIds["4000"]!, amount: "11.0000" }],
    });
    expect(result.warnings.some((w) => w.includes("accounting.projection.rebuild"))).toBe(true);
    expect(result.enqueuedJobIds).toEqual([]);
    expect(result.ledgerEntryIds).toHaveLength(2);
  });
});

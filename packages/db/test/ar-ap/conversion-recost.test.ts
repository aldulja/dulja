// packages/db/test/ar-ap/conversion-recost.test.ts — code review 2 (C5). `convertToInvoice` copied the
// delivery line's CURRENT `document_line.cost`, which a cost replay rewrites (ADR 0038 note 2). Contracts 4A
// amendment 5 requires the SALES_INVOICE to relieve 1250 by the figure the DELIVERY_ORDER DEBITED, and round
// 8 that a later recost posts its own difference through 3B's COST_ADJUSTMENT, never through the invoice. An
// invoice drafted after a recost therefore took the recost out of 1250 a second time: 1250 −15.0000 and COGS
// 80.0000 against a true 65.0000. It now copies Σ |inventory_movement.value| of the line's movement — the
// immutable figure the delivery's 1250 leg posted — so 1250 nets to zero in either order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { replay } from "../../src/costing/replay";
import { convertToInvoice } from "../../src/ar-ap/invoice";
import { postDocument } from "../../src/posting";
import { withTenant, type TenantContext } from "../../src/with-tenant";
import {
  draftTypedDocument,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "../index";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";
import { recordingJobs } from "../../../../tests/invariants/support/post-inventory";

let db: Db;
let s: Seed;
let f: ArApFixture;
let warehouseId: string;

const ctx = async (): Promise<TenantContext> => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});
const as = async <T>(fn: (tx: Sql, c: TenantContext) => Promise<T>): Promise<T> => {
  const c = await ctx();
  return withTenant(db.rw, c, (tx) => fn(tx, c));
};

/** The company's net base balance on `code`, debit-positive. */
async function net(code: string): Promise<string> {
  const [row] = await db.admin<{ v: string }[]>`
    select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19,4)::text as v
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.company_id = ${s.company} and a.code = ${code}`;
  return row!.v;
}

/** The base amount `documentId` credited to 1250. */
async function relieved(documentId: string): Promise<string> {
  const [row] = await db.admin<{ v: string }[]>`
    select coalesce(sum(e.base_credit - e.base_debit), 0)::numeric(19,4)::text as v
      from app.ledger_entry e join app.account a on a.id = e.account_id
     where e.document_id = ${documentId} and a.code = '1250'`;
  return row!.v;
}

/** Σ valid cost_consumption.value of `documentId`'s movements — the true COGS of the delivery. */
async function consumed(documentId: string): Promise<string> {
  const [row] = await db.admin<{ v: string }[]>`
    select coalesce(sum(c.value), 0)::numeric(19,4)::text as v
      from app.cost_consumption c join app.inventory_movement m on m.id = c.movement_id
     where m.document_id = ${documentId} and c.invalidated_at is null`;
  return row!.v;
}

const minus = async (after: string, before: string): Promise<string> => {
  const [row] = await db.admin<{ v: string }[]>`
    select (${after}::numeric - ${before}::numeric)::numeric(19,4)::text as v`;
  return row!.v;
};

async function scenario(code: string) {
  const { itemId, baseUnitId } = await seedItem(db, s, {
    code,
    kind: "product",
    trackLots: false,
  });
  const line = (quantity: string, unitPrice: string, amount: string) => ({
    kind: "item" as const,
    itemId,
    unitId: baseUnitId,
    warehouseId,
    quantity,
    unitPrice,
    amount,
  });
  const receive = (on: string, unitPrice: string, amount: string) =>
    postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: on,
      partyId: f.partyIds.vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [line("10.000000", unitPrice, amount)],
    });
  // Ten at 5.0000, then a delivery of all ten: the delivery debits 1250 with 50.0000.
  await receive("2026-01-02", "5.0000", "50.0000");
  const { documentId: deliveryId } = await postFromPack(db, s, {
    code: "DELIVERY_ORDER",
    effectiveDate: "2026-01-10",
    partyId: f.partyIds.customer,
    warehouseId,
    jobs: recordingJobs(),
    lines: [line("10.000000", "9.0000", "90.0000")],
  });
  const [dl] = await db.admin<{ id: string }[]>`
    select id from app.document_line where document_id = ${deliveryId} order by line_no limit 1`;
  const deliveryLineId = dl!.id;
  /** Ten more at 8.0000, back-dated before the delivery, then the replay: AVCO 6.5000, cost 65.0000. */
  const recost = async () => {
    await receive("2026-01-05", "8.0000", "80.0000");
    const c = await ctx();
    await replay(
      db.rw,
      { tenantId: s.tenant, requestId: c.requestId, payload: { companyId: s.company } },
      c,
    );
  };
  const invoice = async (quantity: string | null, on: string): Promise<string> => {
    const { documentId } = await as((tx, c) =>
      convertToInvoice(tx, c, {
        companyId: s.company,
        sourceDocumentId: deliveryId,
        targetDocumentTypeId: f.documentTypeIds.SALES_INVOICE!,
        targetSeries: "INV",
        effectiveDate: on,
        lines: quantity === null ? [] : [{ sourceLineId: deliveryLineId, quantity }],
      }),
    );
    await as((tx, c) => postDocument(tx, c, { documentId, jobs: recordingJobs() }));
    return documentId;
  };
  return { deliveryId, recost, invoice };
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "conversion-recost");
  f = await arApFixture(db, s);
  warehouseId = await seedWarehouse(db, s, { code: "CRC-WH" });
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("C5 (code review 2) — an invoice relieves 1250 by what the delivery debited, not by its recost", () => {
  it("delivery, recost, then invoice: the invoice credits 1250 with 50.0000 and 1250 nets to zero", async () => {
    const start1250 = await net("1250");
    const start5000 = await net("5000");
    const { deliveryId, recost, invoice } = await scenario("CRC-ONE");
    await recost();
    // The premise: the replay moved the delivery's current cost to 65 and its difference to 5000.
    const [cost] = await db.admin<{ v: string }[]>`
      select cost::text as v from app.document_line where document_id = ${deliveryId}`;
    expect(cost!.v).toBe("65.0000");
    expect(await consumed(deliveryId)).toBe("65.0000");

    const si = await invoice(null, "2026-01-12");
    expect(await relieved(si)).toBe("50.0000");
    expect(await minus(await net("1250"), start1250)).toBe("0.0000");
    expect(await minus(await net("5000"), start5000)).toBe(await consumed(deliveryId));
  });

  it("two partial invoices of five with the recost between them: 1250 nets to zero", async () => {
    const start1250 = await net("1250");
    const start5000 = await net("5000");
    const { deliveryId, recost, invoice } = await scenario("CRC-TWO");
    const first = await invoice("5.000000", "2026-01-11");
    expect(await relieved(first)).toBe("25.0000");
    await recost();
    const second = await invoice("5.000000", "2026-01-12");
    // The completing conversion takes the residue of the BOOKED 50.0000, not of the recost 65.0000.
    expect(await relieved(second)).toBe("25.0000");
    expect(await minus(await net("1250"), start1250)).toBe("0.0000");
    expect(await minus(await net("5000"), start5000)).toBe("65.0000");
    expect(await consumed(deliveryId)).toBe("65.0000");
  });
});

describe("code review 3, R7 — the invoice takes the booked figure the way the delivery's 1250 leg was filled", () => {
  // An OD-08-style consignment delivery: a CUSTOM outbound type whose inventory effect is `transfer`, so each
  // line carries TWO movements (the issue at the warehouse and the receipt at the consignment warehouse),
  // while its 1250 leg is filled from ONE of them — `fillTaggedLedgerLines`' single-value branch, the issue.
  // The policy schema admits it (packages/domain/src/posting/policy.ts); no seeded type is one.
  const CONSIGNMENT_POLICY = {
    version: 1,
    documentType: "CONSIGNMENT_DELIVERY_TEST",
    direction: "outbound",
    requires: ["party", "warehouse", "to_warehouse"],
    lines: [
      {
        for: "each_line",
        side: "debit",
        account: { code: "1250" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
      {
        for: "each_line",
        side: "credit",
        account: { from: "item.inventory_account" },
        amount: "line.cost",
        when: { "line.kind": "item" },
      },
    ],
    inventory: {
      effect: "transfer",
      warehouse: "line.warehouse",
      to_warehouse: "header.to_warehouse",
      costing: "consume_layers",
      allowNegative: false,
    },
    tax: { applies: false },
    numbering: { series: "CDT", assignAt: "issue" },
    reversal: { allowed: true, producesType: "CONSIGNMENT_DELIVERY_TEST" },
    approval: {
      required: false,
      approve: null,
      post: "inventory.transfer.post",
      create: "inventory.transfer.create",
    },
    fxRoundingAccount: { from: "company.fx_rounding_account_id" },
    dimensions: { required: ["BRANCH"] },
  } as const;

  it("a line with two movements is relieved by what its 1250 leg debited, once — not by their sum", async () => {
    const { itemId, baseUnitId } = await seedItem(db, s, {
      code: "CRC-CONSIGN-ITEM",
      kind: "product",
      trackLots: false,
    });
    // The consignment stock sits at the customer, off the shelf: an `in_transit` warehouse, which is where
    // postDocument's step 6f puts a dispatch-shaped transfer's receipt leg (it credits item.inventory_account).
    const consignment = await seedWarehouse(db, s, { code: "CRC-CONSIGN-WH", kind: "in_transit" });
    const typeId = await seedDocumentType(db, s, {
      code: "CONSIGNMENT_DELIVERY_TEST",
      module: "inventory",
      policy: CONSIGNMENT_POLICY,
    });
    const line = {
      kind: "item" as const,
      itemId,
      unitId: baseUnitId,
      warehouseId,
      quantity: "10.000000",
    };
    await postFromPack(db, s, {
      code: "GOODS_RECEIPT",
      effectiveDate: "2026-01-02",
      partyId: f.partyIds.vendor,
      warehouseId,
      jobs: recordingJobs(),
      lines: [{ ...line, unitPrice: "5.0000", amount: "50.0000" }],
    });

    const start1250 = await net("1250");
    const { documentId: deliveryId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId: typeId,
      series: "CDT",
      effectiveDate: "2026-01-10",
      partyId: f.partyIds.customer,
      warehouseId,
      toWarehouseId: consignment,
      lines: [{ ...line, unitPrice: "9.0000", amount: "90.0000" }],
    });
    await as((tx, c) => postDocument(tx, c, { documentId: deliveryId, jobs: recordingJobs() }));
    // The premise: two movements on the one line, and a 1250 leg of 50.0000 — the issue's value, once.
    const movements = await db.admin<{ quantity: string; value: string }[]>`
      select quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${deliveryId} order by movement_no`;
    expect(movements.map((m) => m.value).toSorted()).toEqual(["-50.0000", "50.0000"]);
    expect(await minus(await net("1250"), start1250)).toBe("50.0000");

    const { documentId } = await as((tx, c) =>
      convertToInvoice(tx, c, {
        companyId: s.company,
        sourceDocumentId: deliveryId,
        targetDocumentTypeId: f.documentTypeIds.SALES_INVOICE!,
        targetSeries: "INV",
        effectiveDate: "2026-01-12",
        lines: [{ sourceLineId: lineIds[0]!, quantity: "10.000000" }],
      }),
    );
    const [copied] = await db.admin<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${documentId}`;
    expect(copied!.cost).toBe("50.0000");
    await as((tx, c) => postDocument(tx, c, { documentId, jobs: recordingJobs() }));
    expect(await relieved(documentId)).toBe("50.0000");
    expect(await minus(await net("1250"), start1250)).toBe("0.0000");
  });
});

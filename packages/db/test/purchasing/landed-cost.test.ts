import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currency,
  Money,
  Quantity,
  validateDocumentTypeSeed,
  type ExchangeRate,
  type LineSnapshot,
} from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateLandedCost,
  allocateLandedCostForDocument,
  landedCostByLine,
  LandedCostError,
  listLandedCost,
  postDocument,
  receiptValue,
  replay,
  reverseDocument,
  type AllocationTarget,
} from "../../src/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../../src/seed/index";
// 3B's helpers, through the allowance amendment A21(c) gives `packages/db/test/**` (§4.17.1).
import {
  ensureOpenPeriods,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "my");
const MYR = currency("MYR");
const UNIT: ExchangeRate = {
  from: MYR,
  to: MYR,
  rate: "1.00000000",
  effectiveFrom: "2026-01-01",
  source: "unit",
};

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "3c-lc-test",
});
const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
  config: {
    tenantId: seed.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "lc",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "lc HQ",
    baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: 1,
    fiscalYear: 2026,
  },
  tenantId: seed.tenant,
  companyId: seed.company,
  systemPrincipalId: seed.system,
  packRoot: PACK_ROOT,
});

const target = (
  lineId: string,
  amount: string,
  quantity: string | null,
  weightKg: string | null,
): AllocationTarget => ({
  lineId,
  amount: Money.of(amount, MYR),
  quantity: quantity === null ? null : Quantity.of(quantity),
  weightKg: weightKg === null ? null : Quantity.of(weightKg),
});

/** A LineSnapshot carrying one amount and nothing else that `receiptValue` reads. */
const snapshotLine = (amount: string): LineSnapshot => ({
  id: "l1",
  lineNo: 1,
  kind: "item",
  description: null,
  accountId: null,
  itemId: "i1",
  quantity: Quantity.of("10.000000"),
  unitPrice: Money.of("100.0000", MYR),
  discount: Money.of("0.0000", MYR),
  amount: Money.of(amount, MYR),
  taxCodeId: null,
  taxAmount: Money.zero(MYR),
  totalInclTax: Money.of(amount, MYR),
  debit: Money.zero(MYR),
  credit: Money.zero(MYR),
  cost: null,
  warehouseId: "w1",
  toWarehouseId: null,
  lotId: null,
  unitId: "u1",
  unitQuantity: Quantity.of("10.000000"),
  countedQuantity: null,
  expectedQuantity: null,
  tenderMethod: null,
  customFields: {},
  dimensions: {},
  payroll: null,
});

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "lc");
  await grantCodes(db, s, {
    // `accounting.journal.post` is the code `STOCK_ISSUE_COST_POLICY` names (3B's fixture); the DoD block
    // posts an issue through it to prove the allocated share reaches the next document's cost.
    codes: [
      "accounting.journal.post",
      "accounting.purchase.create",
      "inventory.receipt.create",
      "inventory.receipt.post",
    ],
  });
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
  );
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
  );
  partyId = await seedParty(db, s, { kind: "vendor", code: "LC-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "LC-WH" });
  // Load-bearing, not tidy: Plan 0A's `seedTenant` opens 2026-01 alone (and closes 02, locks 03), and every
  // date in the DoD block below is June to September, so without this each of those cases would fail on
  // `ERR_PERIOD_NOT_OPEN` before reaching the arithmetic it exists to assert.
  await ensureOpenPeriods(db, s, 2026);
}, 240_000);
afterAll(async () => {
  await db.stop();
});

/** 3A's test-only STOCK_ISSUE_TEST with 3B's cost policy, seeded ONCE per suite. Two cases below post an
 *  issue through it, and `seedDocumentType` re-upserts policy version 1 on every call: once the first issue
 *  has posted under that version, migration 0106 refuses the rewrite with ERR_TABLE_IMMUTABLE (a pinned
 *  policy never changes), so the second case failed before it had drafted anything. */
let stockIssueTypeId: string | undefined;
async function stockIssueType(): Promise<string> {
  stockIssueTypeId ??= await seedDocumentType(db, s, {
    code: "STOCK_ISSUE_TEST",
    module: "inventory",
    policy: STOCK_ISSUE_COST_POLICY,
  });
  return stockIssueTypeId;
}

async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}
async function accountId(code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

describe("allocateLandedCost — pure arithmetic (contracts §4.2.1 Money.allocate; spec:1020)", () => {
  it("by_value splits in proportion to amount and sums exactly", () => {
    const shares = allocateLandedCost({
      costLineId: "c1",
      costAmount: Money.of("120.0000", MYR),
      method: "by_value",
      targets: [
        target("g1", "1000.0000", "10.000000", null),
        target("g2", "500.0000", "5.000000", null),
      ],
    });
    expect(shares.map((x) => x.amount.toString())).toEqual(["80.0000", "40.0000"]);
    expect(shares.map((x) => x.weight)).toEqual([10000000n, 5000000n]);
  });

  it("by_quantity splits in proportion to quantity, which differs from by_value when prices differ", () => {
    const targets = [
      target("g1", "1000.0000", "10.000000", null),
      target("g2", "1000.0000", "5.000000", null),
    ];
    const byValue = allocateLandedCost({
      costLineId: "c1",
      costAmount: Money.of("120.0000", MYR),
      method: "by_value",
      targets,
    });
    const byQty = allocateLandedCost({
      costLineId: "c1",
      costAmount: Money.of("120.0000", MYR),
      method: "by_quantity",
      targets,
    });
    expect(byValue.map((x) => x.amount.toString())).toEqual(["60.0000", "60.0000"]);
    expect(byQty.map((x) => x.amount.toString())).toEqual(["80.0000", "40.0000"]);
  });

  it("by_weight reads weight_kg and refuses a line that has none, naming the line", () => {
    const ok = allocateLandedCost({
      costLineId: "c1",
      costAmount: Money.of("100.0000", MYR),
      method: "by_weight",
      targets: [
        target("g1", "1000.0000", "10.000000", "30.000000"),
        target("g2", "1000.0000", "5.000000", "10.000000"),
      ],
    });
    expect(ok.map((x) => x.amount.toString())).toEqual(["75.0000", "25.0000"]);
    expect(() =>
      allocateLandedCost({
        costLineId: "c1",
        costAmount: Money.of("100.0000", MYR),
        method: "by_weight",
        targets: [
          target("g1", "1000.0000", "10.000000", "30.000000"),
          target("g2", "1000.0000", "5.000000", null),
        ],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED: line g2 carries no weight_kg custom field/);
  });

  it("puts the residue on the FIRST weight and still sums to the cent", () => {
    const shares = allocateLandedCost({
      costLineId: "c1",
      costAmount: Money.of("100.0000", MYR),
      method: "by_quantity",
      targets: [
        target("g1", "1.0000", "1.000000", null),
        target("g2", "1.0000", "1.000000", null),
        target("g3", "1.0000", "1.000000", null),
      ],
    });
    expect(shares.map((x) => x.amount.toString())).toEqual(["33.3334", "33.3333", "33.3333"]);
    const total = shares.reduce<Money>((acc, x) => acc.add(x.amount), Money.zero(MYR));
    expect(total.toString()).toBe("100.0000");
  });

  it("refuses an all-zero basis and an empty target set rather than dividing by nothing", () => {
    expect(() =>
      allocateLandedCost({
        costLineId: "c1",
        costAmount: Money.of("100.0000", MYR),
        method: "by_value",
        // an all-free-of-charge shipment
        targets: [target("g1", "0.0000", "10.000000", null)],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED: cost line c1: every by_value basis is zero/);
    expect(() =>
      allocateLandedCost({
        costLineId: "c1",
        costAmount: Money.of("100.0000", MYR),
        method: "by_value",
        targets: [],
      }),
    ).toThrow(/ERR_VALIDATION_FAILED: cost line c1 has no goods line to allocate onto/);
    expect(new LandedCostError("ERR_NOT_FOUND", "x").code).toBe("ERR_NOT_FOUND");
  });
});

describe("receiptValue — the one rule (contracts §4.7.2, 3C)", () => {
  it("is amount + allocated, converted once at the header rate", () => {
    expect(receiptValue(snapshotLine("1000.0000"), Money.of("80.0000", MYR), UNIT).toString()).toBe(
      "1080.0000",
    );
    const usd = currency("USD");
    const rate: ExchangeRate = {
      from: usd,
      to: MYR,
      rate: "4.20000000",
      effectiveFrom: "2026-01-01",
      source: "manual:test",
    };
    const usdLine = { ...snapshotLine("1000.0000"), amount: Money.of("1000.0000", usd) };
    // 1080 USD × 4.2 = 4536.0000 base, HALF_AWAY_FROM_ZERO at scale 4 (hazard 23).
    expect(receiptValue(usdLine, Money.of("80.0000", usd), rate).toString()).toBe("4536.0000");
  });

  it("is amount and not unit_price × quantity, so a discount is honoured (3A's provisional rule was not)", () => {
    const discounted = {
      ...snapshotLine("900.0000"),
      discount: Money.of("100.0000", MYR),
    };
    expect(receiptValue(discounted, Money.zero(MYR), UNIT).toString()).toBe("900.0000");
  });
});

describe("GOODS_RECEIPT with a landed cost — end to end (spec:1049)", () => {
  it("allocates on the draft, posts, and the layer carries goods + freight", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const freight = await accountId("5900");
    // trackLots: false on every item here — `seedItem` defaults it to TRUE (§4.6.1, migration 0028) and
    // `planMovements` refuses a DECLARED receipt of a lot-tracked item whose line names no lot
    // (ERR_POLICY_REQUIRES_MISSING); no line in this file names one, and the lot path is 3A's and 3D's.
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-1", trackLots: false });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "100.0000",
          amount: "1000.0000",
        },
        { kind: "account", accountId: freight, description: "inland freight", amount: "120.0000" },
      ],
    });

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      }),
    );
    expect(rows.map((r) => [r.targetLineId, r.allocatedAmount])).toEqual([
      [lineIds[0]!, "120.0000"],
    ]);

    const map = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      landedCostByLine(tx, documentId),
    );
    expect(map.get(lineIds[0]!)).toBe("120.0000");

    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));

    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ qty_in: string; unit_cost: string }[]>`
      select l.qty_in::text as qty_in, l.unit_cost::text as unit_cost
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId}`,
    );
    // 1000 + 120 = 1120 over 10 units.
    expect(layer).toEqual({ qty_in: "10.000000", unit_cost: "112.0000" });

    const [mv] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ value: string }[]>`
      select value::text as value from app.inventory_movement where document_id = ${documentId}`,
    );
    expect(mv!.value).toBe("1120.0000");

    // The ledger reaches the same 1120 by addition: 1000 to the item's inventory account, 120 to 1300.
    const [totals] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ inventory: string; grni: string; freight: string }[]>`
      select coalesce(sum(e.base_debit) filter (where a.code in ('1300')), 0)::text as inventory,
             coalesce(sum(e.base_credit) filter (where a.code = '2150'), 0)::text as grni,
             coalesce(sum(e.base_credit) filter (where a.code = '5900'), 0)::text as freight
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId}`,
    );
    expect(totals).toEqual({ inventory: "1120.0000", grni: "1000.0000", freight: "120.0000" });
  });

  it("a receipt with no allocation values the layer at the line amount alone", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-2", trackLots: false });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "4.000000",
          unitPrice: "25.0000",
          amount: "100.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unit_cost: string }[]>`
      select l.unit_cost::text as unit_cost from app.cost_layer l
        join app.inventory_movement m on m.id = l.movement_id where m.document_id = ${documentId}`,
    );
    expect(layer!.unit_cost).toBe("25.0000");
    const empty = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      landedCostByLine(tx, documentId),
    );
    expect(empty.size).toBe(0);
  });

  it("refuses an allocation whose cost line is an item line, or is not on the document", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "LC-ITEM-3", trackLots: false });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "1.0000",
          amount: "1.0000",
        },
      ],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), {
          documentId,
          allocations: [{ costLineId: lineIds[0]!, method: "by_value" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line .* is a item line; a landed-cost line is an account line/,
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), {
          documentId,
          allocations: [{ costLineId: documentId, method: "by_value" }],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: line .* is not a line of document/);
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => listLandedCost(tx, documentId)),
    ).toEqual([]);
  });
});

describe("INV-03 — a capitalised landed-cost line posts only when it is wholly allocated (ADR 0041 amendment)", () => {
  /** A GOODS_RECEIPT of 10 @ 100 with a 120.00 inland-freight account line, drafted and not allocated. */
  async function draftFreightReceipt(code: string) {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const freight = await accountId("5900");
    const { itemId, baseUnitId } = await seedItem(db, s, { code, trackLots: false });
    const drafted = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "100.0000",
          amount: "1000.0000",
        },
        { kind: "account", accountId: freight, description: "inland freight", amount: "120.0000" },
      ],
    });
    return { ...drafted, itemId, baseUnitId, freight };
  }

  /** Σ the document's layers against Σ its 1300 debit − credit: the identity test 7's TIE-OUT A sums. */
  async function layerAndLedger(documentId: string) {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ layer: string; ledger: string; status: string }[]>`
      select (select coalesce(sum(l.value), 0)::numeric(19, 4) from app.cost_layer l
                join app.inventory_movement m on m.id = l.movement_id
               where m.document_id = ${documentId})::text as layer,
             (select coalesce(sum(e.base_debit - e.base_credit), 0)::numeric(19, 4) from app.ledger_entry e
                join app.account a on a.id = e.account_id
               where e.document_id = ${documentId} and a.code = '1300')::text as ledger,
             (select status::text from app.document where id = ${documentId}) as status`,
    );
    return row!;
  }

  it("refuses a receipt whose freight line was never allocated, naming the line, and consumes no number", async () => {
    const { documentId } = await draftFreightReceipt("INV03-A");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING: document .* line 2 capitalises 120\.0000 into inventory account .* but 0\.0000 of it is allocated onto the goods lines/,
    );
    const after = await layerAndLedger(documentId);
    expect(after).toEqual({ layer: "0.0000", ledger: "0.0000", status: "draft" });
    const [numbered] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ number: string | null }[]>`
      select number::text as number from app.document where id = ${documentId}`,
    );
    expect(numbered!.number).toBeNull();
  });

  it("refuses a receipt whose allocation a line replacement cascaded away (PUT …/lines)", async () => {
    const { documentId, lineIds, itemId, baseUnitId, freight } =
      await draftFreightReceipt("INV03-B");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      }),
    );
    // What PUT …/documents/{id}/lines does (apps/api/src/routes/accounting/documents.ts): delete every line
    // and insert the new set. The FK cascade on landed_cost_allocation drops the shares with the old lines.
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`delete from app.document_line where document_id = ${documentId}`;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, warehouse_id,
           quantity, unit_price, amount)
        values (${s.tenant}, ${s.company}, ${documentId}, 1, 'item', ${itemId}, ${baseUnitId}, 10,
                ${warehouseId}, 10, 100, 1000)`;
      await tx`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, account_id, description, amount)
        values (${s.tenant}, ${s.company}, ${documentId}, 2, 'account', ${freight}, 'inland freight', 120)`;
    });
    expect(
      await withTenant(db.rw, s.tenant, s.human, (tx) => listLandedCost(tx, documentId)),
    ).toEqual([]);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING: document .* line 2 capitalises 120\.0000/);
    expect((await layerAndLedger(documentId)).status).toBe("draft");
  });

  it("refuses a receipt whose freight amount was edited after it was allocated", async () => {
    const { documentId, lineIds } = await draftFreightReceipt("INV03-C");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      }),
    );
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
      update app.document_line set amount = 150 where id = ${lineIds[1]!}`,
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING: document .* line 2 capitalises 150\.0000 .* but 120\.0000 of it is allocated/,
    );
  });

  it("posts once the line is re-allocated, and 1300 then ties to the layers to the cent", async () => {
    const { documentId, lineIds } = await draftFreightReceipt("INV03-D");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toThrow(/ERR_POLICY_REQUIRES_MISSING/);
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_quantity" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    expect(await layerAndLedger(documentId)).toEqual({
      layer: "1120.0000",
      ledger: "1120.0000",
      status: "posted",
    });
  });

  it("does not ask the reversal mirror, which carries its original's cost", async () => {
    const { documentId, lineIds } = await draftFreightReceipt("INV03-E");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[1]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    const reversal = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctx(s), {
        documentId,
        effectiveDate: "2026-01-15",
        reason: "INV-03 mirror",
      }),
    );
    expect(await layerAndLedger(reversal.reversalDocumentId)).toMatchObject({
      ledger: "-1120.0000",
      status: "posted",
    });
  });
});

describe("Phase 3 DoD — a landed-cost allocation changes unit cost and every downstream margin (spec:2289)", () => {
  /** Two goods lines and one freight line on a SHIPMENT draft, ready to allocate. */
  async function shipmentDraft(
    itemCode: string,
    freightAmount: string,
  ): Promise<{
    documentId: string;
    lineIds: string[];
    itemId: string;
    baseUnitId: string;
  }> {
    const documentTypeId = await typeId("SHIPMENT");
    const freight = await accountId("5900");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: itemCode, trackLots: false });
    const { documentId, lineIds } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-06-15",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "100.000000",
          unitPrice: "10.0000",
          amount: "1000.0000",
          customFields: { weight_kg: "300.000000" },
        },
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "50.000000",
          unitPrice: "20.0000",
          amount: "1000.0000",
          customFields: { weight_kg: "100.000000" },
        },
        {
          kind: "account",
          accountId: freight,
          description: "ocean freight and duty",
          amount: freightAmount,
        },
      ],
    });
    return { documentId, lineIds, itemId, baseUnitId };
  }

  it("the SHIPMENT seed file is GOODS_RECEIPT's four rules with the same accounts", () => {
    const shipment = JSON.parse(
      readFileSync(join(PACK_ROOT, "document-types", "SHIPMENT.json"), "utf8"),
    ) as Record<string, unknown>;
    const receipt = JSON.parse(
      readFileSync(join(PACK_ROOT, "document-types", "GOODS_RECEIPT.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(shipment)).toEqual({ ok: true, errors: [] });
    expect(shipment["module"]).toBe("inventory");
    const sp = shipment["policy"] as Record<string, unknown>;
    const rp = receipt["policy"] as Record<string, unknown>;
    expect(sp["lines"]).toEqual(rp["lines"]); // identical accounting, deliberately
    expect(sp["inventory"]).toEqual(rp["inventory"]);
    expect(sp["numbering"]).toEqual({ series: "SHP", assignAt: "issue" });
    expect(sp["approval"]).toEqual(rp["approval"]);
    expect(sp["reversal"]).toEqual({ allowed: true, producesType: "SHIPMENT" });
  });

  it("the allocated share lands in cost_layer.unit_cost, exactly", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-1", "300.0000");
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );

    // by_value over 1000 : 1000 -> 150 : 150. Line 1: (1000 + 150) / 100 = 11.5000.
    // Line 2: (1000 + 150) / 50 = 23.0000. Without the allocation they would be 10.0000 and 20.0000.
    const layers = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ line_no: number; qty_in: string; unit_cost: string; value: string }[]>`
      select m.line_no, l.qty_in::text as qty_in, l.unit_cost::text as unit_cost, m.value::text as value
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.document_id = ${documentId} order by m.line_no`,
    );
    expect(layers).toEqual([
      { line_no: 1, qty_in: "100.000000", unit_cost: "11.5000", value: "1150.0000" },
      { line_no: 2, qty_in: "50.000000", unit_cost: "23.0000", value: "1150.0000" },
    ]);

    // The ledger's inventory side is the same 2300 the two layers carry, reached by addition.
    const [totals] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ inventory: string; grni: string }[]>`
      select coalesce(sum(e.base_debit) filter (where a.code = '1300'), 0)::text as inventory,
             coalesce(sum(e.base_credit) filter (where a.code = '2150'), 0)::text as grni
        from app.ledger_entry e join app.account a on a.id = e.account_id
       where e.document_id = ${documentId}`,
    );
    expect(totals).toEqual({ inventory: "2300.0000", grni: "2000.0000" });
  });

  it("and therefore in every downstream margin: the issue's cost_consumption and document_line.cost move with it", async () => {
    // 250.0000 of freight, not the 300.0000 its siblings use: see the AVCO note below.
    const { documentId, lineIds, itemId, baseUnitId } = await shipmentDraft(
      "DOD-ITEM-2",
      "250.0000",
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );

    // There is no sale document before 3D, so the issue is 3A's registered test-only type with 3B's
    // cost policy (amendment A14): DR item.cogs_account, CR item.inventory_account, both at line.cost.
    const issueType = await stockIssueType();
    const issue = await draftTypedDocument(db, s, {
      documentTypeId: issueType,
      series: "SIT",
      warehouseId,
      effectiveDate: "2026-07-01",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "15.000000",
          unitPrice: "40.0000",
          amount: "600.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: issue.documentId, jobs: recordingJobs() }),
    );

    // AVCO over the two layers: (1125 + 1125) / 150 = 15.0000 per unit, EXACTLY. The engine prices an AVCO
    // issue as the running average ROUNDED TO 4 dp times the quantity (engine.ts `costIssue`, pinned by the
    // golden fixtures), so with 300.0000 of freight the average is 15.3333 and fifteen units cost 229.9995,
    // not 2300 x 15/150 = 230.0000 — the assertion that carries the DoD would have been a bet on the
    // rounding after all. 250.0000 makes the average terminate. Without the freight it would be
    // 2000 x 15/150 = 200.0000, so the allocation moved this issue's cost by exactly 25.0000 — the
    // 250.0000 freight's 15/150 share.
    const consumptions = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string; unit_cost: string; value: string }[]>`
      select k.quantity::text as quantity, k.unit_cost::text as unit_cost, k.value::text as value
        from app.cost_consumption k join app.inventory_movement m on m.id = k.movement_id
       where m.document_id = ${issue.documentId} order by k.unit_cost`,
    );
    const consumed = consumptions.reduce<Money>(
      (acc, r) => acc.add(Money.of(r.value, MYR)),
      Money.zero(MYR),
    );
    expect(consumed.toString()).toBe("225.0000");

    const [line] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${issue.documentId}`,
    );
    expect(line!.cost).toBe("225.0000");

    // The margin: revenue is not posted before 4A, so at Phase 3 "margin" is the cost side (hazard 4).
    // Sale value 600.0000 - cost 225.0000 = 375.0000, and it is exactly 25.0000 lower than the 400.0000 the
    // same sale would have shown had the freight never reached the layer. That difference IS the DoD clause.
    const [cogs] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ total: string }[]>`
      select coalesce(sum(e.base_debit), 0)::text as total from app.ledger_entry e
        join app.account a on a.id = e.account_id
       where e.document_id = ${issue.documentId} and a.code = '5000'`,
    );
    expect(cogs!.total).toBe("225.0000");
  });

  it("the same shipment re-allocated by_quantity gives a different split that still sums exactly", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-3", "300.0000");
    const byValue = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_value" }],
      }),
    );
    expect(byValue.map((r) => r.allocatedAmount)).toEqual(["150.0000", "150.0000"]);

    // 100 : 50 by quantity -> 200 : 100. Two rows change; there are never four.
    const byQuantity = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_quantity" }],
      }),
    );
    expect(byQuantity).toHaveLength(2);
    expect(byQuantity.map((r) => r.allocatedAmount)).toEqual(["200.0000", "100.0000"]);
    expect(byQuantity.every((r) => r.method === "by_quantity")).toBe(true);

    // 300 : 100 by weight -> 225 : 75, and the residue rule keeps every total exact.
    const byWeight = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_weight" }],
      }),
    );
    expect(byWeight.map((r) => r.allocatedAmount)).toEqual(["225.0000", "75.0000"]);
    for (const rows of [byValue, byQuantity, byWeight]) {
      const total = rows.reduce<Money>(
        (acc, r) => acc.add(Money.of(r.allocatedAmount, MYR)),
        Money.zero(MYR),
      );
      expect(total.toString()).toBe("300.0000");
    }
  });

  it("a BACK-DATED shipment recosts only forward and posts a visible COST_ADJUSTMENT (test 5 re-run)", async () => {
    const documentTypeId = await typeId("SHIPMENT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "DOD-ITEM-4", trackLots: false });
    const freight = await accountId("5900");

    // A later receipt first, so the back-dated one has a tail to invalidate.
    const later = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-09-01",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "10.0000",
          amount: "100.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: later.documentId, jobs: recordingJobs() }),
    );

    // ...and a CONSUMPTION in that tail, without which the replay has nothing to adjust. A back-dated
    // receipt on its own only rewrites layer unit costs, and no COGS total changes - so `adjustmentsPosted`
    // would be empty and test 5's "adjustment is visible and explained" clause would have nothing to point
    // at.
    const issueType = await stockIssueType();
    const sold = await draftTypedDocument(db, s, {
      documentTypeId: issueType,
      series: "SIT",
      warehouseId,
      effectiveDate: "2026-09-15",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "5.000000",
          unitPrice: "30.0000",
          amount: "150.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: sold.documentId, jobs: recordingJobs() }),
    );
    // Costed at 10.0000 a unit today: the only layer it can see is September's.
    const [before] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${sold.documentId}`,
    );
    expect(before!.cost).toBe("50.0000");

    const back = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "SHP",
      partyId,
      warehouseId,
      effectiveDate: "2026-08-01",
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "10.0000",
          amount: "100.0000",
        },
        { kind: "account", accountId: freight, description: "airfreight", amount: "50.0000" },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId: back.documentId,
        allocations: [{ costLineId: back.lineIds[1]!, method: "by_value" }],
      }),
    );

    const jobs = recordingJobs();
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: back.documentId, jobs }),
    );
    // Step 14 fired because an already-posted movement of this item carries a LATER effective_date.
    expect(jobs.enqueued.map((j) => j.name)).toContain("inventory.cost.replay");

    // The JobEnvelope literal is 3B's own `replay.test.ts` shape - §4.2.6 owns it - and `replay` takes a
    // POOL, opening its own `withTenant` from the ctx it is handed (3b's call site, verbatim).
    const systemCtx = { tenantId: s.tenant, actorId: s.system, requestId: "3c-lc-dod-4" };
    const outcome = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: systemCtx.requestId, payload: { companyId: s.company } },
      systemCtx,
    );
    expect(outcome.movementsReplayed).toBeGreaterThan(0);
    expect(outcome.adjustmentsPosted.length).toBeGreaterThan(0);

    // The September issue is now costed over BOTH layers at the running average: (150 + 100) / 20 = 12.5000
    // a unit, so 5 units cost 62.5000 rather than the 50.0000 they cost before the shipment arrived. The
    // 12.5000 difference is what the COST_ADJUSTMENT posts, and it is the whole content of "recosts
    // forward".
    const [after] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ cost: string }[]>`
      select cost::text as cost from app.document_line where document_id = ${sold.documentId}`,
    );
    expect(after!.cost).toBe("62.5000");

    // Each layer keeps its OWN unit cost - AVCO consumes proportionally, it does not rewrite a layer's rate.
    const layers = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ effective_at: string; unit_cost: string; qty_remaining: string }[]>`
      select l.effective_at::text as effective_at, l.unit_cost::text as unit_cost,
             l.qty_remaining::text as qty_remaining
        from app.cost_layer l join app.inventory_movement m on m.id = l.movement_id
       where m.item_id = ${itemId} and l.invalidated_at is null order by l.effective_at`,
    );
    expect(layers).toEqual([
      { effective_at: "2026-08-01", unit_cost: "15.0000", qty_remaining: "7.500000" },
      { effective_at: "2026-09-01", unit_cost: "10.0000", qty_remaining: "7.500000" },
    ]);

    const adjustments = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; status: string }[]>`
      select t.code, d.status::text as status from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.id = any(${outcome.adjustmentsPosted}::uuid[])`,
    );
    expect(adjustments.every((a) => a.code === "COST_ADJUSTMENT" && a.status === "posted")).toBe(
      true,
    );
  });

  it("landed cost cannot be re-allocated after post; the remedy is a reversal and a re-post", async () => {
    const { documentId, lineIds } = await shipmentDraft("DOD-ITEM-5", "300.0000");
    // Allocated on the draft: since INV-03 an unallocated freight line refuses the post itself (step 6h).
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      allocateLandedCostForDocument(tx, ctx(s), {
        documentId,
        allocations: [{ costLineId: lineIds[2]!, method: "by_value" }],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId, jobs: recordingJobs() }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        allocateLandedCostForDocument(tx, ctx(s), {
          documentId,
          allocations: [{ costLineId: lineIds[2]!, method: "by_quantity" }],
        }),
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is posted — landed cost is allocated on a draft/,
    );

    // The remedy, exercised rather than described (ADR 0041).
    const { reversalDocumentId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reverseDocument(tx, ctx(s), {
        documentId,
        effectiveDate: "2026-06-16",
        reason: "freight re-split by quantity",
        jobs: recordingJobs(),
      }),
    );
    expect(reversalDocumentId).toBeTruthy();
    const [onHand] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string }[]>`
      select coalesce(sum(quantity), 0)::text as quantity from app.stock_on_hand h
        join app.item i on i.id = h.item_id where i.code = 'DOD-ITEM-5'`,
    );
    expect(onHand!.quantity).toBe("0.000000");
  });
});

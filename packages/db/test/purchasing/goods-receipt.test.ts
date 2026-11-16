import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocumentTypeSeed } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linkFulfilment, openQuantity, postDocument, transitionDocument } from "../../src/index";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { documentTypesLoader, type SubPack } from "../../src/seed/index";
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

let db: Db;
let s: Seed;
let partyId: string;
let warehouseId: string;

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "3c-grn-test",
});
const loaderCtx = (seed: Seed, only: readonly SubPack[]) => ({
  config: {
    tenantId: seed.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "grn",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "grn HQ",
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

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "grn");
  await grantCodes(db, s, {
    codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"],
  });
  // chart-of-accounts BEFORE document-types (hazard 33 in miniature): `2150` must resolve before the
  // policy naming it is validated at post.
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(s, ["chart-of-accounts"])),
  );
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(s, ["document-types"])),
  );
  partyId = await seedParty(db, s, { kind: "vendor", code: "GRN-VEND" });
  warehouseId = await seedWarehouse(db, s, { code: "GRN-WH" });
}, 240_000);
afterAll(async () => {
  await db.stop();
});

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

describe("GOODS_RECEIPT — contracts §4.14, §3.0.4 row spec:1049", () => {
  it("the seed file is a valid envelope: inbound, receipt, create_layer, series GRN, and it names 2150", () => {
    const envelope = JSON.parse(
      readFileSync(join(TYPES_DIR, "GOODS_RECEIPT.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("inbound");
    expect(policy["inventory"]).toEqual({
      effect: "receipt",
      warehouse: "line.warehouse",
      costing: "create_layer",
    });
    expect(policy["numbering"]).toEqual({ series: "GRN", assignAt: "issue" });
    expect(policy["approval"]).toEqual({
      required: false,
      approve: null,
      post: "inventory.receipt.post",
      create: "inventory.receipt.create",
    });
    // Four rules, every amount `line.amount`: the item line debits item.inventory_account and credits 2150;
    // each freight/duty/clearance `account` line debits 1300 and credits its own account. NO rule references
    // line.cost — §4.3.2 step 6 balances before step 9 fills it (Task 0 Step 3's §4.3.4 rule).
    expect(
      (policy["lines"] as { side: string; amount: string }[]).map((l) => [l.side, l.amount]),
    ).toEqual([
      ["debit", "line.amount"],
      ["credit", "line.amount"],
      ["debit", "line.amount"],
      ["credit", "line.amount"],
    ]);
    expect(JSON.stringify(policy["lines"])).toContain('"code":"2150"');
    expect(JSON.stringify(policy["lines"])).toContain('"code":"1300"');
    expect(JSON.stringify(policy["lines"])).not.toContain("line.cost");
  });

  it("posts the GRNI accrual: inventory debited and 2150 credited at line.amount (spec:1049)", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    // trackLots: false on every item here — `seedItem` defaults it to TRUE (§4.6.1, migration 0028) and
    // `planMovements` refuses a DECLARED receipt of a lot-tracked item whose line names no lot
    // (ERR_POLICY_REQUIRES_MISSING); no line in this file names one, and the lot path is 3A's and 3D's.
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-ITEM", trackLots: false });
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
          quantity: "20.000000",
          unitPrice: "12.5000",
          amount: "250.0000",
        },
      ],
    });
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId }),
    );
    expect(result.movementIds).toHaveLength(1);

    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        { code: string; debit: string; credit: string; base_debit: string; base_credit: string }[]
      >`select a.code, l.debit::text as debit, l.credit::text as credit,
             l.base_debit::text as base_debit, l.base_credit::text as base_credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`,
    );
    expect(rows).toEqual([
      {
        code: "1300",
        debit: "250.0000",
        credit: "0.0000",
        base_debit: "250.0000",
        base_credit: "0.0000",
      },
      {
        code: "2150",
        debit: "0.0000",
        credit: "250.0000",
        base_debit: "0.0000",
        base_credit: "250.0000",
      },
    ]);

    // Stock and the layer agree with the ledger, to the cent.
    const [stock] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ quantity: string }[]>`
      select quantity::text as quantity from app.stock_on_hand
       where item_id = ${itemId} and warehouse_id = ${warehouseId}`,
    );
    expect(stock!.quantity).toBe("20.000000");
    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ qty_in: string; unit_cost: string }[]>`
      select qty_in::text as qty_in, unit_cost::text as unit_cost from app.cost_layer where item_id = ${itemId}`,
    );
    expect(layer).toEqual({ qty_in: "20.000000", unit_cost: "12.5000" });
    expect(await accountId("2150")).toBeTruthy();
  });

  it("a discounted line still balances, because the cost is derived from the same amount", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, {
      code: "GRN-DISCOUNT",
      trackLots: false,
    });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      // 10 × 10.0000 = 100.0000, less a 15.0000 discount → amount 85.0000. cost follows amount, not
      // unit_price × qty.
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "10.0000",
          discount: "15.0000",
          amount: "85.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit::text as debit, l.credit::text as credit
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`,
    );
    expect(rows).toEqual([
      { code: "1300", debit: "85.0000", credit: "0.0000" },
      { code: "2150", debit: "0.0000", credit: "85.0000" },
    ]);
    const [layer] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unit_cost: string }[]>`
      select unit_cost::text as unit_cost from app.cost_layer where item_id = ${itemId}`,
    );
    expect(layer!.unit_cost).toBe("8.5000");
  });

  it("prices its accrual from the order it receives against (spec:1050)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-FROM-PO", trackLots: false });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId,
      series: "PO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "40.000000",
          unitPrice: "9.0000",
          amount: "360.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }),
    );

    // The receipt line carries a quantity and NO price: the link is what prices it.
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: receiptTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "25.000000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: order.documentId,
        targetDocumentId: receipt.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: order.lineIds[0]!,
            targetLineId: receipt.lineIds[0]!,
            quantity: "25.000000",
          },
        ],
      }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx(s), { documentId: receipt.documentId }),
    );

    const [grni] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ credit: string }[]>`
      select l.credit::text as credit from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${receipt.documentId} and a.code = '2150'`,
    );
    expect(grni!.credit).toBe("225.0000"); // 25 × 9.0000, the order's price
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, order.documentId),
    );
    expect(open[0]!.openQuantity).toBe("15.000000"); // the back-order stays open
  });

  it("a free-of-charge line takes stock in at zero cost with no net ledger effect (spec:1055)", async () => {
    const documentTypeId = await typeId("GOODS_RECEIPT");
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "GRN-FOC", trackLots: false });
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
          quantity: "100.000000",
          unitPrice: "2.0000",
          amount: "200.0000",
        },
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "0.0000",
          amount: "0.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId }));

    // Both lines moved stock; only the priced one carried value.
    const movements = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ line_no: number; quantity: string; value: string }[]>`
      select line_no, quantity::text as quantity, value::text as value
        from app.inventory_movement where document_id = ${documentId} order by line_no`,
    );
    expect(movements).toEqual([
      { line_no: 1, quantity: "100.000000", value: "200.0000" },
      { line_no: 2, quantity: "10.000000", value: "0.0000" },
    ]);
    const [layers] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number; zero: number }[]>`
      select count(*)::int as n, count(*) filter (where unit_cost = 0)::int as zero
        from app.cost_layer where item_id = ${itemId}`,
    );
    expect(layers).toEqual({ n: 2, zero: 1 });

    // Asserted as an aggregate, deliberately: whether a zero-value planned line survives to ledger_entry as a
    // 0/0 row is 3B's zero-drop question (see the plan's Spec questions). The NET is what must be exact.
    const [totals] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ debit: string; credit: string }[]>`
      select coalesce(sum(base_debit), 0)::text as debit, coalesce(sum(base_credit), 0)::text as credit
        from app.ledger_entry where document_id = ${documentId}`,
    );
    expect(totals).toEqual({ debit: "200.0000", credit: "200.0000" });
  });
});

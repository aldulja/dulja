import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, type Violation } from "../src/index";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "./index";

let db: Db;
let a: Seed;
let b: Seed;

/** A SHIPMENT-shaped type: it only has to be a configured type whose documents can hold item and account lines. */
async function shipmentType(s: Seed, code: string, series: string): Promise<string> {
  return seedDocumentType(db, s, {
    code,
    module: "inventory",
    policy: {
      version: 1,
      documentType: code,
      direction: "none",
      requires: [],
      lines: [],
      inventory: { effect: "none" },
      tax: { applies: false },
      numbering: { series, assignAt: "issue" },
      reversal: { allowed: false, producesType: null },
      approval: { required: false, approve: null, post: "accounting.journal.post" },
      fxRoundingAccount: { from: "company.fx_rounding_account_id" },
      dimensions: { required: [] },
    },
  });
}

/** A draft with two goods lines and one freight line, which is the minimum shape an allocation needs. */
async function draftShipment(
  s: Seed,
  typeId: string,
  series: string,
  accountId: string,
): Promise<{ documentId: string; lineIds: string[] }> {
  const { itemId, baseUnitId } = await seedItem(db, s, {
    code: `LCA-${Math.random().toString(36).slice(2, 8)}`,
  });
  const warehouseId = await seedWarehouse(db, s, {
    code: `LCA-WH-${Math.random().toString(36).slice(2, 8)}`,
  });
  return draftTypedDocument(db, s, {
    documentTypeId: typeId,
    series,
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
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId,
        quantity: "5.000000",
        unitPrice: "200.0000",
        amount: "1000.0000",
      },
      { kind: "account", accountId, description: "ocean freight", amount: "120.0000" },
    ],
  });
}

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "lca-a");
  b = await seedTenantV2(db, "lca-b");
  await grantCodes(db, a, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  await grantCodes(db, b, { codes: ["accounting.journal.create", "accounting.journal.post"] });
  // `seedTenantV2` creates ONLY `1000 Cash` and `4000 Sales` (Assumptions fact 3), and this suite loads no
  // seed pack — so the freight account every `draftShipment` needs is created here, in both tenants, BEFORE
  // any `accountIdOf` call. `5900` is 0C's code and is created rather than seeded: `seedAccount` is
  // idempotent on (company_id, code) and this is a Testcontainers company, not a tenant's chart.
  for (const s of [a, b]) {
    await seedAccount(db, s, { code: "5900", nameEn: "Other operating expense", type: "expense" });
  }
}, 180_000);
afterAll(async () => {
  await db.stop();
});

async function accountIdOf(s: Seed, code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

describe("app.landed_cost_allocation — migration 0038 (contracts §4.6.1; spec:1020, 1049; SAH-049)", () => {
  it("the schema linter reports zero violations after 0038", async () => {
    const violations: Violation[] = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("has tenant_id, forced RLS, a tenant_isolation policy, an audit_row trigger and the draft guard", async () => {
    const [t] = await db.admin<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class where oid = 'app.landed_cost_allocation'::regclass`;
    expect(t).toEqual({ rls: true, forced: true });
    const policies = await db.admin<{ polname: string }[]>`
      select polname from pg_policy where polrelid = 'app.landed_cost_allocation'::regclass order by 1`;
    expect(policies.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.landed_cost_allocation'::regclass and not tgisinternal order by 1`;
    expect(triggers.map((x) => x.tgname)).toEqual([
      "audit_row",
      "landed_cost_allocation_draft_only",
    ]);
  });

  it("app_rw holds select, insert and update — and NO delete (contracts §3.5.4 is closed)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'landed_cost_allocation' order by 1`;
    expect(grants.map((g) => g.privilege_type).toSorted()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("stores one row per (cost line, target line) and REPLACES it on re-allocation through the upsert key", async () => {
    const ty = await shipmentType(a, "LCA_SHIP", "LS");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LS", freightAccount);
    const [goodsA, goodsB, cost] = [lineIds[0]!, lineIds[1]!, lineIds[2]!];

    // by_value over two equal amounts: 60.0000 each.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [targetLine, amount] of [
        [goodsA, "60.0000"],
        [goodsB, "60.0000"],
      ] as const) {
        await tx`insert into app.landed_cost_allocation
                   (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
                 values (${a.tenant}, ${a.company}, ${documentId}, ${cost}, ${targetLine}, 'by_value', ${amount})
                 on conflict (cost_line_id, target_line_id) do update
                   set method = excluded.method, allocated_amount = excluded.allocated_amount`;
      }
    });
    const first = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ method: string; amount: string }[]>`
      select method, allocated_amount::text as amount from app.landed_cost_allocation
       where shipment_document_id = ${documentId} order by target_line_id`,
    );
    expect(first).toHaveLength(2);
    expect(first.map((r) => [r.method, r.amount])).toEqual([
      ["by_value", "60.0000"],
      ["by_value", "60.0000"],
    ]);

    // Re-allocate by_quantity, 10 : 5 → 80.0000 : 40.0000. The SAME two rows must change, not four rows exist.
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      for (const [targetLine, amount] of [
        [goodsA, "80.0000"],
        [goodsB, "40.0000"],
      ] as const) {
        await tx`insert into app.landed_cost_allocation
                   (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
                 values (${a.tenant}, ${a.company}, ${documentId}, ${cost}, ${targetLine}, 'by_quantity', ${amount})
                 on conflict (cost_line_id, target_line_id) do update
                   set method = excluded.method, allocated_amount = excluded.allocated_amount`;
      }
    });
    const second = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number; total: string }[]>`
      select count(*)::int as n, sum(allocated_amount)::text as total
        from app.landed_cost_allocation where shipment_document_id = ${documentId}`,
    );
    expect(second[0]).toEqual({ n: 2, total: "120.0000" });
    const methods = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ method: string }[]>`
      select distinct method from app.landed_cost_allocation where shipment_document_id = ${documentId}`,
    );
    expect(methods.map((m) => m.method)).toEqual(["by_quantity"]);
  });

  it("admits a zero share, because an absent row would leave a stale one behind", async () => {
    const ty = await shipmentType(a, "LCA_ZERO", "LZ");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LZ", freightAccount);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_weight', 0)`,
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ amount: string }[]>`
      select allocated_amount::text as amount from app.landed_cost_allocation where shipment_document_id = ${documentId}`,
    );
    expect(row!.amount).toBe("0.0000");
  });

  it("refuses a negative share and an unknown method", async () => {
    const ty = await shipmentType(a, "LCA_BAD", "LB");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LB", freightAccount);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', -1)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'pro_rata', 10)`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an allocation on a document that is no longer a draft (ERR_DOC_NOT_DRAFT)", async () => {
    const ty = await shipmentType(a, "LCA_ISSUED", "LI");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LI", freightAccount);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${documentId}`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 10)`,
      ),
    ).rejects.toThrow(
      /ERR_DOC_NOT_DRAFT: document .* is issued — landed cost is allocated on a draft/,
    );
  });

  it("refuses a pair whose lines belong to another document (ERR_VALIDATION_FAILED)", async () => {
    const ty = await shipmentType(a, "LCA_CROSS", "LX");
    const freightAccount = await accountIdOf(a, "5900");
    const one = await draftShipment(a, ty, "LX", freightAccount);
    const two = await draftShipment(a, ty, "LX", freightAccount);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${a.tenant}, ${a.company}, ${one.documentId}, ${one.lineIds[2]!}, ${two.lineIds[0]!}, 'by_value', 10)`,
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: cost line .* and target line .* must both belong to document/,
    );
  });

  it("deleting the draft shipment cascades its allocations away (no DELETE grant needed)", async () => {
    const ty = await shipmentType(a, "LCA_CASCADE", "LC");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LC", freightAccount);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`,
    );
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`delete from app.document where id = ${documentId}`,
    );
    const [after] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.landed_cost_allocation where shipment_document_id = ${documentId}`,
    );
    expect(after!.n).toBe(0);
  });

  it("tenant B sees none of tenant A's allocations and cannot point one at A's rows (test 12)", async () => {
    const ty = await shipmentType(a, "LCA_ISO", "LO");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LO", freightAccount);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`,
    );

    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.landed_cost_allocation`,
    );
    expect(seen[0]!.n).toBe(0);

    // NOT 23503. `landed_cost_allocation_draft_only` is a BEFORE INSERT ROW trigger and PostgreSQL runs
    // those before referential integrity (an FK is an AFTER-row RI trigger). Its first statement reads
    // `app.document` for `new.shipment_document_id`; under B's RLS that is A's row and returns nothing, so
    // `v_status` is null and it raises `ERR_NOT_FOUND: document … is not visible` with errcode
    // 'check_violation' (23514) before the composite FK is ever evaluated. The GUARD is the first refusal;
    // the composite FKs are the belt underneath, and no cross-tenant document id can reach them.
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
        insert into app.landed_cost_allocation
          (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
        values (${b.tenant}, ${b.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 1)`,
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: document .* is not visible/);
  });

  it("writes an audit row for every allocation insert and update (test 13)", async () => {
    const before = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'landed_cost_allocation'`;
    const ty = await shipmentType(a, "LCA_AUDIT", "LA");
    const freightAccount = await accountIdOf(a, "5900");
    const { documentId, lineIds } = await draftShipment(a, ty, "LA", freightAccount);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.landed_cost_allocation
                 (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
               values (${a.tenant}, ${a.company}, ${documentId}, ${lineIds[2]!}, ${lineIds[0]!}, 'by_value', 120)`;
      await tx`update app.landed_cost_allocation set allocated_amount = 100 where shipment_document_id = ${documentId}`;
    });
    const after = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'landed_cost_allocation'`;
    expect(after[0]!.n).toBe(before[0]!.n + 2);
  });
});

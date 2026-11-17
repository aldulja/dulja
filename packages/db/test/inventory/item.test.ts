import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ItemAccountUnresolvedError } from "../../src/inventory/errors";
import { createItem, listItems, resolveItemAccounts } from "../../src/inventory/items";
import { createUnit } from "../../src/inventory/units";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { seedAccount, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.item / app.unit_of_measure / app.unit_conversion — migration 0028 (contracts §4.6.1)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Item A");
    b = await seedTenant(db, "Item B");
    // hazard 33: 3A consumes four §4.15 codes it does not seed. seedTenant ships only 1000 and 4000,
    // so the three the item defaults need are created here through 1A's seedAccount.
    await seedAccount(db, a, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, a, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedAccount(db, a, { code: "5900", nameEn: "Other operating expense", type: "expense" });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the four §4.15 item-default account codes resolve in the company's chart (hazard 33)", async () => {
    const accounts = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveItemAccounts(tx, { companyId: a.company, kind: "product" }),
    );
    expect(accounts.revenueAccountId).toBe(a.sales); // 4000, seedTenant's
    expect(accounts.inventoryAccountId).not.toBeNull(); // 1300
    expect(accounts.cogsAccountId).not.toBeNull(); // 5000
    expect(accounts.expenseAccountId).not.toBeNull(); // 5900
  });

  it("a service item takes 4000 and 5900 and leaves the two stock accounts null", async () => {
    const accounts = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveItemAccounts(tx, { companyId: a.company, kind: "service" }),
    );
    expect(accounts.inventoryAccountId).toBeNull();
    expect(accounts.cogsAccountId).toBeNull();
    expect(accounts.expenseAccountId).not.toBeNull();
  });

  it("a missing default code is named, never silently nulled (hazard 33, LEGACY-064)", async () => {
    // Tenant B has no 1300/5000/5900 rows.
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) =>
        resolveItemAccounts(tx, { companyId: b.company, kind: "product" }),
      ),
    ).rejects.toThrow(ItemAccountUnresolvedError);
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) =>
        resolveItemAccounts(tx, { companyId: b.company, kind: "product" }),
      ),
    ).rejects.toThrow(/account 1300 is not in company/);
  });

  it("createItem stores the base unit and the four resolved accounts", async () => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "item-1" };
    const row = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const unit = await createUnit(tx, { companyId: a.company, code: "PCS", nameEn: "Piece" });
      return createItem(tx, ctx, {
        companyId: a.company,
        code: "RICE-5KG",
        nameEn: "Rice 5kg",
        kind: "product",
        baseUnitId: unit.id,
        barcode: "9556000000019",
        shelfLifeDays: 365,
      });
    });
    expect(row.kind).toBe("product");
    expect(row.trackLots).toBe(true); // §4.6.1 default: food is batch-tracked
    expect(row.inventoryAccountId).not.toBeNull();
    expect(row.cogsAccountId).not.toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("unit_conversion refuses a zero denominator and a non-positive numerator (spec:2043, LEGACY-063)", async () => {
    const { itemId, unitId } = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const unit = await createUnit(tx, { companyId: a.company, code: "CTN", nameEn: "Carton" });
      const [item] = await tx<
        { id: string }[]
      >`select id from app.item where company_id = ${a.company} and code = 'RICE-5KG'`;
      return { itemId: item!.id, unitId: unit.id };
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (${a.tenant}, ${itemId}, ${unitId}, 12, 0)`,
      ),
    ).rejects.toThrow(/unit_conversion_denominator_check/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
      values (${a.tenant}, ${itemId}, ${unitId}, 0, 1)`,
      ),
    ).rejects.toThrow(/unit_conversion_numerator_check/);
  });

  it("a second tenant sees none of the three tables' rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [i] = await tx<{ n: number }[]>`select count(*)::int as n from app.item`;
      const [u] = await tx<{ n: number }[]>`select count(*)::int as n from app.unit_of_measure`;
      const [c] = await tx<{ n: number }[]>`select count(*)::int as n from app.unit_conversion`;
      return [i!.n, u!.n, c!.n];
    });
    expect(counts).toEqual([0, 0, 0]);
    expect(
      await withTenant(db.rw, a.tenant, a.human, async (tx) => {
        const [i] = await tx<{ n: number }[]>`select count(*)::int as n from app.item`;
        return i!.n;
      }),
    ).toBeGreaterThan(0);
  });

  it("a cross-tenant insert is refused by the RLS with check, not silently written", async () => {
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
      insert into app.unit_of_measure (tenant_id, company_id, code, name_en)
      values (${a.tenant}, ${a.company}, 'HIJACK', 'Hijack')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("listItems pages by code and hides archived rows by default", async () => {
    const codes = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const rows = await listItems(tx, { companyId: a.company, limit: 10 });
      return rows.map((r) => r.code);
    });
    expect(codes).toContain("RICE-5KG");
  });

  it("lintSchema reports zero violations after 0028", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("every new table is audited and neither is immutable (contracts §3.5.3)", async () => {
    for (const t of ["item", "unit_of_measure", "unit_conversion"]) {
      expect(AUDIT_EXEMPT.has(t)).toBe(false);
      expect(IMMUTABLE.has(t)).toBe(false);
      const [trg] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where not t.tgisinternal and c.relname = ${t} and t.tgname = 'audit_row'`;
      expect(trg!.n).toBe(1);
    }
  });
});

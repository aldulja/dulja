import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPriceList,
  listPriceLists,
  replacePriceListLines,
  resolvePrice,
} from "../../src/inventory/prices";
import { createPromotion, listPromotions } from "../../src/inventory/promotions";
import { lintSchema } from "../../src/lint-schema";
import { seedBranch, seedItem, seedTenant, seedUnit, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("app.price_list / price_list_line / promotion — migration 0030 (contracts §4.6.1, spec:1025)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let itemId: string;
  let cartonId: string;
  let branchId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Price A");
    await grantCodes(db, a);
    b = await seedTenant(db, "Price B");
    await grantCodes(db, b);
    ({ itemId } = await seedItem(db, a, { code: "RICE-5KG" }));
    cartonId = await seedUnit(db, a, { code: "CTN", nameEn: "Carton" });
    branchId = await seedBranch(db, a, { code: "KL-01" });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a price list carries currency, trade level, branch and a date window", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createPriceList(tx, {
        companyId: a.company,
        code: "RETAIL",
        nameEn: "Retail",
        currency: "MYR",
        customerKind: "retail",
        validFrom: "2026-01-01",
        validTo: "2026-12-31",
      }),
    );
    expect(row.currency).toBe("MYR");
    expect(row.customerKind).toBe("retail");
    expect(row.branchId).toBeNull(); // null = every branch (§3.7.5, spec:1312)
    expect(row.archivedAt).toBeNull();
  });

  it("valid_to before valid_from is refused", async () => {
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        createPriceList(tx, {
          companyId: a.company,
          code: "BACKWARDS",
          nameEn: "Backwards",
          currency: "MYR",
          validFrom: "2026-06-01",
          validTo: "2026-05-01",
        }),
      ),
    ).rejects.toThrow(/price_list_window_check/);
  });

  it("a line is unique on (list, item, unit, min_quantity) with NULLS NOT DISTINCT", async () => {
    const listId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const pl = await createPriceList(tx, {
        companyId: a.company,
        code: "WHOLESALE",
        nameEn: "Wholesale",
        currency: "MYR",
        customerKind: "wholesale",
      });
      await replacePriceListLines(tx, pl.id, [
        { itemId, unitPrice: "18.5000" }, // unit null, break 0
        { itemId, minQuantity: "100.000000", unitPrice: "17.2500" },
        { itemId, unitId: cartonId, unitPrice: "210.0000" },
      ]);
      return pl.id;
    });
    // The second insert of (listId, itemId, null, 0) must collide, not create a twin.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.price_list_line (tenant_id, price_list_id, item_id, unit_id, min_quantity, unit_price)
      values (${a.tenant}, ${listId}, ${itemId}, null, 0, 19.0000)`,
      ),
    ).rejects.toThrow(/price_list_line_price_list_id_item_id_unit_id_min_quantity_key/);
  });

  it("a negative unit price is refused (LEGACY-073's shape, applied to a price)", async () => {
    const [pl] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from app.price_list where company_id = ${a.company} and code = 'WHOLESALE'`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
      values (${a.tenant}, ${pl!.id}, ${itemId}, 500, -1.0000)`,
      ),
    ).rejects.toThrow(/price_list_line_unit_price_check/);
  });

  it("resolvePrice picks the most specific match and is stable across calls", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      // The company-wide RETAIL list (the first case) was created with no lines, and `resolvePrice` joins
      // `price_list_line`, so a list with nothing on it can never be the answer. Give it the item first.
      const [retail] = await tx<{ id: string }[]>`
        select id from app.price_list where company_id = ${a.company} and code = 'RETAIL'`;
      await replacePriceListLines(tx, retail!.id, [{ itemId, unitPrice: "21.0000" }]);
      const branchList = await createPriceList(tx, {
        companyId: a.company,
        code: "KL-RETAIL",
        nameEn: "KL retail",
        currency: "MYR",
        customerKind: "retail",
        branchId,
      });
      await replacePriceListLines(tx, branchList.id, [{ itemId, unitPrice: "19.9000" }]);
    });
    const q = {
      companyId: a.company,
      itemId,
      currency: "MYR",
      quantity: "1.000000",
      on: "2026-03-15",
      customerKind: "retail",
    };
    // no branch → the company-wide RETAIL list
    const anyBranch = await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, q));
    expect(anyBranch?.priceListCode).toBe("RETAIL");
    expect(anyBranch?.unitPrice).toBe("21.0000");
    // with the branch → the branch list wins over the company-wide one
    const inBranch = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, branchId }),
    );
    expect(inBranch?.priceListCode).toBe("KL-RETAIL");
    expect(inBranch?.unitPrice).toBe("19.9000");
    const again = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, branchId }),
    );
    expect(again).toEqual(inBranch);
  });

  it("resolvePrice takes the highest quantity break at or below the quantity", async () => {
    const q = {
      companyId: a.company,
      itemId,
      currency: "MYR",
      on: "2026-03-15",
      customerKind: "wholesale",
    };
    const one = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, quantity: "1.000000" }),
    );
    const many = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolvePrice(tx, { ...q, quantity: "250.000000" }),
    );
    expect(one?.unitPrice).toBe("18.5000");
    expect(many?.unitPrice).toBe("17.2500");
    expect(many?.minQuantity).toBe("100.000000");
  });

  it("resolvePrice returns null outside the window and for an archived list, never a stale price", async () => {
    const q = {
      companyId: a.company,
      itemId,
      currency: "MYR",
      quantity: "1.000000",
      on: "2027-01-05",
      customerKind: "retail",
    };
    expect(await withTenant(db.rw, a.tenant, a.human, (tx) => resolvePrice(tx, q))).toBeNull();
  });

  it("a promotion is closed to three kinds and needs a forward window", async () => {
    const row = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      createPromotion(tx, {
        companyId: a.company,
        code: "RAYA-10",
        nameEn: "Raya 10% off",
        kind: "percent_off",
        definition: { percent: "10.00", itemIds: [itemId] },
        startsAt: "2026-03-01T00:00:00Z",
        endsAt: "2026-03-31T23:59:59Z",
        branchId,
      }),
    );
    expect(row.kind).toBe("percent_off");
    expect(row.definition).toMatchObject({ percent: "10.00" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition)
      values (${a.tenant}, ${a.company}, 'BAD-KIND', 'Bad', 'buy_one_get_one', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/promotion_kind_check/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
      values (${a.tenant}, ${a.company}, 'BACKWARDS', 'Backwards', 'amount_off', '{}'::jsonb,
              '2026-04-01T00:00:00Z', '2026-03-01T00:00:00Z')`,
      ),
    ).rejects.toThrow(/promotion_window_check/);
  });

  it("listPromotions filters by branch and by the instant it is active on (spec:1312)", async () => {
    const inWindow = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listPromotions(tx, {
        companyId: a.company,
        branchId,
        activeOn: "2026-03-15T09:00:00Z",
        limit: 50,
      }),
    );
    expect(inWindow.map((p) => p.code)).toEqual(["RAYA-10"]);
    const after = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listPromotions(tx, {
        companyId: a.company,
        branchId,
        activeOn: "2026-05-01T09:00:00Z",
        limit: 50,
      }),
    );
    expect(after).toEqual([]);
  });

  it("a second tenant sees none of the three tables' rows (spec:106, test 12)", async () => {
    const counts = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [l] = await tx<{ n: number }[]>`select count(*)::int as n from app.price_list`;
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.price_list_line`;
      const [p] = await tx<{ n: number }[]>`select count(*)::int as n from app.promotion`;
      return [l!.n, n!.n, p!.n];
    });
    expect(counts).toEqual([0, 0, 0]);
    expect(
      (
        await withTenant(db.rw, a.tenant, a.human, (tx) =>
          listPriceLists(tx, { companyId: a.company, limit: 50 }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("lintSchema is clean; both optional-branch tables have restrictive isolation (§4.5.6)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies where schemaname = 'app'
        and tablename in ('price_list', 'promotion') and policyname = 'branch_isolation' and permissive = 'RESTRICTIVE'`;
    expect(p!.n).toBe(2);
  });
});

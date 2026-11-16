import { grantCodes } from "../fixtures";
// packages/db/test/sync/catalogue-revision.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { startDb, withTenant, type Db } from "../harness";
import { seedItem, seedParty, seedPriceList, seedTenantV2, seedUnit, type Seed } from "../fixtures";

describe("migration 0059 — the catalogue revision is assigned in COMMIT order (§4.10.2, C1; spec:1299)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenantV2(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  // Closed membership: every live stream must carry both revision storage and its commit-order trigger.
  // Phase 6C adds its two owning tables to the same exact assertions used by Phase 6A.
  const STREAM_TABLES = [
    "branch_pos_policy",
    "item",
    "party",
    "pos_cashier",
    "price_list",
    "price_list_line",
    "promotion",
    "tax_code",
  ];

  it("every stream table carries a NOT NULL revision and the catalogue_revision trigger", async () => {
    const rows = await db.admin<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable from information_schema.columns
       where table_schema = 'app' and column_name = 'revision' and table_name <> 'catalogue_tombstone' order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(STREAM_TABLES);
    expect(rows.every((r) => r.is_nullable === "NO")).toBe(true);

    const trg = await db.admin<{ relname: string }[]>`
      select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname = 'catalogue_revision' and not t.tgisinternal order by 1`;
    expect(trg.map((r) => r.relname)).toEqual(STREAM_TABLES);
  });

  it("a row written earlier gets a lower revision, and an update re-stamps it", async () => {
    const unitId = await seedUnit(db, a);
    const { itemId } = await seedItem(db, a, { code: "SKU-1", baseUnitId: unitId });
    const first = await revisionOf(db, a, "item", itemId);
    const partyId = await seedParty(db, a, { code: "CUST-1" });
    const second = await revisionOf(db, a, "party", partyId);
    expect(second).toBeGreaterThan(first);

    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.item set name_en = 'renamed' where id = ${itemId}`,
    );
    expect(await revisionOf(db, a, "item", itemId)).toBeGreaterThan(second);
  });

  it("the two tenants share one sequence but never see each other's rows (test 12 for the new table)", async () => {
    const plA = await seedPriceList(db, a, { code: "PL-A" });
    const plB = await seedPriceList(db, b, { code: "PL-B" });
    expect(plA).not.toEqual(plB);
    const seen = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.price_list where id = ${plB}`,
    );
    expect(seen[0]!.n).toBe(0);

    // The tombstone half needs a tenant-A tombstone to EXIST first. This case runs before the archive cases
    // below, so without its own archive the count B reads would be 0 whether or not RLS held (Global
    // Constraint 2: a two-tenant test for every new table, and app.catalogue_tombstone is 0059's).
    const plGone = await seedPriceList(db, a, { code: "PL-A-GONE" });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.price_list set archived_at = now() where id = ${plGone}`,
    );
    const countTombstones = (s: Seed) =>
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.catalogue_tombstone
         where tenant_id = ${a.tenant} and row_id = ${plGone}`,
      );
    const [ownTomb] = await countTombstones(a);
    expect(ownTomb!.n, "tenant A sees its own tombstone, or the case below asserts nothing").toBe(
      1,
    );
    const [otherTomb] = await countTombstones(b);
    expect(otherTomb!.n).toBe(0);
    const [anyOfA] = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where tenant_id = ${a.tenant}`,
    );
    expect(anyOfA!.n).toBe(0);
  });

  it("archiving a catalogue row writes a tombstone carrying the row's branch (spec:1300)", async () => {
    const branchId = a.hq;
    const plId = await seedPriceList(db, a, { code: "PL-GONE", branchId });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`,
    );
    const [t] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ stream: string; row_id: string; branch_id: string | null; revision: string }[]>`
      select stream, row_id, branch_id, revision::text as revision from app.catalogue_tombstone where row_id = ${plId}`,
    );
    expect(t).toBeDefined();
    expect(t!.stream).toBe("price_list");
    expect(t!.branch_id).toBe(branchId);
    // The tombstone's revision IS the row's new revision: the till learns of the deletion at the same cursor
    // position it would have learned of an edit, so no ordering rule is needed between the two.
    expect(t!.revision).toBe(String(await revisionOf(db, a, "price_list", plId)));
  });

  it("archiving a PRICE-LIST LINE writes a tombstone carrying its PARENT's company and branch", async () => {
    // price_list_line has neither company_id nor branch_id (3A) and catalogue_tombstone.company_id is NOT NULL,
    // so a trigger that read `to_jsonb(new) ->> 'company_id'` here would raise 23502 and would break 3A's own
    // `replacePriceListLines` retirement path — which is why this case exists and not merely the price_list one.
    const unitId = await seedUnit(db, a);
    const { itemId } = await seedItem(db, a, { code: "SKU-LINE", baseUnitId: unitId });
    const plId = await seedPriceList(db, a, { code: "PL-LINES", branchId: a.hq });
    const lineId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.price_list_line (tenant_id, price_list_id, item_id, min_quantity, unit_price)
        values (${a.tenant}, ${plId}, ${itemId}, 0, 9.9900) returning id`;
      return row!.id;
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.price_list_line set archived_at = now() where id = ${lineId}`,
    );

    const [t] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        { stream: string; company_id: string; branch_id: string | null; revision: string }[]
      >`
      select stream, company_id, branch_id, revision::text as revision from app.catalogue_tombstone where row_id = ${lineId}`,
    );
    expect(t).toBeDefined();
    expect(t!.stream).toBe("price_list_line");
    expect(t!.company_id).toBe(a.company); // the PARENT's, looked up — not NULL
    expect(t!.branch_id).toBe(a.hq); // the PARENT's branch, so Form B scopes it correctly
    expect(t!.revision).toBe(String(await revisionOf(db, a, "price_list_line", lineId)));
  });

  it("a promotion is retired by ends_at and writes NO tombstone — it has no archived_at column (3A)", async () => {
    // 3A's promotion table declares no archived_at (phase-3a:2443), so the tombstone branch cannot fire for
    // this stream. That is the design, not a gap: a shortened window is an UPSERT the till applies, and a
    // tombstone would make the till forget a promotion that still exists.
    const promoId = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.promotion (tenant_id, company_id, code, name_en, kind, definition, starts_at, ends_at)
        values (${a.tenant}, ${a.company}, 'PROMO-1', 'Ten off', 'percent_off', ${tx.json({ percent: 10 })},
                now() - interval '1 day', now() + interval '30 days')
        returning id`;
      return row!.id;
    });
    const before = await revisionOf(db, a, "promotion", promoId);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx`update app.promotion set ends_at = now() - interval '1 second' where id = ${promoId}`,
    );
    expect(await revisionOf(db, a, "promotion", promoId)).toBeGreaterThan(before);
    const [n] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where row_id = ${promoId}`,
    );
    expect(n!.n).toBe(0);
  });

  it("un-archiving writes no second tombstone and bumps the revision (a resurrection is an upsert)", async () => {
    const plId = await seedPriceList(db, a, { code: "PL-BACK" });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.price_list set archived_at = now() where id = ${plId}`,
    );
    const archived = await revisionOf(db, a, "price_list", plId);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.price_list set archived_at = null where id = ${plId}`,
    );
    // The till forgot the row at `archived`; it re-learns it only if the resurrection moves the row PAST that
    // cursor, as any other edit would. A revision left at `archived` would never be delivered again.
    expect(await revisionOf(db, a, "price_list", plId)).toBeGreaterThan(archived);
    const [n] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.catalogue_tombstone where row_id = ${plId}`,
    );
    expect(n!.n).toBe(1);
  });

  it("concurrent catalogue transactions cannot assign a cursor beyond an uncommitted earlier write", async () => {
    const unitId = await seedUnit(db, a);
    const { itemId } = await seedItem(db, a, { code: "SKU-CONCURRENT", baseUnitId: unitId });
    const partyId = await seedParty(db, a, { code: "CUST-CONCURRENT" });
    const original = await revisionOf(db, a, "item", itemId);
    let release!: () => void;
    let written!: () => void;
    const ready = new Promise<void>((resolve) => {
      written = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ revision: string }[]>`
        update app.item set name_en = 'first transaction' where id = ${itemId} returning revision::text`;
      written();
      await held;
      return BigInt(row!.revision);
    });
    await ready;
    const second = withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ revision: string }[]>`
        update app.party set name_en = 'second transaction' where id = ${partyId} returning revision::text`;
      return BigInt(row!.revision);
    });
    try {
      expect(await revisionOf(db, a, "item", itemId)).toBe(original);
    } finally {
      release();
    }
    const [committedFirst, committedSecond] = await Promise.all([first, second]);
    expect(committedSecond).toBeGreaterThan(committedFirst);
    expect(await revisionOf(db, a, "item", itemId)).toBe(committedFirst);
  });

  it("the schema linter still reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

async function revisionOf(
  db: Db,
  s: Seed,
  table: "item" | "party" | "price_list" | "price_list_line" | "promotion" | "tax_code",
  id: string,
): Promise<bigint> {
  // The table is a literal chosen from a closed union — never a client string, never concatenation (test 27).
  // That is why this is a ternary chain rather than one templated table name: there is no path through this
  // helper on which an identifier reaches SQL as text.
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const rows =
      table === "item"
        ? await tx<{ r: string }[]>`select revision::text as r from app.item where id = ${id}`
        : table === "party"
          ? await tx<{ r: string }[]>`select revision::text as r from app.party where id = ${id}`
          : table === "price_list"
            ? await tx<
                { r: string }[]
              >`select revision::text as r from app.price_list where id = ${id}`
            : table === "price_list_line"
              ? await tx<
                  { r: string }[]
                >`select revision::text as r from app.price_list_line where id = ${id}`
              : table === "promotion"
                ? await tx<
                    { r: string }[]
                  >`select revision::text as r from app.promotion where id = ${id}`
                : await tx<
                    { r: string }[]
                  >`select revision::text as r from app.tax_code where id = ${id}`;
    return BigInt(rows[0]!.r);
  });
}

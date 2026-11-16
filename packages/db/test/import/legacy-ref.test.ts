import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVERY_ROW, exportTable } from "../../src/export/tables";
import { lintSchema } from "../../src/lint-schema";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** contracts §4.13.3 names exactly these six tables; the order is the one `information_schema` sorts them in. */
const TABLES = ["account", "document", "employee", "item", "lot", "party"] as const;

let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "legacy-ref");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0101 — legacy_ref (contracts §4.13.3; spec:2333 §5.1 #8, SAH-051)", () => {
  it("adds a nullable text column to exactly the six tables §4.13.3 names, and to no other", async () => {
    const rows = await db.admin<{ table_name: string; data_type: string; is_nullable: string }[]>`
      select table_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and column_name = 'legacy_ref'
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([...TABLES]);
    expect(rows.every((r) => r.data_type === "text" && r.is_nullable === "YES")).toBe(true);
  });

  it("indexes each one on (company_id, legacy_ref), partially, and NEVER uniquely — SAH-051 says duplicates exist", async () => {
    const rows = await db.admin<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
       where schemaname = 'app' and indexname like '%\_legacy\_ref\_idx' order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(TABLES.map((t) => `${t}_legacy_ref_idx`));
    for (const row of rows) {
      expect(row.indexdef, row.indexname).not.toContain("UNIQUE");
      expect(row.indexdef, row.indexname).toContain("(company_id, legacy_ref)");
      expect(row.indexdef, row.indexname).toContain("WHERE (legacy_ref IS NOT NULL)");
    }
  });

  it("accepts two rows with the same legacy_ref — the legacy numbering is not unique (SAH-051)", async () => {
    const a = await uuidv7(db.admin);
    const b = await uuidv7(db.admin);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.party (id, tenant_id, company_id, kind, code, name_en, legacy_ref)
               values (${a}, ${s.tenant}, ${s.company}, 'customer', 'DUP-A', 'Duplicate A', 'C-000123'),
                      (${b}, ${s.tenant}, ${s.company}, 'customer', 'DUP-B', 'Duplicate B', 'C-000123')`;
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.party where company_id = ${s.company} and legacy_ref = 'C-000123'`;
      expect(n!.n).toBe(2);
    });
  });

  it("leaves the tenant export carrying legacy_ref on all six registered rows (7C's registry, ADR 0069)", async () => {
    for (const name of TABLES) expect(exportTable(name).columns, name).toContain("legacy_ref");
    const parties = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      exportTable("party").rows(tx, s.company, EVERY_ROW),
    );
    expect(parties.filter((p) => p["legacy_ref"] === "C-000123")).toHaveLength(2);
  });

  it("leaves lintSchema at zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("document.number stays bigint — a legacy number is never written into it (SAH-051)", async () => {
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'number'`;
    expect(col!.data_type).toBe("bigint");
  });
});

import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { down, listApplied, up } from "../src/migrate";
import { draftDocument, seedTenantV2, type Seed } from "./fixtures";
import { MIGRATIONS_DIR, startDb, uuidv7, withTenant, type Db } from "./harness";

describe("migration 0040 — document_line.counted_quantity / expected_quantity (contracts §4.3.4, the 3D row; spec:1052)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "tenant-a");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenantV2(db, "tenant-b");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("both columns exist, are numeric(19,6) and are nullable", async () => {
    const rows = await db.admin<
      { column_name: string; data_type: string; numeric_scale: number; is_nullable: string }[]
    >`
      select column_name, data_type, numeric_scale, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('counted_quantity', 'expected_quantity')
       order by column_name`;
    expect(rows.map((column) => column.column_name)).toEqual([
      "counted_quantity",
      "expected_quantity",
    ]);
    for (const column of rows) {
      expect(column.data_type).toBe("numeric");
      expect(column.numeric_scale).toBe(6);
      expect(column.is_nullable).toBe("YES");
    }
  });

  it("a line round-trips both quantities at six decimal places", async () => {
    const docId = await draftDocument(db, a);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line
                 (id, tenant_id, company_id, document_id, line_no, kind, quantity, counted_quantity, expected_quantity)
               values (${lineId}, ${a.tenant}, ${a.company}, ${docId}, 1, 'item', -1.500000, 8.500000, 10.000000)`;
    });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ quantity: string; counted_quantity: string; expected_quantity: string }[]>`
        select quantity::text, counted_quantity::text, expected_quantity::text
          from app.document_line where id = ${lineId}`,
    );
    expect(row).toEqual({
      quantity: "-1.500000",
      counted_quantity: "8.500000",
      expected_quantity: "10.000000",
    });
  });

  it("tenant B cannot see tenant A's counted line (spec:106)", async () => {
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_line where counted_quantity is not null`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("lintSchema still reports zero violations (contracts §3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("0040 down drops the two columns and leaves app.document_line standing (contracts §3.4.5)", async () => {
    const applied = await listApplied(db.migrator);
    expect(applied).toContain(40);
    // Rolls back everything above 39 — 0040, 0041 and the review branch's 0105-0108 — then replays it.
    // `privileges.test.ts` already proves the whole ladder to zero and back, so the chain below 0040 is
    // not what is under test here: the two columns disappearing and the table surviving is.
    await down(db.migrator, MIGRATIONS_DIR, 39);
    const [after] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line'
         and column_name in ('counted_quantity', 'expected_quantity')`;
    expect(after!.n).toBe(0);
    const [tbl] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'app' and table_name = 'document_line'`;
    expect(tbl!.n).toBe(1);
    await up(db.migrator, MIGRATIONS_DIR);
  });
});

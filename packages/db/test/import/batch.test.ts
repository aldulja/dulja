import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_TABLES, NEVER_EXPORTED } from "../../src/export/tables";
import {
  batchCounts,
  byLegacyRef,
  findBatch,
  recordBatch,
  sourceHashOf,
} from "../../src/import/batch";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { seedImportBatch, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

let db: Db;
let a: Seed;
let b: Seed;
const RUN = "01930000-0000-7000-8000-000000000001";
/** A valid sha256 shape. The DDL's CHECK is `^[0-9a-f]{64}$`; the value itself is irrelevant to the cases that do
 *  not exercise the hash, and the ones that do build it with `sourceHashOf`. */
const H = "0".repeat(64);

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "import-a");
  b = await seedTenantV2(db, "import-b");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const auditRows = (s: Seed) =>
  withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [n] = await tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'import_batch'`;
    return n!.n;
  });

describe("migration 0102 — app.import_batch (contracts §4.6.1, §4.13.3; round 20 C7)", () => {
  it("joins no linter set: it keeps id, created_at and the audit trigger (§3.5.3)", async () => {
    expect(AUDIT_EXEMPT.has("import_batch")).toBe(false);
    expect(IMMUTABLE.has("import_batch")).toBe(false);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("stamps loaded_by from app.current_actor() and refuses to have it supplied", async () => {
    const id = await uuidv7(db.admin);
    const target = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.import_batch (id, tenant_id, company_id, source_table, source_key,
                                             target_table, target_id, source_hash, run_id, loaded_by)
               values (${id}, ${a.tenant}, ${a.company}, 'ACCOUNTS', '1000', 'account', ${target}, ${H},
                       ${RUN}, ${a.system})`;
      const [row] = await tx<{ loaded_by: string }[]>`
        select loaded_by from app.import_batch where id = ${id}`;
      expect(row!.loaded_by).toBe(a.human); // stamp_loaded_by overwrote the supplied value
    });
  });

  it("writes an audit row for every insert (test 13)", async () => {
    const before = await auditRows(a);
    const target = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx`insert into app.import_batch (tenant_id, company_id, source_table, source_key,
                                       target_table, target_id, source_hash, run_id)
           values (${a.tenant}, ${a.company}, 'ACCOUNTS', '1100', 'account', ${target}, ${H}, ${RUN})`,
    );
    expect(await auditRows(a)).toBe(before + 1);
  });

  it("a second tenant cannot see, nor write into, the first tenant's batch rows (test 12)", async () => {
    const visible = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.import_batch`;
      return n!.n;
    });
    expect(visible).toBe(0);
    const target = await uuidv7(db.admin);
    // Tenant B naming tenant A's tenant and company: refused by RLS's WITH CHECK, and by the composite FK besides.
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) =>
          tx`insert into app.import_batch (tenant_id, company_id, source_table, source_key,
                                         target_table, target_id, source_hash, run_id)
             values (${a.tenant}, ${a.company}, 'ACCOUNTS', 'X', 'account', ${target}, ${H}, ${RUN})`,
      ),
    ).rejects.toThrow(/row-level security|violates/);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) =>
          tx`insert into app.import_batch (tenant_id, company_id, source_table, source_key,
                                         target_table, target_id, source_hash, run_id)
             values (${b.tenant}, ${a.company}, 'ACCOUNTS', 'X', 'account', ${target}, ${H}, ${RUN})`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("the mapping never moves: app_rw holds SELECT and INSERT only, so no row can be re-pointed or deleted", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'import_batch'
       order by privilege_type`;
    expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT", "SELECT"]);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`update app.import_batch set target_id = ${a.company} where company_id = ${a.company}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a malformed hash, a lower-case source table and an upper-case target table", async () => {
    const target = await uuidv7(db.admin);
    const insert = (sourceTable: string, targetTable: string, hash: string) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`insert into app.import_batch (tenant_id, company_id, source_table, source_key,
                                         target_table, target_id, source_hash, run_id)
             values (${a.tenant}, ${a.company}, ${sourceTable}, 'K', ${targetTable}, ${target}, ${hash}, ${RUN})`,
      );
    await expect(insert("ACCOUNTS", "account", "A".repeat(64))).rejects.toThrow(
      /import_batch_source_hash_check/,
    );
    await expect(insert("accounts", "account", H)).rejects.toThrow(
      /import_batch_source_table_check/,
    );
    await expect(insert("ACCOUNTS", "Account", H)).rejects.toThrow(
      /import_batch_target_table_check/,
    );
  });

  it("recordBatch is idempotent on an identical re-run and conflicts on a changed one", async () => {
    const target = await uuidv7(db.admin);
    const input = {
      companyId: a.company,
      sourceTable: "MATERIALS",
      sourceKey: "M-1",
      targetTable: "item",
      targetId: target,
      sourceHash: sourceHashOf({ code: "M-1", name: "Widget" }),
      runId: RUN,
    };
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      expect((await recordBatch(tx, input)).kind).toBe("inserted");
      const again = await recordBatch(tx, { ...input, targetId: await uuidv7(db.admin) });
      expect(again.kind).toBe("skipped");
      expect(again.targetId).toBe(target); // a re-run is answered with the first mapping
      const changed = { ...input, sourceHash: sourceHashOf({ code: "M-1", name: "Widget Mk II" }) };
      const out = await recordBatch(tx, changed);
      expect(out.kind).toBe("conflict");
      expect(out.targetId).toBe(target); // the mapping never moves
    });
  });

  it("the natural key is per company: the same legacy key in a second tenant is its own row", async () => {
    const input = (s: Seed, targetId: string) => ({
      companyId: s.company,
      sourceTable: "MATERIALS",
      sourceKey: "M-SHARED",
      targetTable: "item",
      targetId,
      sourceHash: H,
      runId: RUN,
    });
    const ta = await uuidv7(db.admin);
    const tb = await uuidv7(db.admin);
    const outA = await withTenant(db.rw, a.tenant, a.human, (tx) => recordBatch(tx, input(a, ta)));
    const outB = await withTenant(db.rw, b.tenant, b.human, (tx) => recordBatch(tx, input(b, tb)));
    expect([outA.kind, outB.kind]).toEqual(["inserted", "inserted"]);
    // Tenant B's resolver never answers with tenant A's row, even asked about tenant A's company.
    const leaked = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      byLegacyRef(tx, {
        companyId: a.company,
        sourceTable: "MATERIALS",
        sourceKey: "M-SHARED",
        targetTable: "item",
      }),
    );
    expect(leaked).toBeNull();
  });

  it("byLegacyRef answers what a legacy key became, and null for one it never saw", async () => {
    const target = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await recordBatch(tx, {
        companyId: a.company,
        sourceTable: "ACCOUNTS",
        sourceKey: "4000",
        targetTable: "account",
        targetId: target,
        sourceHash: H,
        runId: RUN,
      });
      const key = { companyId: a.company, sourceTable: "ACCOUNTS", targetTable: "account" };
      expect(await byLegacyRef(tx, { ...key, sourceKey: "4000" })).toBe(target);
      expect(await byLegacyRef(tx, { ...key, sourceKey: "9999" })).toBeNull();
      // A key mapped into one target table is not an answer for another.
      expect(await byLegacyRef(tx, { ...key, sourceKey: "4000", targetTable: "party" })).toBeNull();
      const found = await findBatch(tx, {
        companyId: a.company,
        sourceTable: "ACCOUNTS",
        sourceKey: "4000",
      });
      expect(found).toMatchObject({
        sourceTable: "ACCOUNTS",
        sourceKey: "4000",
        targetTable: "account",
        targetId: target,
        sourceHash: H,
        runId: RUN,
        loadedBy: a.human,
      });
      expect(found!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });
  });

  it("batchCounts groups a run by target table", async () => {
    const counts = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      batchCounts(tx, { companyId: a.company, runId: RUN }),
    );
    expect(counts.map((c) => c.targetTable)).toEqual(["account", "item"]);
    expect(counts.find((c) => c.targetTable === "account")!.rows).toBeGreaterThanOrEqual(3);
    expect(counts.find((c) => c.targetTable === "item")!.rows).toBe(2);
  });

  it("sourceHashOf is key-order independent, so a reordered read is not a false conflict", () => {
    expect(sourceHashOf({ a: "1", b: "2" })).toBe(sourceHashOf({ b: "2", a: "1" }));
    expect(sourceHashOf({ n: { y: "1", x: "2" } })).toBe(sourceHashOf({ n: { x: "2", y: "1" } }));
    expect(sourceHashOf({ a: "1" })).not.toBe(sourceHashOf({ a: "2" }));
    expect(sourceHashOf(["1", "2"])).not.toBe(sourceHashOf(["2", "1"])); // an array's order is data
    expect(sourceHashOf({ a: "1" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seedImportBatch writes one row and returns its id (round 20 C5)", async () => {
    const target = await uuidv7(db.admin);
    const id = await seedImportBatch(db, a, {
      sourceTable: "WAREHOUSES",
      sourceKey: "W-1",
      targetTable: "warehouse",
      targetId: target,
    });
    const [row] = await db.admin<{ id: string; target_id: string; source_hash: string }[]>`
      select id, target_id, source_hash from app.import_batch where id = ${id}`;
    expect(row).toEqual({ id, target_id: target, source_hash: H });
  });

  it("is classified for the tenant export: pinned whole as plumbing, never registered (7C, ADR 0069)", () => {
    expect(NEVER_EXPORTED["import_batch"]).toEqual(["*"]);
    expect(EXPORT_TABLES.map((t) => t.name)).not.toContain("import_batch");
  });
});

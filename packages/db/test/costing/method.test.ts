import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, never `@dulja/db*`: 0B's `dependency-rule` pins `"packages/db": ["@dulja/domain"]` and
// keys a file's owner on the path prefix `packages/db/` with no `test/` exclusion (0b:5052, 0b:5091).
import { lintSchema } from "../../src/lint-schema";
import { loadSnapshot } from "../../src/posting";
import { draftDocument, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("company.costing_method — OD-06 (spec:1214; contracts §4.7.3, §2.12)", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Method");
    await grantCodes(db, s); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a company created without the column defaults to avco — spec:1214's recommendation", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ costing_method: string }[]>`
          select costing_method from app.company where id = ${s.company}`,
    );
    // The line the owner's answer flips (OD-06). PRINTED, because the owner's Verify step promises
    // `default costing_method: avco` in the output and a green run with no figure verifies nothing.
    // `no-console` is off for `**/*.test.ts` in .oxlintrc.json; it is an error everywhere under src.
    console.log(`default costing_method: ${row!.costing_method}`);
    expect(row!.costing_method).toBe("avco");
  });

  it("the CHECK admits exactly avco and fifo", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`update app.company set costing_method = 'lifo' where id = ${s.company}`,
      ),
    ).rejects.toThrow(/company_costing_method_check/);

    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${s.company}`,
    );
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.company set costing_method = 'avco' where id = ${s.company}`,
    );
  });

  it("loadSnapshot reads the column rather than hard-coding avco (contracts §4.3.1's stub list)", async () => {
    const documentId = await draftDocument(db, s);
    const avco = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, documentId));
    expect(avco.company.costingMethod).toBe("avco");

    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.company set costing_method = 'fifo' where id = ${s.company}`,
    );
    const fifo = await withTenant(db.rw, s.tenant, s.human, (tx) => loadSnapshot(tx, documentId));
    expect(fifo.company.costingMethod).toBe("fifo");

    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.company set costing_method = 'avco' where id = ${s.company}`,
    );
  });

  it("the schema linter still reports zero violations after 0035", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, recordIntegrityIncident, runIntegrityCheck, withTenant } from "@dulja/db";
import { sharedDb } from "../support/regression";
import { seedTenantV2, startDb, type Db, type Seed, uuidv7 } from "@dulja/db/test";
import { postJournal } from "../invariants/support/post-journal";

describe("LEGACY-079 44 repair objects, two ledgers, one broken guard — 1A", () => {
  it("there is exactly ONE ledger table and one projection derived from it — no repair object exists", async () => {
    const { db } = await sharedDb();
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables
       where table_schema = 'app' and table_type = 'BASE TABLE'
         and (table_name like '%ledger%' or table_name like '%balance%' or table_name like '%repair%'
              or table_name like '%fix%' or table_name like '%recalc%' or table_name like '%rebuild%')
       order by table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      "account_balance",
      "ledger_entry",
      "ledger_entry_dimension",
    ]);
  });

  it("the schema linter reports zero violations after Phase 1's migrations", async () => {
    const { db } = await sharedDb();
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

describe("LEGACY-079 44 repair objects, two parallel idempotency ledgers, and one broken guard — 1B", () => {
  let db: Db;
  let a: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("drift is detected and recorded, never repaired — the projection is untouched after a failing run", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "8.0000" },
      { account: a.sales, credit: "8.0000" },
    ]);
    const ctx = {
      tenantId: a.tenant,
      actorId: a.system,
      requestId: await uuidv7(db.admin),
    };
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`update app.account_balance set debit = debit + 1 where account_id = ${a.cash}`,
    );
    const before = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ debit: string }[]>`
      select debit::text from app.account_balance where account_id = ${a.cash}`,
    );

    const report = await withTenant(db.rw, ctx, async (tx) => {
      const result = await runIntegrityCheck(tx, ctx);
      await recordIntegrityIncident(tx, result);
      return result;
    });
    expect(report.ok).toBe(false);

    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ debit: string }[]>`
      select debit::text from app.account_balance where account_id = ${a.cash}`,
    );
    expect(after).toEqual(before);
  });

  it("there is exactly one idempotency ledger for migrations and no procFix* object anywhere", async () => {
    const tables = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'app_meta' order by 1`;
    expect(tables.map((row) => row.table_name)).toEqual(["schema_migration"]);
    const funcs = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname ilike '%fix%'`;
    expect(funcs).toEqual([]);
  });
});

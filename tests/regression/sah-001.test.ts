import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAccountBalanceProjection, withTenant } from "@dulja/db";
import { type Db, type Seed, seedTenantV2, startDb, uuidv7 } from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { postJournal } from "../invariants/support/post-journal";

describe("SAH-001 Denormalised currency balances updated without the tenant key — 1A", () => {
  it("account_balance carries tenant_id, is RLS-forced, and a second tenant can neither see nor update a row", async () => {
    const { db, rw } = await sharedDb();
    const a = await seedTenantV2(db, "SAH001-A");
    const b = await seedTenantV2(db, "SAH001-B");
    await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "sah001" },
      (tx) => tx`
      insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, base_debit)
      values (${a.tenant}, ${a.company}, ${a.cash}, ${a.period}, 'MYR', 10.0000, 10.0000)`,
    );
    const seen = await withTenant(
      rw,
      { tenantId: b.tenant, actorId: b.human, requestId: "sah001" },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.account_balance`,
    );
    expect(seen[0]!.n).toBe(0);
    const touched = await withTenant(
      rw,
      { tenantId: b.tenant, actorId: b.human, requestId: "sah001" },
      async (tx) => {
        const result = await tx`update app.account_balance set debit = debit + 1`;
        return result.count;
      },
    );
    expect(touched).toBe(0);
  });
});

describe("SAH-001 Denormalised currency balances are updated without the tenant key — 1B", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("two tenants posting to the same account code and currency keep separate account_balance rows", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "10.0000" },
      { account: a.sales, credit: "10.0000" },
    ]);
    await postJournal(db, b, [
      { account: b.cash, debit: "99.0000" },
      { account: b.sales, credit: "99.0000" },
    ]);
    const read = async (seed: Seed) =>
      withTenant(
        db.rw,
        { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(db.admin) },
        (tx) => tx<{ debit: string }[]>`select debit::text from app.account_balance
                                         where account_id = ${seed.cash} and currency = 'MYR'`,
      );
    expect(await read(a)).toEqual([{ debit: "10.0000" }]);
    expect(await read(b)).toEqual([{ debit: "99.0000" }]);
  });

  it("the rebuild-and-compare run as Alpha never reads Beta's ledger entries", async () => {
    const found = await withTenant(
      db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => checkAccountBalanceProjection(tx),
    );
    expect(found).toEqual([]);
  });
});

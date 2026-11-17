import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAccountBalanceProjection, withTenant } from "@dulja/db";
import { seedAccount, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("account_balance under concurrency — the pin behind ADR 0024's open question", () => {
  let db: Db;
  let a: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("two posts racing for a BRAND-NEW key leave exactly one row, and a loser fails loudly", async () => {
    const fresh = await seedAccount(db, a, { code: "1960", nameEn: "Cold start", type: "asset" });
    const results = await Promise.allSettled([
      postJournal(db, a, [
        { account: fresh, debit: "11.0000" },
        { account: a.sales, credit: "11.0000" },
      ]),
      postJournal(db, a, [
        { account: fresh, debit: "13.0000" },
        { account: a.sales, credit: "13.0000" },
      ]),
    ]);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    // PostgreSQL's MERGE takes `when not matched then insert` in BOTH sessions for a key that does not
    // yet exist, so one may raise 23505. §4.2.2's withTenant retries only 40P01/40001. Whatever happens,
    // a DUPLICATE ROW must be impossible — that is what LEGACY-049 was, and the primary key forbids it.
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const result of rejected)
      expect(String(result.reason)).toMatch(/23505|duplicate key|ERR_CONFLICT_UNIQUE/);

    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) };
    const [count] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account_balance
       where account_id = ${fresh} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(count!.n).toBe(1);
    expect(await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx))).toEqual([]);
  });
});

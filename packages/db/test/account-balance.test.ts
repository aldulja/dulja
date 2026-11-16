import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, lintSchema } from "../src/lint-schema";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

/** The exact MERGE of contracts §4.3.3, run here directly so the table's shape is proven before the posting
 *  service exists. Task 8 moves this statement into packages/db/src/posting/post.ts unchanged. */
const MERGE_FROM_DOCUMENT = (tenant: string, company: string, doc: string) =>
  [tenant, company, doc] as const;

describe("app.account_balance — contracts §4.3.3 (LEGACY-001, 002, 049)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("is keyed on the full grain — company, account, period and currency (LEGACY-049)", async () => {
    const key = await withTenant(
      db.admin,
      a.tenant,
      a.system,
      (tx) => tx<{ attname: string }[]>`
      select att.attname
        from pg_index i
        join pg_attribute att on att.attrelid = i.indrelid and att.attnum = any (i.indkey)
       where i.indrelid = 'app.account_balance'::regclass and i.indisprimary
       order by att.attnum`,
    );
    expect(key.map((r) => r.attname).toSorted()).toEqual([
      "account_id",
      "company_id",
      "currency",
      "fiscal_period_id",
    ]);
  });

  it("is audit-exempt and has no id column (contracts §3.5.3)", async () => {
    expect(AUDIT_EXEMPT.has("account_balance")).toBe(true);
    const cols = await withTenant(
      db.admin,
      a.tenant,
      a.system,
      (tx) => tx<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account_balance'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain("id");
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "company_id",
        "account_id",
        "fiscal_period_id",
        "currency",
        "debit",
        "credit",
        "base_debit",
        "base_credit",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("accumulates rather than replaces when the same key is merged twice (LEGACY-002)", async () => {
    const merge = (amount: string) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        merge into app.account_balance b
        using (select ${a.tenant}::uuid as tenant_id, ${a.company}::uuid as company_id, ${a.cash}::uuid as account_id,
                      ${a.period}::uuid as fiscal_period_id, 'MYR'::char(3) as currency,
                      ${amount}::numeric as debit, 0::numeric as credit,
                      ${amount}::numeric as base_debit, 0::numeric as base_credit) s
           on b.company_id = s.company_id and b.account_id = s.account_id
          and b.fiscal_period_id = s.fiscal_period_id and b.currency = s.currency
         when matched then update set debit = b.debit + s.debit, credit = b.credit + s.credit,
                                      base_debit = b.base_debit + s.base_debit, base_credit = b.base_credit + s.base_credit,
                                      updated_at = now()
         when not matched then insert (tenant_id, company_id, account_id, fiscal_period_id, currency, debit, credit, base_debit, base_credit)
                               values (s.tenant_id, s.company_id, s.account_id, s.fiscal_period_id, s.currency, s.debit, s.credit, s.base_debit, s.base_credit)`,
      );
    await merge("100.0000");
    await merge("25.5000");
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ debit: string; base_debit: string }[]>`
      select debit, base_debit from app.account_balance where account_id = ${a.cash} and fiscal_period_id = ${a.period}`,
    );
    expect(row!.debit).toBe("125.5000");
    expect(row!.base_debit).toBe("125.5000");
  });

  it("refuses an account from another tenant through the composite FK (LEGACY-035)", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.account_balance (tenant_id, company_id, account_id, fiscal_period_id, currency, debit)
        values (${a.tenant}, ${a.company}, ${b.cash}, ${a.period}, 'MYR', 1.0000)`,
      ),
    ).rejects.toThrow(/account_balance_tenant_id_account_id_fkey/);
  });

  it("a second tenant sees no balances and cannot update one (LEGACY-001)", async () => {
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account_balance`,
    );
    expect(seen[0]!.n).toBe(0);
    const touched = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const r = await tx`update app.account_balance set debit = debit + 1`;
      return r.count;
    });
    expect(touched).toBe(0);
  });

  it("app_rw may not delete a balance row (a projection is rebuilt, never trimmed)", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.account_balance where account_id = ${a.cash}`,
      ),
    ).rejects.toThrow(/permission denied for table account_balance/);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    expect(MERGE_FROM_DOCUMENT(a.tenant, a.company, a.docType)).toHaveLength(3);
  });
});

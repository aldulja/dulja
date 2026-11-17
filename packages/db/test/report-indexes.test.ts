import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listPeriodsAwaitingClose } from "../src/periods/month-end";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, withTenant, type Db } from "./harness";

/** The leading column list of every btree index on a table, in index order. */
async function indexColumns(db: Db, table: string): Promise<Record<string, string[]>> {
  const rows = await db.admin<{ index_name: string; cols: string[] }[]>`
    select i.relname as index_name,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(ix.indkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as cols
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_class t on t.oid = ix.indrelid
      join pg_am am on am.oid = i.relam
     where t.relnamespace = 'app'::regnamespace and t.relname = ${table} and am.amname = 'btree'
     order by 1`;
  return Object.fromEntries(rows.map((row) => [row.index_name, row.cols]));
}

describe("report filter indexes — LEGACY-070, migration 0016", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenant(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("account_balance has an index whose leading columns are exactly the trial-balance filter", async () => {
    expect(
      (await indexColumns(db, "account_balance"))["account_balance_company_period_idx"],
    ).toEqual(["company_id", "fiscal_period_id", "currency"]);
  });

  it("fiscal_period has an index whose leading columns are exactly the month-end scan's filter", async () => {
    expect(
      (await indexColumns(db, "fiscal_period"))["fiscal_period_company_status_ends_idx"],
    ).toEqual(["company_id", "status", "ends_on"]);
  });

  it("document has an index whose leading columns are exactly the period-document filter", async () => {
    expect((await indexColumns(db, "document"))["document_company_period_status_idx"]).toEqual([
      "company_id",
      "fiscal_period_id",
      "status",
    ]);
  });

  it("the month-end scan can be served by an index — with seqscan disabled the planner still finds one", async () => {
    // With enable_seqscan = off Postgres still emits Seq Scan when NO index can serve the predicate
    // (it prices the scan at disable_cost rather than refusing to plan it). A plan free of
    // "Seq Scan on fiscal_period" is therefore evidence that an index covers the filter, and this
    // assertion genuinely fails before 0016.
    const plan = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx<Record<string, string>[]>`
        explain (costs off)
        select p.id from app.fiscal_period p
         where p.company_id = ${s.company} and p.status = 'open' and p.ends_on < '2026-06-01'::date`;
      return rows.map((row) => row["QUERY PLAN"] ?? "").join("\n");
    });
    expect(plan).not.toMatch(/Seq Scan on fiscal_period/);
    expect(plan).toMatch(/fiscal_period_company_status_ends_idx/);
  });

  it("the trial-balance filter can be served by an index", async () => {
    const plan = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = await tx<Record<string, string>[]>`
        explain (costs off)
        select b.account_id from app.account_balance b
         where b.company_id = ${s.company} and b.fiscal_period_id = ${s.period}`;
      return rows.map((row) => row["QUERY PLAN"] ?? "").join("\n");
    });
    expect(plan).not.toMatch(/Seq Scan on account_balance/);
  });

  it("the month-end scan itself still returns the right rows over the new index", async () => {
    const due = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listPeriodsAwaitingClose(tx, { asOf: "2026-06-01" }),
    );
    // 2026-01 open; 2026-02 closed; 2026-03 locked.
    expect(due.map((period) => period.fiscalPeriodId)).toEqual([s.period]);
  });
});

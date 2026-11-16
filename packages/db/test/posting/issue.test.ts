import { grantCodes } from "../fixtures";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import { draftDocument, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "req-issue",
});

describe("issueDocument — contracts §4.3.6 (SAH-051, spec:2222)", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("issues 1 for the first document of a series in a period and 2 for the next", async () => {
    const one = await draftDocument(db, a);
    const two = await draftDocument(db, a);
    const first = await prodWithTenant(db.rw, ctx(a), (tx) =>
      issueDocument(tx, ctx(a), { documentId: one }),
    );
    const second = await prodWithTenant(db.rw, ctx(a), (tx) =>
      issueDocument(tx, ctx(a), { documentId: two }),
    );
    expect(first).toEqual({
      documentId: one,
      series: "JV",
      fiscalPeriodId: a.period,
      number: 1n,
    });
    expect(second.number).toBe(2n);
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string; number: string }[]>`
      select status::text as status, number::text as number from app.document where id in (${one}, ${two}) order by number`,
    );
    expect(rows.map((row) => row.status)).toEqual(["issued", "issued"]);
  });

  it("restarts at 1 in a different period of the same series (spec:1772 'year 2 starts at 1')", async () => {
    const periodId = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
      insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
      values (${periodId}, ${a.tenant}, ${a.company}, '2027-01-01', '2027-01-31', 'open')`,
    );
    const doc = await draftDocument(db, a, { effectiveDate: "2027-01-10", periodId });
    const result = await prodWithTenant(db.rw, ctx(a), (tx) =>
      issueDocument(tx, ctx(a), { documentId: doc }),
    );
    expect(result).toMatchObject({ number: 1n, fiscalPeriodId: periodId });
  });

  it("two connections racing the FIRST document of a new series both succeed, with 1 and 2 (test 16)", async () => {
    const periodId = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
      insert into app.fiscal_period (id, tenant_id, company_id, starts_on, ends_on, status)
      values (${periodId}, ${a.tenant}, ${a.company}, '2028-01-01', '2028-01-31', 'open')`,
    );
    const left = await draftDocument(db, a, { effectiveDate: "2028-01-10", periodId });
    const right = await draftDocument(db, a, { effectiveDate: "2028-01-10", periodId });

    // Two real connections, max: 1 each — the interleaving spec:2266 asks for, not two promises on one pool.
    const one = postgres(db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(db.url("app_rw"), { max: 1, prepare: false });
    try {
      const results = await Promise.all([
        prodWithTenant(one, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: left })),
        prodWithTenant(two, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: right })),
      ]);
      expect(results.map((result) => result.number).toSorted()).toEqual([1n, 2n]);
    } finally {
      await one.end();
      await two.end();
    }
  });

  it("refuses an effective_date that falls in no period", async () => {
    const doc = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
      values (${doc}, ${a.tenant}, ${a.company}, ${a.docType}, 'JV', '2099-06-01', 'MYR', ${a.hq})`,
    );
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_FOUND" });
  });

  it("refuses a closed and a locked period before touching the counter (test 9, API path)", async () => {
    for (const [periodId, label] of [
      [a.closedPeriod, "2026-02-15"],
      [a.lockedPeriod, "2026-03-15"],
    ] as const) {
      const doc = await draftDocument(db, a, { effectiveDate: label, periodId });
      await expect(
        prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
      ).rejects.toMatchObject({ code: "ERR_PERIOD_NOT_OPEN" });
    }
    const [counter] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_series where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`,
    );
    expect(counter!.n).toBe(0);
  });

  it("refuses to issue a document that is already issued", async () => {
    const doc = await draftDocument(db, a);
    await prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc }));
    await expect(
      prodWithTenant(db.rw, ctx(a), (tx) => issueDocument(tx, ctx(a), { documentId: doc })),
    ).rejects.toMatchObject({ code: "ERR_DOC_STATUS_ILLEGAL" });
  });

  it("a rolled-back issue consumes no number (spec:1744)", async () => {
    const doomed = await draftDocument(db, a);
    const next = await draftDocument(db, a);
    const before = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ next_number: string }[]>`
      select next_number::text as next_number from app.document_series
       where company_id = ${a.company} and series = 'JV' and fiscal_period_id = ${a.period}`,
    );
    await expect(
      prodWithTenant(db.rw, ctx(a), async (tx) => {
        await issueDocument(tx, ctx(a), { documentId: doomed });
        throw new Error("caller aborts after issuing");
      }),
    ).rejects.toThrow("caller aborts after issuing");
    const issued = await prodWithTenant(db.rw, ctx(a), (tx) =>
      issueDocument(tx, ctx(a), { documentId: next }),
    );
    expect(issued.number).toBe(BigInt(before[0]!.next_number));
  });
});

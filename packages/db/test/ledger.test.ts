import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { draftDocument, seedCurrency, seedTenant, type Seed } from "./fixtures";
import { startDb, type Db, withTenant } from "./harness";

interface Line {
  account: string;
  debit?: string;
  credit?: string;
  currency?: string;
  rate?: string;
}

async function post(
  tx: Sql,
  seed: Seed,
  documentId: string,
  lines: Line[],
  periodId = seed.period,
  // Inside `periodId`: 0107 refuses a line dated outside the period it names (ERR_PERIOD_NOT_FOUND) before
  // assert_period_open ever looks at the period's status.
  effectiveDate = "2026-01-15",
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const rate = line.rate ?? "1";
    await tx`insert into app.ledger_entry
      (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit,
       effective_date, fiscal_period_id, posting_policy_id)
      values (${seed.tenant}, ${seed.company}, ${documentId}, ${index + 1}, ${line.account}, ${line.debit ?? "0"}, ${line.credit ?? "0"}, ${line.currency ?? "MYR"}, ${rate},
              round(${line.debit ?? "0"}::numeric * ${rate}::numeric, 4), round(${line.credit ?? "0"}::numeric * ${rate}::numeric, 4),
              ${effectiveDate}, ${periodId}, ${seed.policy})`;
  }
}

describe("the ledger — spec §3.8 (LEGACY-003, 012, 031, 041, 042, 044)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => db.stop());

  it("a balanced two-line journal commits and carries posted_by from the session", async () => {
    const documentId = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      post(tx, a, documentId, [
        { account: a.cash, debit: "100.0000" },
        { account: a.sales, credit: "100.0000" },
      ]),
    );
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ posted_by: string; base_debit: string }[]>`
      select posted_by, base_debit from app.ledger_entry where document_id = ${documentId} order by line_no`,
    );
    expect(rows.map((row) => row.posted_by)).toEqual([a.human, a.human]);
    expect(rows[0]!.base_debit).toBe("100.0000");
  });

  it("an unbalanced document is rejected at commit and leaves no rows", async () => {
    const documentId = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        post(tx, a, documentId, [
          { account: a.cash, debit: "100" },
          { account: a.sales, credit: "90" },
        ]),
      ),
    ).rejects.toThrow(/ERR_LEDGER_UNBALANCED/);
    const [count] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { n: number }[]
        >`select count(*)::int as n from app.ledger_entry where document_id = ${documentId}`,
    );
    expect(count!.n).toBe(0);
  });

  it("balance is checked in base currency", async () => {
    // 0008 made ledger_entry.currency a foreign key, and seedTenant defines only the tenant's own MYR, so the
    // foreign currency this case is about has to be defined first. Seeded here rather than upserted inside
    // `post`: contracts §4.1 names that helper as the reference insert the posting service must reproduce, and
    // the posting service must never conjure a currency — refusing an undefined code is what 0008 is for.
    // fixtures.ts:45 already designates seedCurrency as how a test asks for a second currency.
    await seedCurrency(db, a, { code: "EUR" });
    const documentId = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      post(tx, a, documentId, [
        { account: a.cash, debit: "100", currency: "EUR", rate: "4.85" },
        { account: a.sales, credit: "100", currency: "EUR", rate: "4.85" },
      ]),
    );
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { base: string }[]
        >`select base_debit as base from app.ledger_entry where document_id = ${documentId} and line_no = 1`,
    );
    expect(row!.base).toBe("485.0000");
  });

  it("rejects a hand-typed base amount that is not value times rate", async () => {
    const documentId = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit, currency, exchange_rate, base_debit, base_credit, effective_date, fiscal_period_id, posting_policy_id) values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 100, 0, 'USD', 4.2, 500, 0, '2026-01-15', ${a.period}, ${a.policy})`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects a line with both debit and credit", async () => {
    const documentId = await draftDocument(db, a);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        post(tx, a, documentId, [{ account: a.cash, debit: "5", credit: "5" }]),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses closed and locked periods on ledger lines", async () => {
    for (const periodId of [a.closedPeriod, a.lockedPeriod]) {
      const effectiveDate = periodId === a.closedPeriod ? "2026-02-10" : "2026-03-10";
      const documentId = await draftDocument(db, a, { periodId, effectiveDate });
      await expect(
        withTenant(db.rw, a.tenant, a.human, (tx) =>
          post(
            tx,
            a,
            documentId,
            [
              { account: a.cash, debit: "1" },
              { account: a.sales, credit: "1" },
            ],
            periodId,
            effectiveDate,
          ),
        ),
      ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
    }
  });

  it("ledger entries cannot be updated or deleted", async () => {
    const documentId = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      post(tx, a, documentId, [
        { account: a.cash, debit: "10" },
        { account: a.sales, credit: "10" },
      ]),
    );
    await expect(
      withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) =>
          tx`update app.ledger_entry set debit = 11 where document_id = ${documentId} and line_no = 1`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(
      withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx`delete from app.ledger_entry where document_id = ${documentId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`update app.ledger_entry set debit = 11 where document_id = ${documentId} and line_no = 1`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("an entry cannot reference another tenant's account", async () => {
    const documentId = await draftDocument(db, b);
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) =>
        post(
          tx,
          b,
          documentId,
          [
            { account: a.cash, debit: "1" },
            { account: b.sales, credit: "1" },
          ],
          b.period,
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

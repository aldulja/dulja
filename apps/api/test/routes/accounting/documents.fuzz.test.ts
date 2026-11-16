import fc from "fast-check";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument, withTenant } from "@dulja/db";
import { grantCodes, seedAccount, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

/** A generated integer amount is in ten-thousandths; the wire wants a fixed-4-dp decimal string. */
const cents = (value: number) => (value / 10_000).toFixed(4);

describe("acceptance test 1 — the ledger invariant under fuzz (spec:2419, LEGACY-003)", () => {
  let api: StartedApi;
  let a: Seed;
  let accounts: string[];

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Fuzz");
    await grantCodes(api.db, a, { codes: ["accounting.journal.post"] });
    accounts = [a.cash, a.sales];
    for (const [code, name, type] of [
      ["1100", "Bank", "asset"],
      ["1300", "Inventory control", "asset"],
      ["2100", "Trade payables", "liability"],
    ] as const) {
      accounts.push(await seedAccount(api.db, a, { code, nameEn: name, type }));
    }
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'fuzz', 'Fuzz')`;
      for (const code of ["accounting.journal.create", "accounting.journal.post"]) {
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.tenant}, ${roleId}, ${code})`;
      }
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  /** A balanced document: n debit legs and m credit legs whose totals agree to the cent in the document
   *  currency. The generator produces the SHAPE; the ledger invariant is the property. */
  const balanced = fc
    .record({
      debits: fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 6 }),
      creditSplit: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 6 }),
      accountPicks: fc.array(fc.nat({ max: 4 }), { minLength: 12, maxLength: 12 }),
    })
    .map(({ debits, creditSplit, accountPicks }) => {
      const total = debits.reduce((left, right) => left + right, 0);
      const weight = creditSplit.reduce((left, right) => left + right, 0);
      const credits: number[] = creditSplit.map((share) => Math.floor((total * share) / weight));
      // The residue lands on the first leg.
      credits[0]! += total - credits.reduce((left, right) => left + right, 0);
      return { debits, credits: credits.filter((amount) => amount > 0), accountPicks };
    })
    .filter((document) => document.credits.length > 0);

  it("every balanced document either posts with Σdebit = Σcredit, or is refused — never a wrong number", async () => {
    await fc.assert(
      fc.asyncProperty(balanced, async ({ debits, credits, accountPicks }) => {
        const lines = [
          ...debits.map((value, index) => ({
            lineNo: index + 1,
            accountId: accounts[accountPicks[index]! % accounts.length]!,
            debit: cents(value),
          })),
          ...credits.map((value, index) => ({
            lineNo: debits.length + index + 1,
            accountId: accounts[accountPicks[6 + index]! % accounts.length]!,
            credit: cents(value),
          })),
        ];
        const created = await api.request({
          method: "POST",
          path: `/v1/companies/${a.company}/documents`,
          as: a.human,
          body: {
            documentTypeCode: "JOURNAL",
            effectiveDate: "2026-01-15",
            currency: "MYR",
            branchId: a.hq,
            lines,
          },
        });
        // A refusal is never a wrong number.
        if (created.status !== 201) return true;
        const { id } = (await created.json()) as { id: string };
        const posted = await api.request({
          method: "POST",
          path: `/v1/companies/${a.company}/documents/${id}/transitions`,
          as: a.human,
          body: { to: "posted" },
        });
        if (posted.status !== 200) return true;

        const [sums] = await withTenant(
          api.db.rw,
          { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" },
          (tx) => tx<{ diff: string; base_diff: string }[]>`
            select (sum(debit) - sum(credit))::text as diff, (sum(base_debit) - sum(base_credit))::text as base_diff
              from app.ledger_entry where document_id = ${id}`,
        );
        expect(sums!.diff).toBe("0.0000");
        expect(sums!.base_diff).toBe("0.0000");
        return true;
      }),
      { numRuns: 250 },
    );
  }, 600_000);

  it("Σdebit = Σcredit holds for the tenant, the company and every period after the whole run (spec:2419)", async () => {
    const rows = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" },
      (tx) => tx<{ fiscal_period_id: string; diff: string }[]>`
      select fiscal_period_id, (sum(base_debit) - sum(base_credit))::text as diff
        from app.ledger_entry where company_id = ${a.company} group by fiscal_period_id`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.diff).toBe("0.0000");
  });

  it("every account_balance row still equals the sum of its ledger entries", async () => {
    const [mismatch] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "fuzz" },
      (tx) => tx<{ n: number }[]>`
      with rebuilt as (
        select company_id, account_id, fiscal_period_id, currency,
               sum(debit) as debit, sum(credit) as credit, sum(base_debit) as base_debit, sum(base_credit) as base_credit
          from app.ledger_entry group by 1, 2, 3, 4)
      select count(*)::int as n
        from rebuilt r full outer join app.account_balance b
          on b.company_id = r.company_id and b.account_id = r.account_id
         and b.fiscal_period_id = r.fiscal_period_id and b.currency = r.currency
       where r.company_id is null or b.company_id is null
          or b.debit <> r.debit or b.credit <> r.credit or b.base_debit <> r.base_debit or b.base_credit <> r.base_credit`,
    );
    expect(mismatch!.n).toBe(0);
  });
});

describe("acceptance test 4 — two tenants post to the same account and currency concurrently (spec:2422)", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    await grantCodes(api.db, a, { codes: ["accounting.journal.post"] });
    b = await seedTenantV2(api.db, "Beta");
    await grantCodes(api.db, b, { codes: ["accounting.journal.post"] });
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("each sees only its own balance, and neither loses an amount (LEGACY-001, LEGACY-035, LEGACY-049)", async () => {
    const draft = async (seed: Seed, amount: string): Promise<string> => {
      const id = await uuidv7(api.db.admin);
      await withTenant(
        api.db.rw,
        { tenantId: seed.tenant, actorId: seed.human, requestId: "seed" },
        async (tx) => {
          await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                     values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
          await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                     values (${seed.tenant}, ${seed.company}, ${id}, 1, ${seed.cash}, ${amount})`;
          await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                     values (${seed.tenant}, ${seed.company}, ${id}, 2, ${seed.sales}, ${amount})`;
        },
      );
      return id;
    };
    const docA = await draft(a, "111.0000");
    const docB = await draft(b, "222.0000");

    // Two real connections interleaved, max: 1 each — the shape spec:2266 asks for.
    const one = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    const two = postgres(api.db.url("app_rw"), { max: 1, prepare: false });
    const ctxA = { tenantId: a.tenant, actorId: a.human, requestId: "race-a" };
    const ctxB = { tenantId: b.tenant, actorId: b.human, requestId: "race-b" };
    try {
      await Promise.all([
        withTenant(one, ctxA, (tx) => postDocument(tx, ctxA, { documentId: docA })),
        withTenant(two, ctxB, (tx) => postDocument(tx, ctxB, { documentId: docB })),
      ]);
    } finally {
      await one.end();
      await two.end();
    }

    for (const [seed, expected] of [
      [a, "111.0000"],
      [b, "222.0000"],
    ] as const) {
      const rows = await withTenant(
        api.db.rw,
        { tenantId: seed.tenant, actorId: seed.human, requestId: "check" },
        (tx) => tx<{ account_id: string; debit: string }[]>`
          select account_id::text as account_id, debit::text as debit from app.account_balance where currency = 'MYR'`,
      );
      // Exactly its own cash and sales rows.
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.account_id === seed.cash)!.debit).toBe(expected);
    }
  }, 120_000);
});

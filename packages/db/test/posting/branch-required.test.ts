import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { withTenant } from "../../src/with-tenant";
import { grantCodes, seedDocumentType, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, type Db } from "../harness";

const withBranchSource = (from: string[]) => ({
  version: 1,
  documentType: "POLICY_TEST",
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1000" },
      amount: "line.amount",
      dimensions: { from },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "4000" },
      amount: "line.amount",
      dimensions: { from },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "PT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "POLICY_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
});

/** contracts §6.2 row spec:1066 — owned by 2A. 8B re-runs the same refusal on PAYROLL (test 28). */
describe("BRANCH is mandatory on a policy that requires it — spec:1066, F-9", () => {
  let db: Db;
  let a: Seed;

  const ctx = async () => ({
    tenantId: a.tenant,
    actorId: a.human,
    requestId: await uuidv7(db.admin),
  });

  const typeId = async (): Promise<string> => {
    const [type] = await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${a.company} and code = 'POLICY_TEST'`,
    );
    return type!.id;
  };

  const draftAndPost = async (documentTypeId: string, effectiveDate: string): Promise<string> => {
    const c = await ctx();
    return withTenant(db.rw, c, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                          effective_date, currency, branch_id)
               values (${id}, ${a.tenant}, ${a.company}, ${documentTypeId}, 'PT', ${a.period}, ${effectiveDate}::date, 'MYR', ${a.hq})`;
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, kind, amount)
               values (${await uuidv7(db.admin)}, ${a.tenant}, ${a.company}, ${id}, 1, 'item', '25.0000')`;
      await postDocument(tx, c, { documentId: id });
      return id;
    });
  };

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
    // v1 takes the header's branch; v2, effective later, opts out of it. Both live on one type, which also
    // exercises resolvePolicy's "greatest effective_from <= effective_date" (contracts §4.3.1).
    await seedDocumentType(db, a, {
      code: "POLICY_TEST",
      policyVersion: 1,
      effectiveFrom: "2026-01-01",
      policy: withBranchSource(["line.dimensions", "document.branch"]),
    });
    await seedDocumentType(db, a, {
      code: "POLICY_TEST",
      policyVersion: 2,
      effectiveFrom: "2026-01-20",
      policy: withBranchSource(["line.dimensions"]),
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("posts when the policy's dimension sources include document.branch", async () => {
    const doc = await draftAndPost(await typeId(), "2026-01-15");
    const rows = await withTenant(
      db.rw,
      await ctx(),
      // app.ledger_entry_dimension is (tenant_id, entry_id, dimension_type_id, dimension_value_id) with
      // primary key (entry_id, dimension_type_id) — plan0A:2041-2046. The join column is `entry_id`; there
      // is no `ledger_entry_id`, and naming one would fail with `column d.ledger_entry_id does not exist`
      // rather than with a wrong answer.
      (tx) => tx<{ dimension_value_id: string }[]>`
        select d.dimension_value_id from app.ledger_entry_dimension d
          join app.ledger_entry l on l.id = d.entry_id
         where l.document_id = ${doc}`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dimension_value_id === a.hq)).toBe(true);
  });

  it("refuses, before any ledger row is written, when a rule opts out of document.branch", async () => {
    await expect(draftAndPost(await typeId(), "2026-01-25")).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING.*BRANCH/s,
    );
    const [count] = await withTenant(
      db.rw,
      await ctx(),
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.ledger_entry
         where fiscal_period_id = ${a.period} and effective_date = '2026-01-25'`,
    );
    expect(count!.n).toBe(0);
  });

  it("the refusal names the dimension and the document type, so an operator can fix the policy", async () => {
    await expect(draftAndPost(await typeId(), "2026-01-25")).rejects.toThrow(
      /dimension BRANCH is required by POLICY_TEST and planned line 1 carries none/,
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAccountBalanceProjection,
  postDocument,
  reverseDocument,
  withTenant,
} from "@dulja/db";
import {
  grantCodes,
  type Db,
  type Seed,
  seedAccount,
  seedTenantV2,
  startDb,
  uuidv7,
} from "@dulja/db/test";
import { sharedDb } from "../support/regression";
import { postJournal } from "../invariants/support/post-journal";

describe("LEGACY-002 Upsert never fires on UPDATE; re-keying destroys the amount — 1A", () => {
  it("re-keying a posting by reversal leaves sum(account_balance) equal to sum(ledger_entry) (test 3)", async () => {
    const { db, rw } = await sharedDb();
    const seed = await seedTenantV2(db, "LEGACY002");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy002" };
    const wrong = await seedAccount(db, seed, { code: "1100", nameEn: "Bank", type: "asset" });
    const right = await seedAccount(db, seed, {
      code: "1300",
      nameEn: "Inventory control",
      type: "asset",
    });
    const draft = async (account: string): Promise<string> => {
      const id = await uuidv7(db.admin);
      await withTenant(rw, ctx, async (tx) => {
        await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
                 values (${id}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 1, ${account}, 250.0000)`;
        await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
                 values (${seed.tenant}, ${seed.company}, ${id}, 2, ${seed.sales}, 250.0000)`;
      });
      return id;
    };
    const first = await draft(wrong);
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: first }));
    await withTenant(rw, ctx, (tx) =>
      reverseDocument(tx, ctx, {
        documentId: first,
        effectiveDate: "2026-01-16",
        reason: "re-key",
      }),
    );
    const second = await draft(right);
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: second }));

    const [net] = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ wrong: string; right: string }[]>`
      select coalesce(max(case when account_id = ${wrong} then base_debit - base_credit end), 0)::text as wrong,
             coalesce(max(case when account_id = ${right} then base_debit - base_credit end), 0)::text as right
        from app.account_balance where fiscal_period_id = ${seed.period} and currency = 'MYR'`,
    );
    expect(net!.wrong).toBe("0.0000");
    expect(net!.right).toBe("250.0000");
  });
});

describe("LEGACY-002 The upsert never fires on UPDATE, so re-keying a posting destroys the amount — 1B", () => {
  let db: Db;
  let a: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("a second post to the same (company, account, period, currency) ADDS through the MERGE's matched branch", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "60.0000" },
      { account: a.sales, credit: "60.0000" },
    ]);
    await postJournal(db, a, [
      { account: a.cash, debit: "15.0000" },
      { account: a.sales, credit: "15.0000" },
    ]);
    const [row] = await withTenant(
      db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: await uuidv7(db.admin) },
      (tx) => tx<{ debit: string }[]>`select debit::text from app.account_balance
                                       where account_id = ${a.cash} and fiscal_period_id = ${a.period} and currency = 'MYR'`,
    );
    expect(row).toEqual({ debit: "75.0000" });
  });

  it("an amount that drifts from the ledger is detected instead of surviving silently", async () => {
    const ctx = {
      tenantId: a.tenant,
      actorId: a.human,
      requestId: await uuidv7(db.admin),
    };
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`update app.account_balance set debit = 0 where account_id = ${a.cash}`,
    );
    const found = await withTenant(db.rw, ctx, (tx) => checkAccountBalanceProjection(tx));
    expect(found.map((mismatch) => mismatch.side)).toContain("amount_differs");
  });
});

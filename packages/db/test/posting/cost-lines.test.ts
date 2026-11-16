import { afterAll, beforeAll, describe, expect, it } from "vitest";
// `loadSnapshot` comes from the RELATIVE barrel beside `postDocument`, never from `@dulja/db`: 0B's
// `dependency-rule` pins `"packages/db": ["@dulja/domain"]` and finds a file's owner by the path prefix
// `packages/db/` with no `test/` exclusion, so a self-import is a violation here — and a dynamic
// `await import("@dulja/db")` merely escapes the rule's IMPORT regex rather than satisfying it.
import { loadSnapshot, postDocument } from "../../src/posting";
import { withTenant as prodWithTenant } from "../../src/with-tenant";
import {
  grantCodes,
  seedAccount,
  seedCurrency,
  seedDocumentType,
  seedRate,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/**
 * A policy with no inventory effect whose two legs both address `line.cost`. This is the shape a sales
 * policy's COGS/inventory pair has, minus the movements — so it exercises the currency and rate of a cost
 * line without needing applyMovements, which Task 6 adds.
 */
const COST_ONLY_POLICY = (cogsCode: string, inventoryCode: string) => ({
  version: 1,
  documentType: "POLICY_TEST",
  direction: "internal",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: cogsCode },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: inventoryCode },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "PT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "POLICY_TEST" },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
});

describe("a cost line is a base-currency amount at rate 1 (amendment A4; contracts §4.7.3)", () => {
  let db: Db;
  let s: Seed;
  let typeId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "CostLines");
    await grantCodes(db, s, {
      codes: ["accounting.journal.post", "accounting.journal.create"],
    });
    await seedAccount(db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
    await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    await seedCurrency(db, s, { code: "USD" });
    await seedRate(db, s, { from: "USD", to: "MYR", on: "2026-01-01", rate: "4.68000000" });
    typeId = await seedDocumentType(db, s, {
      code: "POLICY_TEST",
      policy: COST_ONLY_POLICY("5000", "1300"),
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  /** A USD document with one item line whose cost is already computed — MYR 468.0000 of goods. */
  const usdDocumentWithCost = async (on: string, rate: string): Promise<string> => {
    const documentId = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id, effective_date, currency, exchange_rate, branch_id)
               values (${documentId}, ${s.tenant}, ${s.company}, ${typeId}, 'PT', ${s.period}, ${on}::date, 'USD', ${rate}, ${s.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, amount, cost)
               values (${s.tenant}, ${s.company}, ${documentId}, 1, 'item', '100.0000', '468.0000')`;
    });
    return documentId;
  };

  it("the cost legs are written in MYR at rate 1, and the document still balances in base", async () => {
    const documentId = await usdDocumentWithCost("2026-01-15", "4.68000000");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));

    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        {
          code: string;
          currency: string;
          exchange_rate: string;
          debit: string;
          credit: string;
          base_debit: string;
          base_credit: string;
        }[]
      >`
      select a.code, l.currency, l.exchange_rate::text, l.debit::text, l.credit::text,
             l.base_debit::text, l.base_credit::text
        from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} order by a.code`,
    );

    expect(rows).toEqual([
      {
        code: "1300",
        currency: "MYR",
        exchange_rate: "1.00000000",
        debit: "0.0000",
        credit: "468.0000",
        base_debit: "0.0000",
        base_credit: "468.0000",
      },
      {
        code: "5000",
        currency: "MYR",
        exchange_rate: "1.00000000",
        debit: "468.0000",
        credit: "0.0000",
        base_debit: "468.0000",
        base_credit: "0.0000",
      },
    ]);
  });

  it("the base COGS does not move when the document's exchange rate does", async () => {
    // The same goods, the same MYR 468.0000 cost, a document at a different USD rate. If the cost were
    // converted at the header rate the base figure would differ, and the trial balance would move because
    // of a currency the goods never touched.
    const documentId = await usdDocumentWithCost("2026-01-16", "5.00000000");
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    await prodWithTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId }));

    const [cogs] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ base_debit: string }[]>`
      select l.base_debit::text from app.ledger_entry l join app.account a on a.id = l.account_id
       where l.document_id = ${documentId} and a.code = '5000'`,
    );
    expect(cogs!.base_debit).toBe("468.0000");
  });

  it("loadSnapshot returns the cost in the company's BASE currency", async () => {
    const documentId = await usdDocumentWithCost("2026-01-17", "4.68000000");
    const snapshot = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      loadSnapshot(tx, documentId),
    );
    expect(snapshot.header.currency).toBe("USD");
    expect(snapshot.lines[0]!.cost!.currency).toBe("MYR");
    expect(snapshot.lines[0]!.cost!.toString()).toBe("468.0000");
    expect(snapshot.lines[0]!.amount.currency).toBe("USD");
  });
});

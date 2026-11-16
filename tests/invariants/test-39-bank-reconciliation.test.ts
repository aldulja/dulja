import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  importStatement,
  listStatementLines,
  match,
  reconciledBalance,
  unmatch,
  unmatchedStatementLines,
  withTenant,
} from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { arApFixture, postFromPack, type ArApFixture } from "./support/ar-ap";

/**
 * Acceptance test 39 (spec:2457) — "A month's statement import matches every receipt, payment, payroll batch
 * and till banking or lists it as unreconciled; matching never alters a ledger entry; the reconciled balance
 * equals the bank account's ledger balance." Phase 4's half: receipts and payments. The till-banking and
 * payroll-batch clauses are 6D's and 8C's; clause 6 proves the seam they plug into is already open.
 *
 * A RECEIPT or PAYMENT is ONE bank line posted against the party's control account (4A's pack policies), so
 * `post` names the bank account and the amount only.
 */
const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: ArApFixture;
let bank: string;
let ids: { receipt1: string; receipt2: string; payment1: string; payment2: string };
let statementId: string;

const ctxFor = async () => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: await uuidv7(db.admin),
});

/** A sha256 over every ledger_entry column that could be tampered with, in a fixed order (LEGACY-031, LEGACY-041).
 *  `sha256(bytea)` is core PostgreSQL; `convert_to` is required because there is no implicit text → bytea. */
const ledgerFingerprint = async (): Promise<string> =>
  withTenant(db.rw, await ctxFor(), async (tx) => {
    const [row] = await tx<{ h: string; n: number }[]>`
      select coalesce(encode(sha256(convert_to(string_agg(t, '|' order by t), 'UTF8')), 'hex'), '') as h,
             count(*)::int as n
        from (select concat_ws(':', id::text, document_id::text, line_no::text, account_id::text,
                               debit::text, credit::text, currency, exchange_rate::text,
                               base_debit::text, base_credit::text, effective_date::text,
                               fiscal_period_id::text, posting_policy_id::text, posted_by::text) as t
                from app.ledger_entry where company_id = ${s.company}) x`;
    expect(row!.n).toBe(8); // four documents, two legs each — the fingerprint is over real rows
    return row!.h;
  });

const balanceAt = async (asOf: string) =>
  withTenant(db.rw, await ctxFor(), (tx) =>
    reconciledBalance(tx, { companyId: s.company, bankAccountId: bank, asOf }),
  );

const statementLines = async () =>
  withTenant(db.rw, await ctxFor(), (tx) =>
    listStatementLines(tx, { companyId: s.company, statementId, limit: 10 }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "test39");
  f = await arApFixture(db, s);
  bank = f.accountIds["1100"]!;
  const post = async (code: "RECEIPT" | "PAYMENT", effectiveDate: string, amount: string) =>
    (
      await postFromPack(db, s, {
        code,
        effectiveDate,
        partyId: code === "RECEIPT" ? f.partyIds.customer : f.partyIds.vendor,
        lines: [{ kind: "account", accountId: bank, amount }],
      })
    ).documentId;
  ids = {
    receipt1: await post("RECEIPT", "2026-01-03", "1200.0000"),
    payment1: await post("PAYMENT", "2026-01-09", "500.0000"),
    receipt2: await post("RECEIPT", "2026-01-17", "800.0000"),
    payment2: await post("PAYMENT", "2026-01-24", "300.0000"),
  };
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("acceptance test 39 — bank reconciliation (spec:2457; LEGACY-031, LEGACY-041, RC-2)", () => {
  let before = "";

  it("1. a month's statement imports and adds up", async () => {
    before = await ledgerFingerprint();
    const ctx = await ctxFor();
    ({ statementId } = await withTenant(db.rw, ctx, (tx) =>
      importStatement(tx, ctx, {
        companyId: s.company,
        bankAccountId: bank,
        csv: [
          "Date,Narrative,Ref,Amount",
          "2026-01-03,RECEIPT CUST-1,R1,1200.00",
          "2026-01-09,PAYMENT VEND-1,P1,-500.00",
          "2026-01-17,RECEIPT CUST-1,R2,800.00",
          "2026-01-24,PAYMENT VEND-1,P2,-300.00",
        ].join("\n"),
        mapping: {
          statement: {
            statementDate: "2026-01-31",
            openingBalance: "0.0000",
            closingBalance: "1200.0000",
          },
          columns: {
            valueDate: "Date",
            description: "Narrative",
            reference: "Ref",
            amount: "Amount",
          },
          dateFormat: "YYYY-MM-DD",
          hasHeader: true,
        },
      }),
    ));
    expect((await statementLines()).map((l) => l.amount)).toEqual([
      "1200.0000",
      "-500.0000",
      "800.0000",
      "-300.0000",
    ]);
  });

  it("2. every receipt and payment matches, or is listed as unreconciled — one is left open on purpose", async () => {
    // Before any match, all four documents are unreconciled and all four lines are open.
    const unmatched = await balanceAt("2026-01-31");
    expect(unmatched.unreconciled.map((r) => r.documentId).toSorted()).toEqual(
      Object.values(ids).toSorted(),
    );

    const lines = await statementLines();
    const pairs: [string, "receipt" | "payment", string][] = [
      [lines[0]!.id, "receipt", ids.receipt1],
      [lines[1]!.id, "payment", ids.payment1],
      [lines[2]!.id, "receipt", ids.receipt2],
      // lines[3] (payment2, −300) is deliberately NOT matched yet.
    ];
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, async (tx) => {
      for (const [lineId, kind, documentId] of pairs) {
        const [amount] = await tx<{ a: string }[]>`
          select abs(amount)::text as a from app.bank_statement_line where id = ${lineId}`;
        await match(tx, ctx, {
          companyId: s.company,
          statementLineId: lineId,
          reconcilable: { kind, documentId },
          amount: Money.of(amount!.a, MYR),
        });
      }
    });

    const result = await balanceAt("2026-01-31");
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([ids.payment2]);
    const open = await withTenant(db.rw, await ctxFor(), (tx) =>
      unmatchedStatementLines(tx, {
        companyId: s.company,
        bankAccountId: bank,
        asOf: "2026-01-31",
      }),
    );
    expect(open.map((l) => l.amount)).toEqual(["-300.0000"]);
  });

  it("3. once every item is matched, the reconciled balance EQUALS the bank account's ledger balance", async () => {
    const lines = await statementLines();
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, (tx) =>
      match(tx, ctx, {
        companyId: s.company,
        statementLineId: lines[3]!.id,
        reconcilable: { kind: "payment", documentId: ids.payment2 },
        amount: Money.of("300.0000", MYR),
      }),
    );

    const result = await balanceAt("2026-01-31");
    expect(result.unreconciled).toEqual([]);
    const open = await withTenant(db.rw, await ctxFor(), (tx) =>
      unmatchedStatementLines(tx, {
        companyId: s.company,
        bankAccountId: bank,
        asOf: "2026-01-31",
      }),
    );
    expect(open).toEqual([]);
    expect(result.statement.toString()).toBe("1200.0000");
    expect(result.ledger.toString()).toBe("1200.0000"); // 1200 − 500 + 800 − 300
    expect(result.statement.equals(result.ledger)).toBe(true); // the DoD sentence
  });

  it("4. matching NEVER altered a ledger entry — the fingerprint is byte-identical (LEGACY-031, LEGACY-041)", async () => {
    expect(await ledgerFingerprint()).toBe(before);
  });

  it("5. an unmatch reopens the item, and the ledger is still byte-identical", async () => {
    const [row] = await withTenant(
      db.rw,
      await ctxFor(),
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_match
         where unmatched_at is null and reconcilable_document_id = ${ids.payment2}`,
    );
    const ctx = await ctxFor();
    await withTenant(db.rw, ctx, (tx) =>
      unmatch(tx, ctx, { companyId: s.company, matchId: row!.id, reason: "test 39 clause 5" }),
    );
    const result = await balanceAt("2026-01-31");
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([ids.payment2]);
    // The row survives its own reversal (spec:2049): four matches, one of them unmatched.
    const [n] = await withTenant(
      db.rw,
      await ctxFor(),
      (tx) => tx<{ total: number; live: number }[]>`
        select count(*)::int as total, count(*) filter (where unmatched_at is null)::int as live
          from app.bank_match where company_id = ${s.company}`,
    );
    expect(n).toEqual({ total: 4, live: 3 });
    expect(await ledgerFingerprint()).toBe(before);
  });

  it("6. the till-banking and payroll-batch clauses are 6D's and 8C's, and the seam is already open", async () => {
    // 6D and 8C each add ONE registerReconcilableSource call and edit no file of this slice; the
    // reconcilable_kind CHECK already admits both labels (§4.8.3, F-5).
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_kind_check'`;
    expect(chk!.def).toContain("'till_banking'");
    expect(chk!.def).toContain("'payroll_batch'");
  });
});

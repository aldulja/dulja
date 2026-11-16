import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  RECONCILABLE_DIRECTION,
  importStatement,
  lintSchema,
  listApplied,
  listStatementLines,
  match,
  reconcilableSources,
  reconciledBalance,
  registerReconcilableSource,
  reverseDocument,
  unmatch,
  unmatchedStatementLines,
  withTenant as prodWithTenant,
  type CsvMapping,
} from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedAccount, seedCurrency, seedRate, seedTenantV2, type Seed } from "../fixtures";
import {
  arApFixture,
  postFromPack,
  type ArApFixture,
} from "../../../../tests/invariants/support/ar-ap";

/**
 * 4B Task 7 — migration 0050 and the matching half of `reconciliation.ts` (contracts §4.8.3, ADR 0048).
 *
 * Every document is posted through 4A's REAL pack envelopes (`postFromPack` reads `RECEIPT.json` and
 * `PAYMENT.json` off disk). Their policies take ONE account line carrying the amount and derive the
 * control-account leg from the party, so a line here names the bank account only; the plan's two-line
 * debit/credit form would post both legs against the party (Task 3's `ageing.test.ts` records the same).
 *
 * Every service call names the company: RLS bounds the tenant and nothing else (AGENTS.md's endpoint rule),
 * so `match`, `unmatch`, `reconciledBalance` and `unmatchedStatementLines` take a required `companyId`
 * exactly as Task 6's `listStatementLines` does.
 */
const MYR = currency("MYR");
let db: Db;
let s: Seed;
let other: Seed;
let f: ArApFixture;
let ctx: { tenantId: string; actorId: string; requestId: string };
let bank: string;
let receiptId: string;
let paymentId: string;
let statementId: string;
let lines: Awaited<ReturnType<typeof listStatementLines>>;

/** One account line of a RECEIPT or PAYMENT: the bank account the pack policy posts against the party. */
const bankLine = (amount: string, accountId = bank) => ({
  kind: "account" as const,
  accountId,
  amount,
});

const SIGNED: CsvMapping["columns"] = {
  valueDate: "Date",
  description: "Narrative",
  reference: "Ref",
  amount: "Amount",
};

/** Imports one signed-amount statement into `bankAccountId`. */
const importRows = (
  statementDate: string,
  openingBalance: string,
  closingBalance: string,
  rows: readonly string[],
  bankAccountId = bank,
) =>
  prodWithTenant(db.rw, ctx, (tx) =>
    importStatement(tx, ctx, {
      companyId: s.company,
      bankAccountId,
      csv: ["Date,Narrative,Ref,Amount", ...rows].join("\n"),
      mapping: {
        statement: { statementDate, openingBalance, closingBalance },
        columns: SIGNED,
        dateFormat: "YYYY-MM-DD",
        hasHeader: true,
      },
    }),
  );

const linesOf = (id: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    listStatementLines(tx, { companyId: s.company, statementId: id, limit: 50 }),
  );

const matching = (input: {
  statementLineId: string;
  kind: "receipt" | "payment" | "till_banking" | "payroll_batch";
  documentId: string;
  amount: string;
  ccy?: string;
  companyId?: string;
}) =>
  prodWithTenant(db.rw, ctx, (tx) =>
    match(tx, ctx, {
      companyId: input.companyId ?? s.company,
      statementLineId: input.statementLineId,
      reconcilable: { kind: input.kind, documentId: input.documentId },
      amount: Money.of(input.amount, currency(input.ccy ?? "MYR")),
    }),
  );

const liveMatchOf = async (documentId: string): Promise<string> => {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
      select id from app.bank_match
       where reconcilable_document_id = ${documentId} and unmatched_at is null`,
  );
  return row!.id;
};

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "bankmatch");
  other = await seedTenantV2(db, "bankmatch-other");
  f = await arApFixture(db, s);
  bank = f.accountIds["1100"]!;
  ctx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };

  ({ documentId: receiptId } = await postFromPack(db, s, {
    code: "RECEIPT",
    effectiveDate: "2026-01-05",
    partyId: f.partyIds.customer,
    lines: [bankLine("1000.0000")],
  }));
  ({ documentId: paymentId } = await postFromPack(db, s, {
    code: "PAYMENT",
    effectiveDate: "2026-01-08",
    partyId: f.partyIds.vendor,
    lines: [bankLine("750.0000")],
  }));

  ({ statementId } = await importRows("2026-01-31", "0.0000", "250.0000", [
    "2026-01-05,RECEIPT CUST-1,RCT,1000.00",
    "2026-01-08,PAYMENT VEND-1,PAY,-750.00",
  ]));
  lines = await linesOf(statementId);
}, 300_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0050 — bank_match (§4.8.3)", () => {
  it("applies as version 50 and carries BOTH stamps, the audit trigger and the guard", async () => {
    expect(await listApplied(db.migrator)).toContain(50);
    const triggers = await db.admin<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.bank_match'::regclass and not tgisinternal
       order by tgname`;
    // §4.8.3 names both stamps explicitly; stamp_actor fires on EVERY *_by column that lacks a trigger.
    expect(triggers.map((t) => t.tgname)).toEqual([
      "audit_row",
      "bank_match_guard",
      "stamp_matched_by",
      "stamp_unmatched_by",
    ]);
  });

  it("is tenant-isolated with RLS enabled AND forced (spec:106)", async () => {
    const [rel] = await db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where oid = 'app.bank_match'::regclass`;
    expect(rel).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.admin<{ policyname: string }[]>`
      select policyname from pg_policies where schemaname = 'app' and tablename = 'bank_match'`;
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });

  it("amount is a MAGNITUDE: check (amount > 0)", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_amount_check'`;
    expect(chk!.def).toContain("> (0)");
  });

  it("the kind vocabulary already admits 6D's and 8C's labels", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.bank_match'::regclass and conname = 'bank_match_kind_check'`;
    for (const kind of ["receipt", "payment", "till_banking", "payroll_batch"]) {
      expect(chk!.def).toContain(`'${kind}'`);
    }
  });

  it("app_rw may not DELETE it (spec:2049; §3.5.4 pinned)", async () => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'bank_match'`;
    expect(grants.map((g) => g.privilege_type).toSorted()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("lintSchema reports zero violations after 0050", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});

describe("the Reconcilable registry (§4.8.3, ADR 0048)", () => {
  it("4B registers receipt and payment — §4.8.3 assigns them to 4B, over 4A's two types — and 6D and 8C add theirs", () => {
    // 6D's one `registerReconcilableSource` call (OD-10, answered yes 2026-11-04; `reconciliation-till.ts`) and 8C's
    // (`hr/reconcilable.ts`, round 18 B12) run when the barrel is imported. Each adds a kind and replaces neither of 4B's.
    expect(
      reconcilableSources()
        .map((x) => x.kind)
        .toSorted(),
    ).toEqual(["payment", "payroll_batch", "receipt", "till_banking"]);
  });

  it("directions are declared for all four kinds, including the two nobody has shipped yet", () => {
    expect(RECONCILABLE_DIRECTION).toEqual({
      receipt: "in",
      payment: "out",
      till_banking: "in",
      payroll_batch: "out",
    });
  });

  it("a third source registers without editing this slice's file — the seam 6D and 8C use", () => {
    registerReconcilableSource({
      kind: "till_banking",
      list() {
        return Promise.resolve([]);
      },
    });
    expect(
      reconcilableSources()
        .map((x) => x.kind)
        .toSorted(),
    ).toEqual(["payment", "payroll_batch", "receipt", "till_banking"]);
    // Registering twice under one kind REPLACES the entry (1B's registerProjectionCheck rule).
    registerReconcilableSource({ kind: "till_banking", list: () => Promise.resolve([]) });
    expect(reconcilableSources()).toHaveLength(4);
  });

  it("a source lists from the LEDGER's bank leg, so a receipt banked elsewhere is not listed", async () => {
    const receiptSource = reconcilableSources().find((x) => x.kind === "receipt")!;
    const listing = (bankAccountId: string) =>
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        receiptSource.list(tx, {
          companyId: s.company,
          bankAccountId,
          from: "2026-01-01",
          to: "2026-01-31",
          unmatchedOnly: true,
        }),
      );
    // A second bank account, and a receipt banked into it. The plan named `1200` as "elsewhere", but the
    // receipt's own credit leg is on 1200, so a ledger-leg source DOES list it there; a second bank is the
    // case the sentence means.
    const otherBank = await seedAccount(db, s, { code: "1110", nameEn: "Bank 2", type: "asset" });
    const { documentId: elsewhereId } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-01-12",
      partyId: f.partyIds.customer,
      lines: [bankLine("60.0000", otherBank)],
    });

    expect(
      (await listing(bank)).map((r) => [r.documentId, r.amount.toString(), r.valueDate]),
    ).toEqual([[receiptId, "1000.0000", "2026-01-05"]]);
    expect((await listing(otherBank)).map((r) => [r.documentId, r.amount.toString()])).toEqual([
      [elsewhereId, "60.0000"],
    ]);
    const [item] = await listing(bank);
    expect(item).toMatchObject({ kind: "receipt", bankAccountId: bank });
    expect(item!.reference).toMatch(/^RCT-/);
  });
});

describe("match and unmatch (§4.8.3, ADR 0048)", () => {
  it("matches the receipt to the positive line and the payment to the negative one", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    const outLine = lines.find((l) => l.amount === "-750.0000")!;
    await prodWithTenant(db.rw, ctx, async (tx) => {
      await match(tx, ctx, {
        companyId: s.company,
        statementLineId: inLine.id,
        reconcilable: { kind: "receipt", documentId: receiptId },
        amount: Money.of("1000.0000", MYR),
      });
      await match(tx, ctx, {
        companyId: s.company,
        statementLineId: outLine.id,
        reconcilable: { kind: "payment", documentId: paymentId },
        amount: Money.of("750.0000", MYR),
      });
    });
    const after = await linesOf(statementId);
    expect(after.map((l) => l.matchedAmount)).toEqual(["1000.0000", "750.0000"]);
    // …and Task 6's placeholder filter is live now: a fully matched line is not "unmatched".
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, unmatchedOnly: true, limit: 50 }),
    );
    expect(open).toEqual([]);
  });

  it("stamps matched_by with the actor, never a parameter (LEGACY-044)", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ matched_by: string; company_id: string }[]>`
        select matched_by::text, company_id::text from app.bank_match
         where reconcilable_document_id = ${receiptId}`,
    );
    expect(row).toEqual({ matched_by: s.human, company_id: s.company });
  });

  it("a PAYMENT cannot match a positive line: the direction disagrees (ERR_BANK_MATCH_AMOUNT)", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    await expect(
      matching({
        statementLineId: inLine.id,
        kind: "payment",
        documentId: paymentId,
        amount: "1.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*payment.*out.*\+/);
  });

  it("a kind must name a document of its own type: the receipt source does not list a PAYMENT", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    await expect(
      matching({
        statementLineId: inLine.id,
        kind: "receipt",
        documentId: paymentId,
        amount: "1.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*is not a receipt/);
    // Every kind now has a source (8C registered payroll_batch, round 18 B12), and each lists only its own type: a
    // PAYMENT named as a payroll batch is refused by the batch source, as the receipt source refuses it above.
    await expect(
      matching({
        statementLineId: inLine.id,
        kind: "payroll_batch",
        documentId: paymentId,
        amount: "1.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*is not a payroll_batch/);
  });

  it("over-matching a line is refused, naming the line total and the running sum", async () => {
    const inLine = lines.find((l) => l.amount === "1000.0000")!;
    await expect(
      matching({
        statementLineId: inLine.id,
        kind: "receipt",
        documentId: receiptId,
        amount: "0.0100",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*1000\.0000/);
  });

  it("over-matching a DOCUMENT is refused too — its bank leg is 1,000 and it is already fully matched", async () => {
    const { statementId: second } = await importRows("2026-02-28", "250.0000", "1250.0000", [
      "2026-02-05,DUPLICATE,RCT,1000.00",
    ]);
    const [dup] = await linesOf(second);
    await expect(
      matching({
        statementLineId: dup!.id,
        kind: "receipt",
        documentId: receiptId,
        amount: "1000.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*already matched/);
  });

  it("a match amount in another currency than the statement's is refused", async () => {
    const [dup] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_statement_line where description = 'DUPLICATE'`,
    );
    await expect(
      matching({
        statementLineId: dup!.id,
        kind: "receipt",
        documentId: receiptId,
        amount: "1.0000",
        ccy: "USD",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*USD.*MYR/);
  });

  it("unmatch sets unmatched_at and the row SURVIVES — nothing is deleted (spec:2049, LEGACY-041)", async () => {
    const id = await liveMatchOf(paymentId);
    await prodWithTenant(db.rw, ctx, (tx) =>
      unmatch(tx, ctx, { companyId: s.company, matchId: id, reason: "matched to the wrong line" }),
    );
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [after] = await tx<
        {
          unmatched_at: string | null;
          unmatched_by: string | null;
          unmatch_reason: string | null;
        }[]
      >`
        select unmatched_at::text, unmatched_by::text, unmatch_reason
          from app.bank_match where id = ${id}`;
      expect(after!.unmatched_at).not.toBeNull();
      expect(after!.unmatched_by).toBe(s.human); // stamped on the NULL → value transition
      expect(after!.unmatch_reason).toBe("matched to the wrong line");
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from app.bank_match`;
      expect(n!.n).toBe(2);
      // The reason is a COLUMN, so the audit's after-image carries it (ADR 0023's loss, not repeated).
      const [audit] = await tx<{ reason: string | null }[]>`
        select after ->> 'unmatch_reason' as reason from app.audit_log
         where table_name = 'bank_match' and row_id = ${id} and action = 'update'`;
      expect(audit!.reason).toBe("matched to the wrong line");
    });
  });

  it("an unmatch is refused when the match is already unmatched, or when no reason is given", async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_match where reconcilable_document_id = ${paymentId}`,
    );
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        unmatch(tx, ctx, { companyId: s.company, matchId: row!.id, reason: "again" }),
      ),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*not a live match/);
    const live = await liveMatchOf(receiptId);
    await expect(
      prodWithTenant(db.rw, ctx, (tx) =>
        unmatch(tx, ctx, { companyId: s.company, matchId: live, reason: "   " }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*reason/);
  });

  it("reconciledBalance returns statement, ledger and the unreconciled items", async () => {
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconciledBalance(tx, { companyId: s.company, bankAccountId: bank, asOf: "2026-01-31" }),
    );
    expect(result.ledger.toString()).toBe("250.0000"); // 1000 in − 750 out
    expect(result.statement.toString()).toBe("250.0000"); // the January statement's closing balance
    // The payment was just unmatched, so it is unreconciled again.
    expect(result.unreconciled.map((r) => r.documentId)).toEqual([paymentId]);
    // All THREE readers of the account's currency agree. The fixture's 1100 row has `currency IS NULL`
    // (seedAccount sets none, plan0A:1495 "null = any currency"), so every one of them takes the
    // coalesce-onto-company.base_currency path: importStatement stored MYR, reconciledBalance reads MYR,
    // and the ledger-leg source mints MYR rather than a literal of its own.
    for (const item of result.unreconciled) expect(item.amount.currency).toBe(MYR);
    expect(result.statement.currency).toBe(MYR);
    expect(result.ledger.currency).toBe(MYR);
    // …and they are arithmetically compatible: the 250 that reconciles plus the 750 payment still listed as
    // unreconciled is the 1,000 receipt that is matched.
    expect(result.ledger.add(result.unreconciled[0]!.amount).toString()).toBe("1000.0000");
  });

  it("unmatchedStatementLines is the OTHER side, and the frozen type has no member for it", async () => {
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unmatchedStatementLines(tx, {
        companyId: s.company,
        bankAccountId: bank,
        asOf: "2026-01-31",
      }),
    );
    expect(open.map((l) => [l.amount, l.matchedAmount])).toEqual([["-750.0000", "0.0000"]]);
  });

  it("one LIVE match per (line, document) pair; after an unmatch the pair may be matched again", async () => {
    const { documentId: r3 } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-03-05",
      partyId: f.partyIds.customer,
      lines: [bankLine("500.0000")],
    });
    const { statementId: march } = await importRows("2026-03-31", "1250.0000", "1750.0000", [
      "2026-03-05,RECEIPT CUST-1,R3,500.00",
    ]);
    const [line] = await linesOf(march);
    await matching({
      statementLineId: line!.id,
      kind: "receipt",
      documentId: r3,
      amount: "200.0000",
    });
    const [partial] = await linesOf(march);
    expect(partial!.matchedAmount).toBe("200.0000");
    // Partly matched is still "unmatched" to the filter: 500 > 200.
    const open = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, {
        companyId: s.company,
        statementId: march,
        unmatchedOnly: true,
        limit: 50,
      }),
    );
    expect(open.map((l) => l.id)).toEqual([line!.id]);
    await expect(
      matching({ statementLineId: line!.id, kind: "receipt", documentId: r3, amount: "200.0000" }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*already carries a live match/);

    const first = await liveMatchOf(r3);
    await prodWithTenant(db.rw, ctx, (tx) =>
      unmatch(tx, ctx, { companyId: s.company, matchId: first, reason: "partial, redo in full" }),
    );
    await matching({
      statementLineId: line!.id,
      kind: "receipt",
      documentId: r3,
      amount: "500.0000",
    });
    const [full] = await linesOf(march);
    expect(full!.matchedAmount).toBe("500.0000");
  });
});

describe("a bank_match row is fixed at insert; only the unmatch changes it, once (LEGACY-041)", () => {
  const refused = (fn: Parameters<typeof withTenant>[3]) =>
    withTenant(db.rw, s.tenant, s.human, fn);

  it("a direct app_rw UPDATE of a figure or a reference is refused", async () => {
    const live = await liveMatchOf(receiptId);
    await expect(
      refused((tx) => tx`update app.bank_match set amount = 1 where id = ${live}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(
      refused(
        (tx) =>
          tx`update app.bank_match set reconcilable_document_id = ${paymentId} where id = ${live}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("an unmatch is never undone, and an UPDATE that is not an unmatch is refused", async () => {
    const [done] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_match where reconcilable_document_id = ${paymentId}`,
    );
    await expect(
      refused(
        (tx) =>
          tx`update app.bank_match set unmatched_at = null, unmatched_by = null, unmatch_reason = null
              where id = ${done!.id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE.*already unmatched/);
    const live = await liveMatchOf(receiptId);
    await expect(
      refused((tx) => tx`update app.bank_match set created_at = created_at where id = ${live}`),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE.*only by being unmatched/);
    await expect(
      refused(
        (tx) =>
          tx`update app.bank_match set unmatched_at = now(), unmatched_by = app.current_actor()
              where id = ${live}`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED.*reason/);
  });

  it("a match is born live: an INSERT that is already unmatched is refused", async () => {
    const [dup] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_statement_line where description = 'DUPLICATE'`,
    );
    await expect(
      refused(
        (tx) => tx`
          insert into app.bank_match (tenant_id, company_id, statement_line_id, reconcilable_kind,
                                      reconcilable_document_id, amount, unmatched_at, unmatched_by,
                                      unmatch_reason)
          values (${s.tenant}, ${s.company}, ${dup!.id}, 'receipt', ${receiptId}, 1, now(),
                  ${s.human}, 'forged history')`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("app_rw cannot DELETE a match at all", async () => {
    const live = await liveMatchOf(receiptId);
    await expect(
      refused((tx) => tx`delete from app.bank_match where id = ${live}`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("a reversed receipt is money out: its mirror matches the negative line (ADR 0048)", () => {
  it("the original matches the credit, the reversal the debit, and never the other way round", async () => {
    const { documentId: original } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-04-02",
      partyId: f.partyIds.customer,
      lines: [bankLine("400.0000")],
    });
    const reversalCtx = { tenantId: s.tenant, actorId: s.human, requestId: await uuidv7(db.admin) };
    const { reversalDocumentId: mirror } = await prodWithTenant(db.rw, reversalCtx, (tx) =>
      reverseDocument(tx, reversalCtx, {
        documentId: original,
        effectiveDate: "2026-04-10",
        reason: "the cheque bounced",
      }),
    );
    const { statementId: april } = await importRows("2026-04-30", "1750.0000", "1750.0000", [
      "2026-04-02,CHEQUE CUST-1,R4,400.00",
      "2026-04-10,RETURNED CHEQUE,R4,-400.00",
    ]);
    const [credit, debit] = await linesOf(april);

    // Both halves are listed while unmatched: the original is `reversed`, the mirror `posted`.
    const listed = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconcilableSources()
        .find((x) => x.kind === "receipt")!
        .list(tx, {
          companyId: s.company,
          bankAccountId: bank,
          from: "2026-04-01",
          to: "2026-04-30",
          unmatchedOnly: true,
        }),
    );
    expect(listed.map((r) => [r.documentId, r.amount.toString()])).toEqual([
      [original, "400.0000"],
      [mirror, "400.0000"],
    ]);

    await expect(
      matching({
        statementLineId: credit!.id,
        kind: "receipt",
        documentId: mirror,
        amount: "400.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*reversal.*money out/);
    await matching({
      statementLineId: credit!.id,
      kind: "receipt",
      documentId: original,
      amount: "400.0000",
    });
    await matching({
      statementLineId: debit!.id,
      kind: "receipt",
      documentId: mirror,
      amount: "400.0000",
    });
    expect((await linesOf(april)).map((l) => l.matchedAmount)).toEqual(["400.0000", "400.0000"]);
  });

  it("a receipt whose own bank leg runs OUT without being a reversal matches neither side", async () => {
    // Not a shape draftSettlement produces (it refuses a non-positive amount), but a hand-drafted RECEIPT
    // line can carry one. Matched to the credit it would pair a ledger outflow with a bank inflow; matched to
    // the debit it contradicts its kind. Both are refused.
    const { documentId: odd } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-06-03",
      partyId: f.partyIds.customer,
      lines: [bankLine("-50.0000")],
    });
    const { statementId: june } = await importRows("2026-06-30", "1750.0000", "1750.0000", [
      "2026-06-03,IN,X,50.00",
      "2026-06-03,OUT,X,-50.00",
    ]);
    const [credit, debit] = await linesOf(june);
    await expect(
      matching({
        statementLineId: credit!.id,
        kind: "receipt",
        documentId: odd,
        amount: "50.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*bank leg -50\.0000 runs the other way/);
    await expect(
      matching({ statementLineId: debit!.id, kind: "receipt", documentId: odd, amount: "50.0000" }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*a receipt is money in/);
  });
});

describe("the account's own currency (ADR 0048)", () => {
  it("a EUR receipt banked into the base-currency account lists and reconciles at its BASE figure", async () => {
    await seedCurrency(db, s, { code: "EUR" });
    await seedRate(db, s, { from: "EUR", to: "MYR", on: "2026-01-01", rate: "4.80000000" });
    const { documentId: eur } = await postFromPack(db, s, {
      code: "RECEIPT",
      effectiveDate: "2026-05-04",
      partyId: f.partyIds.customer,
      currency: "EUR",
      exchangeRate: "4.80000000",
      lines: [bankLine("100.0000")],
    });
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      reconciledBalance(tx, { companyId: s.company, bankAccountId: bank, asOf: "2026-05-31" }),
    );
    // The bank holds ringgit: 100 EUR at 4.80 arrived as 480.00. A raw Σ(debit − credit) would add the 100
    // EUR to the ringgit rows beside it and report a balance no bank statement could ever show.
    expect(result.unreconciled.find((r) => r.documentId === eur)?.amount.toString()).toBe(
      "480.0000",
    );
    // Jan 250 + Mar 500 + Apr (400 − 400) + May 480.
    expect(result.ledger.toString()).toBe("1230.0000");
    expect(result.statement.toString()).toBe("1750.0000"); // April's closing: the latest on or before May 31
  });
});

describe("bank matches are isolated by tenant and bound to their company (spec:106, §3.3)", () => {
  it("a second tenant sees no match, and cannot match the first tenant's line", async () => {
    const seen = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.bank_match`,
    );
    expect(seen[0]!.n).toBe(0);
    const otherCtx = {
      tenantId: other.tenant,
      actorId: other.human,
      requestId: await uuidv7(db.admin),
    };
    const [dup] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_statement_line where description = 'DUPLICATE'`,
    );
    await expect(
      prodWithTenant(db.rw, otherCtx, (tx) =>
        match(tx, otherCtx, {
          companyId: other.company,
          statementLineId: dup!.id,
          reconcilable: { kind: "receipt", documentId: receiptId },
          amount: Money.of("1.0000", MYR),
        }),
      ),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*not visible/);
    const result = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      unmatchedStatementLines(tx, {
        companyId: s.company,
        bankAccountId: bank,
        asOf: "2026-12-31",
      }),
    );
    expect(result).toEqual([]);
  });

  it("a match naming a sibling company is refused, and the composite key refuses a forged row", async () => {
    const sibling = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
        insert into app.company (id, tenant_id, code, name, base_currency)
        values (${sibling}, ${s.tenant}, 'SIB', 'Sibling', 'MYR')`,
    );
    const [dup] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.bank_statement_line where description = 'DUPLICATE'`,
    );
    await expect(
      matching({
        companyId: sibling,
        statementLineId: dup!.id,
        kind: "receipt",
        documentId: receiptId,
        amount: "1.0000",
      }),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*not visible in company/);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
          insert into app.bank_match (tenant_id, company_id, statement_line_id, reconcilable_kind,
                                      reconcilable_document_id, amount)
          values (${s.tenant}, ${sibling}, ${dup!.id}, 'receipt', ${receiptId}, 1)`,
      ),
    ).rejects.toThrow(/bank_match_tenant_id_company_id_statement_line_id_fkey/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        reconciledBalance(tx, { companyId: sibling, bankAccountId: bank, asOf: "2026-01-31" }),
      ),
    ).rejects.toThrow(/ERR_BANK_MATCH_AMOUNT.*is not an account of company/);
  });
});

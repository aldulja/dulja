/**
 * Acceptance test 39's till-banking clause (spec:2457) — ⚠️ OD-10, answered yes on 2026-11-04 (ADR 0064).
 * 4B owns test 39; its card names 6D for this clause, "which is why the registry and not a type list is the
 * seam". 6D adds ONE `registerReconcilableSource` call (`reconciliation-till.ts`) and edits no file of 4B's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  applyBatch,
  importStatement,
  match,
  RECONCILABLE_DIRECTION,
  reconcilableSources,
  reconciledBalance,
  unmatch,
} from "@dulja/db";
import { seedTenantV2, withTenant, type Db } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { buildTicket } from "./support/pos";
import { branchActor, staffFixture, type StaffFixture } from "./support/staff";

let api: StartedApi;
let db: Db;
let f: StaffFixture;
/** A company-wide back-office principal: reconciliation is a back-office act, never a till's. */
let clerk: string;
let shiftId: string;
let bankAccountId: string;
let bankingDocumentId: string;
let bankingRef: string;
let valueDate: string;
let statementLineId: string;
let matchId: string;

const ctx = () => ({ tenantId: f.seed.tenant, actorId: clerk, requestId: crypto.randomUUID() });
const asClerk = <T>(fn: (tx: never) => Promise<T>) =>
  withTenant(db.rw, f.seed.tenant, clerk, fn as never) as Promise<T>;

const batch = (body: Record<string, unknown>) =>
  withTenant(db.rw, f.seed.tenant, f.terminalA.principalId, (tx) =>
    applyBatch(
      tx as never,
      { tenantId: f.seed.tenant, actorId: f.terminalA.principalId, requestId: "till-banking" },
      {
        terminalId: f.terminalA.terminalId,
        companyId: f.seed.company,
        branchId: f.branchA,
        principalId: f.terminalA.principalId,
      },
      {
        terminalId: f.terminalA.terminalId,
        batchId: crypto.randomUUID(),
        tickets: [],
        shifts: [],
        tillEvents: [],
        ...body,
      },
    ),
  );

const bankFromDrawer = (amount: string, reference: string | null) =>
  batch({
    cashEvents: [
      {
        clientRef: crypto.randomUUID(),
        shiftId,
        kind: "banking",
        amount: { amount, currency: "MYR" },
        cashierPrincipalId: f.cashierA,
        supervisorPrincipalId: null,
        occurredAt: new Date().toISOString(),
        reference,
        fromSafe: false,
      },
    ],
  });

/** Every ledger row of the banking document, fingerprinted: matching must never alter one (SAH-041). */
const ledgerFingerprint = async (): Promise<string> =>
  JSON.stringify(
    await db.admin`
      select le.id::text, a.code, le.debit::text, le.credit::text, le.currency, le.effective_date::text
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${bankingDocumentId} order by le.id`,
  );

beforeAll(async () => {
  api = await startApi();
  db = api.db;
  f = await staffFixture(api, "tillbank");
  clerk = await branchActor(db, f.seed, null, ["pos.report.read"], "tillbank-clerk");
  shiftId = await f.openShift({ cashierPrincipalId: f.cashierA, openingFloat: "100.0000" });
  const sold = await batch({
    tickets: Array.from({ length: 9 }, () =>
      buildTicket(f.pos, {
        sku: "SKU-A",
        shiftId,
        unitPrice: "100.0000",
        tender: "cash",
        cashierPrincipalId: f.cashierA,
      }),
    ),
  });
  expect(sold.results.every((r) => r.status === "accepted")).toBe(true);

  // 1000 straight out of the drawer into the bank.
  const banked = await bankFromDrawer("1000.0000", "DEP-4471");
  expect(banked.cashEventResults[0]!.status).toBe("accepted");
  bankingRef = banked.cashEventResults[0]!.ref;
  const [doc] = await db.admin<{ id: string; effective_date: string }[]>`
    select id::text, effective_date::text from app.document where client_ref = ${bankingRef}::uuid`;
  bankingDocumentId = doc!.id;
  valueDate = doc!.effective_date;
  const [bank] = await db.admin<{ id: string }[]>`
    select id::text from app.account where company_id = ${f.seed.company} and code = '1100'`;
  bankAccountId = bank!.id;

  const { statementId } = await asClerk((tx) =>
    importStatement(tx as never, ctx(), {
      companyId: f.seed.company,
      bankAccountId,
      csv: ["Date,Narrative,Ref,Amount", `${valueDate},TILL DEPOSIT,DEP-4471,1000.00`].join("\n"),
      mapping: {
        statement: {
          statementDate: valueDate,
          openingBalance: "0.0000",
          closingBalance: "1000.0000",
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
  );
  const [line] = await db.admin<{ id: string }[]>`
    select id::text from app.bank_statement_line where statement_id = ${statementId} order by line_no limit 1`;
  statementLineId = line!.id;
}, 300_000);
afterAll(async () => {
  await api.stop();
});

describe("test 39 — a till banking is reconcilable, and matching never alters a ledger entry", () => {
  it("till_banking is a registered Reconcilable kind beside 4B's two, and its direction is money IN", () => {
    // 8C's `payroll_batch` (round 18 B12) registers beside it through the same seam.
    expect(reconcilableSources().map((s) => s.kind)).toEqual([
      "payment",
      "payroll_batch",
      "receipt",
      "till_banking",
    ]);
    expect(RECONCILABLE_DIRECTION.till_banking).toBe("in");
  });

  it("the banking is listed unreconciled on the bank account it debited, naming its document", async () => {
    const { unreconciled } = await asClerk((tx) =>
      reconciledBalance(tx as never, { companyId: f.seed.company, bankAccountId, asOf: valueDate }),
    );
    const mine = unreconciled.find((r) => r.kind === "till_banking")!;
    expect(mine.documentId).toBe(bankingDocumentId);
    expect(mine.amount.toString()).toBe("1000.0000");
    expect(mine.bankAccountId).toBe(bankAccountId);
    expect(mine.valueDate).toBe(valueDate);
    expect(mine.reference).toContain(`TBK-${f.terminalA.code}`);
    expect(mine.reference).toContain("DEP-4471");
  });

  it("matching clears it, and the reconciled balance equals the bank account's ledger balance", async () => {
    ({ matchId } = await asClerk((tx) =>
      match(tx as never, ctx(), {
        companyId: f.seed.company,
        statementLineId,
        reconcilable: { kind: "till_banking", documentId: bankingDocumentId },
        amount: Money.of("1000.0000", currency("MYR")),
      }),
    ));
    const { statement, ledger, unreconciled } = await asClerk((tx) =>
      reconciledBalance(tx as never, { companyId: f.seed.company, bankAccountId, asOf: valueDate }),
    );
    expect(statement.toString()).toBe(ledger.toString());
    expect(unreconciled.find((r) => r.kind === "till_banking")).toBeUndefined();
  });

  it("matching and unmatching alter NO ledger entry, and the unmatched row is kept (SAH-041)", async () => {
    const before = await ledgerFingerprint();
    await asClerk((tx) =>
      unmatch(tx as never, ctx(), { companyId: f.seed.company, matchId, reason: "wrong line" }),
    );
    ({ matchId } = await asClerk((tx) =>
      match(tx as never, ctx(), {
        companyId: f.seed.company,
        statementLineId,
        reconcilable: { kind: "till_banking", documentId: bankingDocumentId },
        amount: Money.of("1000.0000", currency("MYR")),
      }),
    ));
    expect(await ledgerFingerprint()).toBe(before);
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.bank_match
       where reconcilable_document_id = ${bankingDocumentId} and unmatched_at is not null`;
    expect(n!.n).toBe(1);
  });

  it("a second banking with no statement line stays listed as unreconciled", async () => {
    const out = await bankFromDrawer("40.0000", null);
    const [doc] = await db.admin<{ id: string }[]>`
      select id::text from app.document where client_ref = ${out.cashEventResults[0]!.ref}::uuid`;
    const { unreconciled } = await asClerk((tx) =>
      reconciledBalance(tx as never, { companyId: f.seed.company, bankAccountId, asOf: valueDate }),
    );
    expect(unreconciled.filter((r) => r.kind === "till_banking").map((r) => r.documentId)).toEqual([
      doc!.id,
    ]);
  });

  it("a second tenant sees no link row (test 12)", async () => {
    const other = await seedTenantV2(db, "TillBankNosy");
    const [row] = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_banking_link`,
    );
    expect(row!.n).toBe(0);
  });
});

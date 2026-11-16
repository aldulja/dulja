import { readFileSync } from "node:fs";
import { join } from "node:path";
// The PRODUCTION `withTenant(sql, ctx, fn)` from `@dulja/db` (§4.2.2), as in `./payroll`.
import {
  createEmployeeAdvance,
  createPayrollPayment,
  postDocument,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { currency, Money } from "@dulja/domain";
import { grantCodes, seedAccount, seedDocumentType, type Db, type Seed } from "@dulja/db/test";
import { postFromPack } from "./ar-ap";
import {
  PAYROLL_PACK_ROOT,
  payrollFixture,
  postPayrollRun,
  secondApprover,
  type PayrollFixture,
} from "./payroll";

// 8C T6 — contracts round 18, amendment B3 (§4.17.1). §4.17 assigns 8C no `fixtures.ts` row (hazard 9), so every
// helper this slice shares lives here. `postRemittance` (B3's fourth name) arrived with Task 8.

const ctxOf = (s: Seed, actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "00000000-0000-0000-0000-000000000000",
});

export interface MoneyOutFixture extends PayrollFixture {
  /** A posted PAYROLL run for 2026-01 (pay date 2026-02-05), from which every money-out case in this slice starts. */
  payrollDocumentId: string;
  /** A principal holding accounting.payment.approve and .post and nothing HR — R1's second person for the batch. */
  payer: string;
  /** The authority vendor party a statutory remittance is paid to (spec:2082 models it as a vendor). */
  authorityPartyId: string;
  /** 0C's `1100` Bank, applied from the shipped chart file (the money-out policies' credit leg). */
  bankAccountId: string;
}

type ChartRow = {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
};

/**
 * `payrollFixture` (8B) plus everything money-out needs: 0C's `1100` and the two money-out document types from the
 * SHIPPED pack files (so a test and the pack can never disagree), a posted January run, the release codes on `s.human`
 * (the seeded `hr_payroll` shape: read, prepare, pay, advance.create), the payment codes on a THIRD principal, and
 * the authority vendor party on the fixture's scheme.
 *
 * NOT idempotent, like `payrollFixture`: call it once per `Seed`.
 */
export async function moneyOutFixture(db: Db, s: Seed): Promise<MoneyOutFixture> {
  const base = await payrollFixture(db, s);

  // `seedTenantV2`'s synthetic chart has no `1100`; 0C's base file is where a real tenant gets it.
  const bank = (
    JSON.parse(
      readFileSync(join(PAYROLL_PACK_ROOT, "chart-of-accounts/0c-base.json"), "utf8"),
    ) as ChartRow[]
  ).find((r) => r.code === "1100")!;
  const bankAccountId = await seedAccount(db, s, {
    code: bank.code,
    nameEn: bank.nameEn,
    type: bank.type,
  });

  for (const code of ["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"] as const) {
    const envelope = JSON.parse(
      readFileSync(join(PAYROLL_PACK_ROOT, `document-types/${code}.json`), "utf8"),
    ) as { module: "hr"; policy: unknown };
    await seedDocumentType(db, s, { code, module: envelope.module, policy: envelope.policy });
  }

  // R1 needs three distinct people across this slice: the preparer (s.human), the payroll approver (base.approver,
  // 8B's) and the PAYER, who holds the accounting.payment codes and nothing HR — no seeded role holds both
  // hr.payroll.approve and accounting.payment.approve, and a fixture that did would model a tenant the seed forbids.
  const payer = await secondApprover(db, s, [
    "accounting.payment.approve",
    "accounting.payment.post",
  ]);
  await grantCodes(db, s, {
    codes: ["hr.payroll.read", "hr.payroll.prepare", "hr.payroll.pay", "hr.advance.create"],
  });

  // The authority vendor party, its payable account the SCHEME'S OWN payable account: 4A's PAYMENT debits
  // `party.payable_account`, so a remittance clears the scheme's payable only if the two are the same account.
  const authorityPartyId = await withTenant(db.rw, ctxOf(s, s.human), async (tx) => {
    const [row] = await tx<{ id: string; payable_account_id: string | null }[]>`
      insert into app.party (tenant_id, company_id, kind, code, name_en, payable_account_id)
      select ${s.tenant}, ${s.company}, 'vendor', 'AUTHORITY-SYNTH', 'Synthetic scheme authority',
             ss.payable_account_id
        from app.statutory_scheme ss where ss.id = ${base.schemeId}
      returning id, payable_account_id`;
    if (!row || row.payable_account_id === null) {
      throw new Error(
        "moneyOutFixture: statutory_scheme.payable_account_id is null — linkPayrollAccounts did not wire the scheme",
      );
    }
    await tx`update app.statutory_scheme set authority_party_id = ${row.id} where id = ${base.schemeId}`;
    return row.id;
  });

  const payrollDocumentId = await postPayrollRun(db, s, base, {
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    payDate: "2026-02-05",
    effectiveDate: "2026-01-31",
  });

  return { ...base, payrollDocumentId, payer, authorityPartyId, bankAccountId };
}

/** Submits as `s.human`, then approves and posts as `f.payer`, through the REAL state machine. */
async function release(db: Db, s: Seed, f: MoneyOutFixture, documentId: string): Promise<void> {
  await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId, to: "submitted" }),
  );
  await withTenant(db.rw, ctxOf(s, f.payer), (tx) =>
    transitionDocument(tx, ctxOf(s, f.payer), { documentId, to: "approved" }),
  );
  await withTenant(db.rw, ctxOf(s, f.payer), (tx) =>
    postDocument(tx, ctxOf(s, f.payer), { documentId }),
  );
}

/** Drafts, approves and posts a PAYROLL_PAYMENT for `f.payrollDocumentId` (or `input.payrollDocumentId`). Returns
 *  the document id. */
export async function postPayrollPayment(
  db: Db,
  s: Seed,
  f: MoneyOutFixture,
  input: {
    effectiveDate?: string;
    employeeIds?: readonly string[];
    payrollDocumentId?: string;
  } = {},
): Promise<string> {
  const r = await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    createPayrollPayment(tx, ctxOf(s, s.human), {
      companyId: s.company,
      payrollDocumentId: input.payrollDocumentId ?? f.payrollDocumentId,
      effectiveDate: input.effectiveDate ?? "2026-02-05",
      branchId: s.hq,
      ...(input.employeeIds === undefined ? {} : { employeeIds: input.employeeIds }),
    }),
  );
  await release(db, s, f, r.documentId);
  return r.documentId;
}

/** The same for an EMPLOYEE_ADVANCE in the company's base currency (MYR in every fixture tenant). */
export async function postEmployeeAdvance(
  db: Db,
  s: Seed,
  f: MoneyOutFixture,
  input: { employeeId: string; amount: string; reason: string; effectiveDate?: string },
): Promise<string> {
  const r = await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    createEmployeeAdvance(tx, ctxOf(s, s.human), {
      companyId: s.company,
      employeeId: input.employeeId,
      effectiveDate: input.effectiveDate ?? "2026-01-10",
      branchId: s.hq,
      amount: Money.of(input.amount, currency("MYR")),
      reason: input.reason,
    }),
  );
  await release(db, s, f, r.documentId);
  return r.documentId;
}

/**
 * 8C T8 — a posted `PAYMENT` (4A's type, configured from the shipped pack) to the scheme's authority vendor party for
 * `amount`, which is what a statutory remittance IS (spec:2082: "statutory remittances as ORDINARY PAYMENT documents
 * to each authority modelled as a vendor party"). This slice introduces no remittance document type of its own.
 *
 * 4A's PAYMENT policy debits `party.payable_account` and credits `line.account`, both at `line.total_incl_tax`. The
 * line therefore names `1100`, the BANK — the credit 0091's guard measures — and `moneyOutFixture` made the authority
 * party's payable account the scheme's own payable (`2411` for the fixture's scheme), so the debit clears what the
 * payroll run credited. 4B's `postFromPack` walks the real state machine: submitted by `s.human`, approved, issued and
 * posted by a second principal holding exactly the policy's approve and post codes (R1).
 */
export async function postRemittance(
  db: Db,
  s: Seed,
  f: MoneyOutFixture,
  input: { amount: string; effectiveDate?: string },
): Promise<string> {
  const { documentId } = await postFromPack(db, s, {
    code: "PAYMENT",
    effectiveDate: input.effectiveDate ?? "2026-02-15",
    partyId: f.authorityPartyId,
    lines: [
      {
        kind: "account",
        accountId: f.bankAccountId,
        amount: input.amount,
        description: "Statutory remittance",
      },
    ],
  });
  return documentId;
}

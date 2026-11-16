// The 8C re-runs of acceptance test 31 (spec:2449) — "The submitter of a PAYROLL, PAYMENT, PAYROLL_PAYMENT,
// EMPLOYEE_ADVANCE or STOCK_COUNT cannot approve or post it through any path — API, job, or direct SQL as `app_rw`." —
// for the two money-out types, with test 10's authority clause for the batch; and of acceptance test 39 (spec:2457),
// its payroll-batch clause. 8C Task 12. Not one line of segregation logic is written in this slice: the two policies'
// `approval: { required: true, … }` is the whole mechanism and 2B's status triggers are the control.
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  createEmployeeAdvance,
  createPayrollPayment,
  importStatement,
  listStatementLines,
  match,
  postDocument,
  reconciledBalance,
  systemContext,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { problemOf } from "../support/api";
import { moneyOutFixture, postPayrollPayment, type MoneyOutFixture } from "./support/payroll-money";
import { postPayrollRun, secondApprover } from "./support/payroll";

type MoneyOutType = "PAYROLL_PAYMENT" | "EMPLOYEE_ADVANCE";
const TYPES: readonly MoneyOutType[] = ["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"];
const MYR = currency("MYR");
let api: StartedApi;
let s: Seed;
let f: MoneyOutFixture;
/** Holds hr.payroll.pay and hr.payroll.read and NOT accounting.payment.post — test 10's "above their own authority". */
let payOnly: string;

const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const as = <T>(actor: string, fn: (tx: Sql) => Promise<T>) => withTenant(api.db.rw, ctx(actor), fn);
const statusOf = async (documentId: string) =>
  (
    await api.db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${documentId}`
  )[0]!.status;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "Test 31/39 money out");
  f = await moneyOutFixture(api.db, s); // January's run posted; s.human holds read, prepare, pay, advance.create

  // `accounting.payment.approve` on s.human, and NOT `.post`. Every maker-is-checker case asserts R1's token, and the
  // API's `requireDocumentPermission("approve")` pre-flight refuses an actor who does not HOLD the approval code with
  // 403 before the trigger is ever reached — so the submitter must hold it for R1 to be the refusal that speaks.
  await grantCodes(api.db, s, { codes: ["accounting.payment.approve"] });
  payOnly = await secondApprover(api.db, s, ["hr.payroll.pay", "hr.payroll.read"]);
  await api.loadPrincipals();
}, 300_000);
afterAll(async () => {
  await api.stop();
});

/**
 * A fresh DRAFT of `code`, owned by s.human. **A PAYROLL_PAYMENT needs a run nobody has been paid from yet**:
 * createPayrollPayment excludes an employee already carried by any non-void batch against the run — a draft included —
 * so each call posts its own regular run, one month later than the last, starting in FEBRUARY. January is left for
 * test 39's batch below, and payrollFixture opened all twelve 2026 periods.
 */
let monthCounter = 1; // 1 → February, and upward
async function draftOf(code: MoneyOutType): Promise<string> {
  if (code === "EMPLOYEE_ADVANCE") {
    const r = await as(s.human, (tx) =>
      createEmployeeAdvance(tx, ctx(s.human), {
        companyId: s.company,
        employeeId: f.employeeAId,
        effectiveDate: "2026-01-10",
        branchId: s.hq,
        amount: Money.of("50.0000", MYR),
        reason: "segregation case",
      }),
    );
    return r.documentId;
  }
  monthCounter += 1;
  const mm = String(monthCounter).padStart(2, "0");
  const nextMm = String(monthCounter + 1).padStart(2, "0");
  const lastDay = ["01", "03", "05", "07", "08", "10", "12"].includes(mm)
    ? "31"
    : mm === "02"
      ? "28"
      : "30";
  const runId = await postPayrollRun(api.db, s, f, {
    periodStart: `2026-${mm}-01`,
    periodEnd: `2026-${mm}-${lastDay}`,
    payDate: `2026-${nextMm}-05`,
    effectiveDate: `2026-${mm}-${lastDay}`,
  });
  const r = await as(s.human, (tx) =>
    createPayrollPayment(tx, ctx(s.human), {
      companyId: s.company,
      payrollDocumentId: runId,
      effectiveDate: `2026-${nextMm}-05`,
      branchId: s.hq,
    }),
  );
  return r.documentId;
}

const transitions = (documentId: string) =>
  `/v1/companies/${s.company}/documents/${documentId}/transitions`;

describe("acceptance test 31 — segregation of duties on the money-out types (spec:2449)", () => {
  it.each(TYPES)("%s: the submitter cannot approve it — through the API", async (code) => {
    const documentId = await draftOf(code);
    const submitted = await api.request({
      method: "POST",
      as: s.human,
      path: transitions(documentId),
      body: { to: "submitted" },
    });
    expect(submitted.status).toBe(200);
    const res = await api.request({
      method: "POST",
      as: s.human,
      path: transitions(documentId),
      body: { to: "approved" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
    expect(await statusOf(documentId)).toBe("submitted");
  });

  it.each(TYPES)(
    "%s: the submitter cannot approve it — through direct app_rw SQL",
    async (code) => {
      const documentId = await draftOf(code);
      await as(s.human, (tx) =>
        transitionDocument(tx, ctx(s.human), { documentId, to: "submitted" }),
      );
      await expect(
        as(
          s.human,
          (tx) => tx`update app.document set status = 'approved' where id = ${documentId}`,
        ),
      ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER: principal .* cannot approve it/);
      expect(await statusOf(documentId)).toBe("submitted");
    },
  );

  it.each(TYPES)("%s: a job cannot approve what the same job submitted", async (code) => {
    // The job path runs as the tenant's system principal (hazard 20); R1 binds it like any other principal.
    const documentId = await draftOf(code);
    const sys = await systemContext(api.db.rw, s.tenant, "money-out-sod-job");
    await withTenant(api.db.rw, sys, (tx) =>
      transitionDocument(tx, sys, { documentId, to: "submitted", reason: "job" }),
    );
    await expect(
      withTenant(api.db.rw, sys, (tx) =>
        transitionDocument(tx, sys, { documentId, to: "approved", reason: "job" }),
      ),
    ).rejects.toThrow(/ERR_SOD_MAKER_IS_CHECKER/);
    expect(await statusOf(documentId)).toBe("submitted");
  });

  it.each(TYPES)("%s: approving with NO submitted event is ERR_SOD_NO_SUBMISSION", async (code) => {
    // The row is INSERTED at `submitted` (segregation-of-duties.test.ts's draftAt): reaching `submitted` by UPDATE
    // would write the event, and a draft never reaches R1 — the matrix refuses `draft → approved` first. This is the
    // one state in which R1's first clause speaks, and the payer (who holds the approve code) is refused by it.
    const id = await uuidv7(api.db.admin);
    await as(s.human, async (tx) => {
      const [type] = await tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = ${code}`;
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, status,
                                         effective_date, currency, branch_id)
               values (${id}, ${s.tenant}, ${s.company}, ${type!.id}, 'SOD', 'submitted', '2026-01-15', 'MYR',
                       ${s.hq})`;
    });
    await expect(
      as(f.payer, (tx) => tx`update app.document set status = 'approved' where id = ${id}`),
    ).rejects.toThrow(/ERR_SOD_NO_SUBMISSION/);
  });

  it("test 10: a principal holding hr.payroll.pay but NOT accounting.payment.post cannot post a batch", async () => {
    // Approved by a genuine second principal, then offered to a THIRD who never submitted it — so R1 is out of the
    // way and the refusal is the authority's (R2), on the service path and on raw SQL.
    const documentId = await draftOf("PAYROLL_PAYMENT");
    await as(s.human, (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId, to: "submitted" }),
    );
    await as(f.payer, (tx) => transitionDocument(tx, ctx(f.payer), { documentId, to: "approved" }));
    await expect(
      as(payOnly, (tx) => postDocument(tx, ctx(payOnly), { documentId })),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    // approved → issued is not an authority edge (0022: "authority was checked at approved"); issued → posted is.
    await expect(
      as(payOnly, async (tx) => {
        await tx`update app.document set status = 'issued' where id = ${documentId}`;
        await tx`update app.document set status = 'posted' where id = ${documentId}`;
      }),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    expect(await statusOf(documentId)).toBe("approved");
    const [legs] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${documentId}`;
    expect(legs!.n).toBe(0);
  });
});

describe("acceptance test 39 — the payroll-batch clause (spec:2457)", () => {
  /** A sha256 over every ledger_entry column that could be tampered with (LEGACY-031, LEGACY-041 — test-39's own form). */
  const ledgerFingerprint = async (): Promise<string> => {
    const [row] = await api.db.admin<{ h: string }[]>`
      select coalesce(encode(sha256(convert_to(string_agg(t, '|' order by t), 'UTF8')), 'hex'), '') as h
        from (select concat_ws(':', id::text, document_id::text, line_no::text, account_id::text,
                               debit::text, credit::text, currency, exchange_rate::text,
                               base_debit::text, base_credit::text, effective_date::text,
                               fiscal_period_id::text, posting_policy_id::text, posted_by::text) as t
                from app.ledger_entry where company_id = ${s.company}) x`;
    return row!.h;
  };

  it("a month's statement matches the payroll batch, matching alters no ledger entry, and the balances agree", async () => {
    // The JANUARY run's batch — draftOf leaves that run alone (its month counter starts at February).
    const documentId = await postPayrollPayment(api.db, s, f, { effectiveDate: "2026-02-05" });

    const [row] = await api.db.admin<{ amount: string }[]>`
      select (coalesce(sum(le.credit), 0) - coalesce(sum(le.debit), 0))::numeric(19,4)::text as amount
        from app.ledger_entry le
       where le.document_id = ${documentId} and le.account_id = ${f.bankAccountId}`;
    const amount = row!.amount;
    expect(amount).toBe("3900.0000"); // both employees' SYNTH net (1950.0000 each) leaves the bank

    // One line, in 4B's two-column bank form where DEBIT is money out; the closing balance is the opening minus the
    // payment, because importStatement refuses a statement that does not add up.
    const csv = ["Date,Narrative,Ref,Debit,Credit", `05/02/2026,SALARIES,PAYB,${amount},0.00`].join(
      "\n",
    );
    const { statementId } = await as(s.human, (tx) =>
      importStatement(tx, ctx(s.human), {
        companyId: s.company,
        bankAccountId: f.bankAccountId,
        csv,
        mapping: {
          statement: {
            statementDate: "2026-02-28",
            openingBalance: "0.0000",
            closingBalance: `-${amount}`,
          },
          columns: {
            valueDate: "Date",
            description: "Narrative",
            reference: "Ref",
            debit: "Debit",
            credit: "Credit",
          },
          dateFormat: "DD/MM/YYYY",
          hasHeader: true,
        },
      }),
    );
    const [line] = await as(s.human, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, limit: 10 }),
    );
    expect(line!.amount).toBe(`-${amount}`); // signed OUT by the debit column

    const before = await ledgerFingerprint();
    await as(s.human, (tx) =>
      match(tx, ctx(s.human), {
        companyId: s.company,
        statementLineId: line!.id,
        reconcilable: { kind: "payroll_batch", documentId },
        amount: Money.of(amount, MYR), // a MAGNITUDE; the direction is the kind's (§4.8.3)
      }),
    );
    expect(await ledgerFingerprint()).toBe(before); // matching altered no ledger entry (LEGACY-031/041)

    const r = await as(s.human, (tx) =>
      reconciledBalance(tx, {
        companyId: s.company,
        bankAccountId: f.bankAccountId,
        asOf: "2026-02-28",
      }),
    );
    expect(r.statement.toString()).toBe(r.ledger.toString());
    expect(r.ledger.toString()).toBe(`-${amount}`);
    expect(r.unreconciled.filter((u) => u.kind === "payroll_batch")).toEqual([]);
  });
});

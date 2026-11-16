import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, currency } from "@dulja/domain";
import {
  importStatement,
  listStatementLines,
  match,
  RECONCILABLE_DIRECTION,
  reconcilableSources,
  type ReconcilableSource,
} from "../../src/ar-ap/reconciliation";
import { PAYROLL_BATCH_SOURCE } from "../../src/hr/reconcilable";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import {
  moneyOutFixture,
  postEmployeeAdvance,
  postPayrollPayment,
  type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";
import { sourceFiles } from "../../../../tests/support/source";

// 8C T12 — the `payroll_batch` Reconcilable source (§4.8.3, round 18 B12; test 39's payroll-batch clause). Figures come
// from 8B's SYNTH table through payrollFixture: net 1950.0000 per employee (hazard 1).

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
const ctx = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });
const source = (): ReconcilableSource =>
  reconcilableSources().find((x) => x.kind === "payroll_batch")!;
const list = (from: string, to: string, unmatchedOnly: boolean) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    source().list(tx, {
      companyId: s.company,
      bankAccountId: f.bankAccountId,
      from,
      to,
      unmatchedOnly,
    }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Reconcilable");
  f = await moneyOutFixture(db, s); // January's run posted; `1100` seeded from 0C's base chart
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("PAYROLL_BATCH_SOURCE (§4.8.3, amendment B12; test 39's payroll-batch clause)", () => {
  it("is registered under kind payroll_batch and moves money OUT", () => {
    expect(reconcilableSources().map((x) => x.kind)).toContain("payroll_batch");
    expect(source()).toBe(PAYROLL_BATCH_SOURCE);
    expect(RECONCILABLE_DIRECTION.payroll_batch).toBe("out");
  });

  it("lists a posted PAYROLL_PAYMENT's bank leg as a magnitude, with its series-and-number reference", async () => {
    // ONE employee per batch in this file, deliberately: createPayrollPayment excludes an employee already carried by
    // any non-void batch against the run, so a batch for everyone here would make the matching case's batch
    // impossible. A is this case's; B is the matching case's.
    const documentId = await postPayrollPayment(db, s, f, {
      effectiveDate: "2026-02-05",
      employeeIds: [f.employeeAId],
    });
    const rows = await list("2026-02-01", "2026-02-28", true);
    const row = rows.find((r) => r.documentId === documentId)!;
    expect(row.kind).toBe("payroll_batch");
    expect(row.bankAccountId).toBe(f.bankAccountId);
    expect(row.valueDate).toBe("2026-02-05");
    expect(row.amount.toString()).toBe("1950.0000"); // a MAGNITUDE — the direction is the kind's, not the sign's
    expect(row.amount.currency).toBe(MYR);
    expect(row.reference).toMatch(/^PAYB-\d+$/);
    // ...and the bank leg really is a CREDIT of that figure: the source reports it, it does not invent it.
    const [leg] = await db.admin<{ credit: string; debit: string }[]>`
      select sum(credit)::text as credit, sum(debit)::text as debit from app.ledger_entry
       where document_id = ${documentId} and account_id = ${f.bankAccountId}`;
    expect(leg).toEqual({ credit: "1950.0000", debit: "0.0000" });
  });

  it("does NOT list an EMPLOYEE_ADVANCE — it credits the bank too, and is not a payroll batch", async () => {
    const advanceId = await postEmployeeAdvance(db, s, f, {
      employeeId: f.employeeAId,
      amount: "100.0000",
      reason: "not a batch",
    });
    const rows = await list("2026-01-01", "2026-12-31", false);
    expect(rows.map((r) => r.documentId)).not.toContain(advanceId);
    expect(rows.length).toBeGreaterThan(0); // the filter is real: the batch above is still listed
  });

  it("lists nothing outside its date window", async () => {
    expect(await list("2026-03-01", "2026-03-31", false)).toEqual([]);
    expect(await list("2026-02-05", "2026-02-05", false)).toHaveLength(1);
  });

  it("drops out of the unmatched list once a bank_match covers it, and stays in the full list (test 39)", async () => {
    // importStatement + match are 4B's; this proves the SEAM, not 4B's matcher.
    const documentId = await postPayrollPayment(db, s, f, {
      effectiveDate: "2026-02-06",
      employeeIds: [f.employeeBId],
    });
    const [batch] = await list("2026-02-06", "2026-02-06", true);
    expect(batch!.documentId).toBe(documentId);

    // One line for exactly the batch's amount, in 4B's two-column bank form where DEBIT is money OUT; the header
    // figures come from `CsvMapping.statement` because a CSV does not carry them.
    const amount = batch!.amount.toString();
    const csv = [
      "Date,Narrative,Ref,Debit,Credit",
      `06/02/2026,SALARY BATCH,${batch!.reference ?? "PAYB"},${amount},0.00`,
    ].join("\n");
    const { statementId } = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      importStatement(tx, ctx(s.human), {
        companyId: s.company,
        bankAccountId: f.bankAccountId,
        csv,
        mapping: {
          statement: {
            statementDate: "2026-02-06",
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
    const [line] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listStatementLines(tx, { companyId: s.company, statementId, limit: 10 }),
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      match(tx, ctx(s.human), {
        companyId: s.company,
        statementLineId: line!.id,
        reconcilable: { kind: "payroll_batch", documentId },
        amount: Money.of(amount, MYR),
      }),
    );

    const unmatched = await list("2026-02-01", "2026-02-28", true);
    expect(unmatched.map((r) => r.documentId)).not.toContain(documentId);
    const all = await list("2026-02-01", "2026-02-28", false);
    expect(all.map((r) => r.documentId)).toContain(documentId);
  });

  it("edits no 4B file: the kind is registered here, and 4B's file registers only its own two (B12)", () => {
    // Amendment B12's structural claim, asserted on the tree rather than on a git ref (a worktree or a shallow CI
    // checkout may have no `origin/main`, and a later slice's legitimate change to a 4B file is not 8C's to refuse).
    const registrations = sourceFiles(["packages/db/src"])
      .flatMap((file) =>
        [...file.text.matchAll(/^registerReconcilableSource\(/gm)].map(() => file.path),
      )
      .toSorted();
    expect(registrations).toEqual([
      "packages/db/src/ar-ap/reconciliation-till.ts",
      "packages/db/src/ar-ap/reconciliation.ts",
      "packages/db/src/ar-ap/reconciliation.ts",
      "packages/db/src/hr/reconcilable.ts",
    ]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import {
  advanceBalance,
  createEmployeeAdvance,
  createPayrollPayment,
  listMoneyOut,
  MoneyOutError,
  readMoneyOut,
  type MoneyOutResult,
} from "../../src/hr/money-out";
import { BATCH_CSV_HEADER, payrollBatchCsv } from "../../src/hr/batch-csv";
import { postDocument, reverseDocument, transitionDocument } from "../../src/posting";
import { startDb, withTenant, type Db } from "../harness";
import { seedPayrollRun, seedTenantV2, type Seed } from "../fixtures";
import {
  moneyOutFixture,
  postEmployeeAdvance,
  type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";

// 8C T6 — the money-out services (spec:2082, round 18 B8/B9). Figures come from 8B's SYNTH table through
// payrollFixture: BASIC 2000.0000, employee share 50.0000 → net 1950.0000 per employee (hazard 1).

const MYR = currency("MYR");
const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
const ctxOf = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Money out");
  f = await moneyOutFixture(db, s);
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("createPayrollPayment (spec:2082)", () => {
  // ONE draft serves the cases below, and that is a correctness requirement: the service excludes an employee already
  // carried by any non-void batch against this run, a DRAFT included, so a second draft would be refused. The
  // exclusion case posts this draft and then asks for a second batch; the file's order is load-bearing.
  let draft: MoneyOutResult;

  beforeAll(async () => {
    draft = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      createPayrollPayment(tx, ctxOf(s.human), {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
        effectiveDate: "2026-02-05",
        branchId: s.hq,
      }),
    );
  }, 60_000);

  it("drafts ONE document with one line per employee at the run's net pay, and no ledger row", async () => {
    expect(draft.typeCode).toBe("PAYROLL_PAYMENT");
    expect(draft.employeeCount).toBe(2);
    expect(draft.lines.map((l) => l.employeeId).toSorted()).toEqual(
      [f.employeeAId, f.employeeBId].toSorted(),
    );
    for (const line of draft.lines) expect(line.amount.toString()).toBe("1950.0000");
    expect(draft.total.toString()).toBe("3900.0000");
    const sum = draft.lines.reduce((a, l) => a.add(l.amount), Money.zero(draft.total.currency));
    expect(draft.total.equals(sum)).toBe(true);
    // The series is on the DRAFT and comes from the envelope's numbering.series; the NUMBER is assigned at issue.
    expect(draft.series).toBe("PAYB");
    expect(draft.number).toBeNull();
    expect(draft.status).toBe("draft");
    expect(draft.notes).toBe(`payroll:${f.payrollDocumentId}`);

    const led = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where document_id = ${draft.documentId}`;
    expect(led[0]!.n).toBe(0);
  });

  it("every line carries the EMPLOYEE'S home branch and EMPLOYEE value in document_line.dimensions", async () => {
    const rows = await db.admin<{ dimensions: Record<string, string>; kind: string }[]>`
      select dimensions, kind from app.document_line where document_id = ${draft.documentId} order by line_no`;
    for (const row of rows) {
      expect(row.kind).toBe("payroll");
      expect(Object.keys(row.dimensions).toSorted()).toEqual(["BRANCH", "EMPLOYEE"]);
    }
    // E-0002 is at branchB (payrollFixture), so the two lines' BRANCH values differ and one is not the batch's.
    expect(rows.map((r) => r.dimensions["BRANCH"]).toSorted()).toEqual(
      [s.hq, f.branchB].toSorted(),
    );
  });

  it("writes NO payroll_line row (amendment B9 — that table belongs to runs)", async () => {
    const rows = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${draft.documentId}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("refuses a run that is not posted, and a run of another company or none at all", async () => {
    const draftRun = await seedPayrollRun(db, s, {
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      employeeIds: [f.employeeAId],
      effectiveDate: "2026-03-31",
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createPayrollPayment(tx, ctxOf(s.human), {
          companyId: s.company,
          payrollDocumentId: draftRun,
          effectiveDate: "2026-04-05",
          branchId: s.hq,
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL: payroll run .* is not posted \(status draft\)/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createPayrollPayment(tx, ctxOf(s.human), {
          companyId: s.company,
          payrollDocumentId: draft.documentId, // a batch, not a run
          effectiveDate: "2026-04-05",
          branchId: s.hq,
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: payroll run/);
  });

  it("refuses an employee who is not on the run", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createPayrollPayment(tx, ctxOf(s.human), {
          companyId: s.company,
          payrollDocumentId: f.payrollDocumentId,
          effectiveDate: "2026-02-05",
          branchId: s.hq,
          employeeIds: ["00000000-0000-7000-8000-000000000000"],
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: employee .* has no positive net pay on payroll run/);
  });

  it("posts through the real state machine: 2400 debited per employee with BRANCH and EMPLOYEE, 1100 credited once", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctxOf(s.human), { documentId: draft.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, s.tenant, f.payer, (tx) =>
      transitionDocument(tx, ctxOf(f.payer), { documentId: draft.documentId, to: "approved" }),
    );
    await withTenant(db.rw, s.tenant, f.payer, (tx) =>
      postDocument(tx, ctxOf(f.payer), { documentId: draft.documentId }),
    );

    const legs = await db.admin<
      {
        code: string;
        debit: string;
        credit: string;
        branch: string | null;
        employee: string | null;
      }[]
    >`
      select a.code, le.debit::text as debit, le.credit::text as credit,
             (select led.dimension_value_id::text from app.ledger_entry_dimension led
                join app.dimension_type dt on dt.id = led.dimension_type_id
               where led.entry_id = le.id and dt.code = 'BRANCH') as branch,
             (select dv.code from app.ledger_entry_dimension led
                join app.dimension_type dt on dt.id = led.dimension_type_id
                join app.dimension_value dv on dv.id = led.dimension_value_id
               where led.entry_id = le.id and dt.code = 'EMPLOYEE') as employee
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${draft.documentId}
       order by a.code, employee`;
    expect(legs).toEqual([
      { code: "1100", debit: "0.0000", credit: "3900.0000", branch: s.hq, employee: null },
      { code: "2400", debit: "1950.0000", credit: "0.0000", branch: s.hq, employee: "E-0001" },
      { code: "2400", debit: "1950.0000", credit: "0.0000", branch: f.branchB, employee: "E-0002" },
    ]);
    // Salaries payable is cleared, per employee: the run's credits and the batch's debits net to zero.
    const net = await db.admin<{ employee: string; balance: string }[]>`
      select dv.code as employee, sum(le.credit - le.debit)::text as balance
        from app.ledger_entry le
        join app.account a on a.id = le.account_id and a.code = '2400'
        join app.ledger_entry_dimension led on led.entry_id = le.id
        join app.dimension_type dt on dt.id = led.dimension_type_id and dt.code = 'EMPLOYEE'
        join app.dimension_value dv on dv.id = led.dimension_value_id
       where le.company_id = ${s.company}
       group by dv.code order by dv.code`;
    expect(net).toEqual([
      { employee: "E-0001", balance: "0.0000" },
      { employee: "E-0002", balance: "0.0000" },
    ]);
  });

  it("refuses a second batch for an employee already paid on this run", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createPayrollPayment(tx, ctxOf(s.human), {
          companyId: s.company,
          payrollDocumentId: f.payrollDocumentId,
          effectiveDate: "2026-02-07",
          branchId: s.hq,
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: every employee on payroll run .* is already paid/);
  });

  it("declares reversal.allowed = true, and the STATE MACHINE is what refuses it (Task 5's claim, pinned)", async () => {
    // `approval.required = true` makes the mirror's inner `draft → issued` illegal (8B's A4, mechanic 1), so a
    // posted batch cannot be reversed by reverseDocument; a mispaid batch waits on §4.5.1 (AGENTS.md's recorded
    // limit "no approval-required type can be reversed"). The batch posted by the previous case is the subject.
    await expect(
      withTenant(db.rw, s.tenant, f.payer, (tx) =>
        reverseDocument(tx, ctxOf(f.payer), {
          documentId: draft.documentId,
          effectiveDate: "2026-02-08",
          reason: "mispaid batch",
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_STATUS_ILLEGAL/);

    const [orig] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${draft.documentId}`;
    expect(orig!.status).toBe("posted");
    const mirrors = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where reverses_document_id = ${draft.documentId}`;
    expect(mirrors[0]!.n).toBe(0);
  });
});

describe("readMoneyOut and listMoneyOut", () => {
  it("binds a read to the company and the type — another type or company is ERR_NOT_FOUND", async () => {
    const [batch] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listMoneyOut(tx, { companyId: s.company, typeCode: "PAYROLL_PAYMENT", limit: 10 }),
    );
    expect(batch).toBeDefined();
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readMoneyOut(tx, batch!.documentId, { companyId: s.company, typeCode: "PAYROLL_PAYMENT" }),
    );
    expect(read.status).toBe("posted");
    expect(read.number).not.toBeNull(); // numbered at issue, inside the posting service
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        readMoneyOut(tx, batch!.documentId, { typeCode: "EMPLOYEE_ADVANCE" }),
      ),
    ).rejects.toThrow(MoneyOutError);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        readMoneyOut(tx, batch!.documentId, { companyId: "00000000-0000-7000-8000-000000000001" }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => readMoneyOut(tx, f.payrollDocumentId)),
    ).rejects.toThrow(/ERR_NOT_FOUND/); // a PAYROLL run is not a money-out document
  });

  it("filters by run and status", async () => {
    const byRun = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listMoneyOut(tx, {
        companyId: s.company,
        typeCode: "PAYROLL_PAYMENT",
        payrollDocumentId: f.payrollDocumentId,
        status: "posted",
        limit: 10,
      }),
    );
    expect(byRun).toHaveLength(1);
    const none = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listMoneyOut(tx, {
        companyId: s.company,
        typeCode: "PAYROLL_PAYMENT",
        status: "draft",
        limit: 10,
      }),
    );
    expect(none).toHaveLength(0);
  });
});

describe("createEmployeeAdvance (spec:2082)", () => {
  it("drafts one line at the requested amount and reports the outstanding balance from the LEDGER", async () => {
    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      advanceBalance(tx, { companyId: s.company, employeeId: f.employeeAId, asOf: "2026-01-31" }),
    );
    expect(before.toString()).toBe("0.0000");
    const documentId = await postEmployeeAdvance(db, s, f, {
      employeeId: f.employeeAId,
      amount: "250.0000",
      reason: "Advance against February",
    });
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) => readMoneyOut(tx, documentId));
    expect(r.typeCode).toBe("EMPLOYEE_ADVANCE");
    expect(r.series).toBe("ADV");
    expect(r.employeeCount).toBe(1);
    expect(r.total.toString()).toBe("250.0000");
    expect(r.notes).toBe("advance:Advance against February");

    const balance = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      advanceBalance(tx, { companyId: s.company, employeeId: f.employeeAId, asOf: "2026-01-31" }),
    );
    expect(balance.toString()).toBe("250.0000"); // debit 1400 tagged EMPLOYEE, nothing recovered yet
    const earlier = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      advanceBalance(tx, { companyId: s.company, employeeId: f.employeeAId, asOf: "2026-01-09" }),
    );
    expect(earlier.toString()).toBe("0.0000"); // as of a date before the advance
    const other = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      advanceBalance(tx, { companyId: s.company, employeeId: f.employeeBId, asOf: "2026-01-31" }),
    );
    expect(other.toString()).toBe("0.0000"); // tagged per employee
  });

  it("refuses a non-positive amount, a blank reason and a foreign currency", async () => {
    const base = {
      companyId: s.company,
      employeeId: f.employeeAId,
      effectiveDate: "2026-01-10",
      branchId: s.hq,
      reason: "x",
    };
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createEmployeeAdvance(tx, ctxOf(s.human), { ...base, amount: Money.zero(MYR) }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: an advance must be greater than zero/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createEmployeeAdvance(tx, ctxOf(s.human), {
          ...base,
          amount: Money.of("10.0000", MYR),
          reason: "  ",
        }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: an advance needs a reason/);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createEmployeeAdvance(tx, ctxOf(s.human), {
          ...base,
          amount: Money.of("10.0000", currency("USD")),
        }),
      ),
    ).rejects.toThrow(/base currency MYR, not USD/);
  });

  it("refuses an employee of another company", async () => {
    const other = await seedTenantV2(db, "Other co");
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        createEmployeeAdvance(tx, ctxOf(s.human), {
          companyId: s.company,
          employeeId: other.company,
          effectiveDate: "2026-01-10",
          branchId: s.hq,
          amount: Money.of("10.0000", MYR),
          reason: "wrong employee",
        }),
      ),
    ).rejects.toThrow(MoneyOutError);
  });
});

describe("payrollBatchCsv (spec:2083 — bank-neutral)", () => {
  it("emits the fixed header and one quoted row per employee, CRLF-terminated", () => {
    const csv = payrollBatchCsv([
      {
        employeeNumber: "E-1",
        employeeName: 'Aisyah, binti "Omar"',
        bankAccountMasked: "****",
        amount: "1234.5000",
        currency: "MYR",
        reference: "PAYB-1",
      },
    ]);
    const [header, row, end] = csv.split("\r\n");
    expect(header).toBe(BATCH_CSV_HEADER.join(","));
    expect(row).toBe('E-1,"Aisyah, binti ""Omar""",****,1234.5000,MYR,PAYB-1');
    expect(end).toBe("");
  });

  it("carries no bank-specific field — the header is exactly six columns", () => {
    expect(BATCH_CSV_HEADER).toEqual([
      "employee_number",
      "employee_name",
      "bank_account",
      "amount",
      "currency",
      "reference",
    ]);
  });

  it("neutralises a text cell a spreadsheet would read as a formula, never the amount", () => {
    const csv = payrollBatchCsv([
      {
        employeeNumber: "=1+1",
        employeeName: "@SUM(A1)",
        bankAccountMasked: "****",
        amount: "10.0000",
        currency: "MYR",
        reference: "-x",
      },
    ]);
    expect(csv.split("\r\n")[1]).toBe("'=1+1,'@SUM(A1),****,10.0000,MYR,'-x");
  });
});

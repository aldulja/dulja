import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import { generateStatutorySchedule, readSchedule } from "../../src/hr/schedule";
import {
  RemittanceError,
  settleStatutorySchedule,
  unsettleStatutorySchedule,
} from "../../src/hr/remittance";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenantV2, type Seed } from "../fixtures";
import { postFromPack } from "../../../../tests/invariants/support/ar-ap";
import {
  moneyOutFixture,
  postRemittance,
  type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";

// 8C T8 — remittance settlement (spec:2082). Figures come from 8B's SYNTH table through payrollFixture (hazard 1):
// the fixture run's schedule totals 100.0000 employee + 200.0000 employer = 300.0000.
//
// THE FILE'S ORDER IS LOAD-BEARING: there is exactly one schedule per run per scheme, by design. The first describe
// leaves it settled, the second unsettles and re-settles it, the third proves one payment settles one schedule, and
// the last moves the totals deliberately and must stay last.

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
let scheduleId: string;
let total: string;
const ctx = () => ({ tenantId: s.tenant, actorId: s.human, requestId: REQUEST_ID });
const settle = (remittanceDocumentId: string, companyId?: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    settleStatutorySchedule(tx, ctx(), {
      scheduleId,
      remittanceDocumentId,
      ...(companyId === undefined ? {} : { companyId }),
    }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Remittance");
  f = await moneyOutFixture(db, s);
  const [schedule] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
    generateStatutorySchedule(tx, ctx(), new MemoryObjectStore(), {
      companyId: s.company,
      payrollDocumentId: f.payrollDocumentId,
    }),
  );
  scheduleId = schedule!.scheduleId;
  total = schedule!.totalEmployee.add(schedule!.totalEmployer).toString();
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("settleStatutorySchedule (spec:2082; the 0091 trigger is the control)", () => {
  it("the remittance's ledger is exactly credit 1100 = X and debit the scheme's payable = X", async () => {
    const payment = await postRemittance(db, s, f, {
      amount: "1.0000",
      effectiveDate: "2026-02-10",
    });
    const legs = await db.admin<{ code: string; debit: string; credit: string }[]>`
      select a.code, le.debit::text as debit, le.credit::text as credit
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${payment} order by a.code`;
    const [payable] = await db.admin<{ code: string }[]>`
      select a.code from app.statutory_scheme sc join app.account a on a.id = sc.payable_account_id
       where sc.id = ${f.schemeId}`;
    expect(legs).toEqual([
      { code: "1100", debit: "0.0000", credit: "1.0000" },
      { code: payable!.code, debit: "1.0000", credit: "0.0000" },
    ]);
  });

  it("refuses a payment for a different amount, naming both figures", async () => {
    const wrong = await postRemittance(db, s, f, { amount: "299.9900" });
    await expect(settle(wrong)).rejects.toThrow(
      new RegExp(
        `ERR_PAYROLL_REMITTANCE_MISMATCH: schedule ${scheduleId} settles 300\\.0000, payment ${wrong} moves 299\\.9900`,
      ),
    );
  });

  it("refuses a document that is not a PAYMENT, and a PAYMENT to another party, before the amount is looked at", async () => {
    // The run itself: posted, but no remittance (spec:2082 — a remittance is an ordinary PAYMENT).
    await expect(settle(f.payrollDocumentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: document .* is a PAYROLL; a statutory remittance is a PAYMENT/,
    );
    const other = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.party (tenant_id, company_id, kind, code, name_en, payable_account_id)
        select ${s.tenant}, ${s.company}, 'vendor', 'OTHER-VENDOR', 'Some other vendor', ss.payable_account_id
          from app.statutory_scheme ss where ss.id = ${f.schemeId}
        returning id`;
      return row!.id;
    });
    const { documentId } = await postFromPack(db, s, {
      code: "PAYMENT",
      effectiveDate: "2026-02-15",
      partyId: other,
      lines: [{ kind: "account", accountId: f.bankAccountId, amount: total }],
    });
    await expect(settle(documentId)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: payment .* is not made to scheme .*'s authority party/,
    );
  });

  it("links a payment for exactly the schedule total, and readSchedule reports it", async () => {
    const payment = await postRemittance(db, s, f, { amount: total });
    const settled = await settle(payment, s.company);
    expect(settled.remittanceDocumentId).toBe(payment);
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.remittanceDocumentId).toBe(payment);
  });

  it("refuses to settle an already-settled schedule, naming the payment that holds it", async () => {
    const second = await postRemittance(db, s, f, { amount: total, effectiveDate: "2026-02-16" });
    await expect(settle(second)).rejects.toThrow(
      /ERR_VALIDATION_FAILED: statutory schedule .* is already settled by payment /,
    );
  });

  it("raises ERR_NOT_FOUND for a schedule that is not visible, or not in the scoped company", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        settleStatutorySchedule(tx, ctx(), {
          scheduleId: "00000000-0000-7000-8000-000000000000",
          remittanceDocumentId: f.payrollDocumentId,
        }),
      ),
    ).rejects.toThrow(RemittanceError);
    await expect(
      settle(f.payrollDocumentId, "00000000-0000-7000-8000-000000000000"),
    ).rejects.toThrow(/ERR_NOT_FOUND: statutory schedule .* is not visible/);
  });
});

describe("unsettleStatutorySchedule (spec:2049 — unlinked, never edited)", () => {
  it("refuses an empty reason", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "   " }),
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: unsettling a schedule needs a reason/);
  });

  it("unsettle → settle with a DIFFERENT, correct payment succeeds — the guard is on the VALUE", async () => {
    const cleared = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "paid from the wrong account" }),
    );
    expect(cleared.remittanceDocumentId).toBeNull();
    const replacement = await postRemittance(db, s, f, {
      amount: total,
      effectiveDate: "2026-02-17",
    });
    const settled = await settle(replacement);
    expect(settled.remittanceDocumentId).toBe(replacement);
  });

  it("unsettling an unsettled schedule is ERR_NOT_FOUND, not a silent no-op", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "clearing for the next case" }),
    );
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "again" }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: statutory schedule .* is not visible or is not settled/);
  });

  it("nothing was DELETED: every remittance is still posted (spec:2049)", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${s.company} and t.code = 'PAYMENT' and d.status = 'posted'`;
    expect(row!.n).toBeGreaterThanOrEqual(6);
  });
});

describe("one PAYMENT settles exactly one schedule", () => {
  let payment: string;
  let twin: string;

  beforeAll(async () => {
    payment = await postRemittance(db, s, f, { amount: total, effectiveDate: "2026-02-18" });
    await settle(payment);
    // A second, unsettled schedule with the same totals (a stand-in for a supplementary run of the same period).
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
      insert into app.statutory_schedule (tenant_id, company_id, scheme_id, period_start, period_end,
                                          payroll_document_id, total_employee, total_employer, currency)
      select tenant_id, company_id, scheme_id, period_start, period_end, ${payment},
             total_employee, total_employer, currency
        from app.statutory_schedule where id = ${scheduleId}
      returning id`,
    );
    twin = row!.id;
  }, 120_000);

  it("the service refuses a payment that already settles another schedule", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        settleStatutorySchedule(tx, ctx(), { scheduleId: twin, remittanceDocumentId: payment }),
      ),
    ).rejects.toThrow(
      new RegExp(
        `ERR_VALIDATION_FAILED: payment ${payment} already settles statutory schedule ${scheduleId}`,
      ),
    );
  });

  it("…and so does the database, by direct app_rw SQL (0091's statutory_schedule_remittance_key)", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
        update app.statutory_schedule set remittance_document_id = ${payment} where id = ${twin}`,
      ),
    ).rejects.toThrow(/statutory_schedule_remittance_key/);
  });
});

describe("the 0091 guard covers the TOTALS, not only the link — LAST, it leaves the totals moved", () => {
  it("refuses a move of total_employee on a SETTLED schedule, as app_rw", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx`
        update app.statutory_schedule set total_employee = total_employee + 1 where id = ${scheduleId}`,
      ),
    ).rejects.toThrow(
      /ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles 301\.0000, payment .* moves 300\.0000/,
    );
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.totalEmployee.add(read.totalEmployer).toString()).toBe(total);
  });

  it("allows the same move once the schedule is UNSETTLED — the guard is about a claim, not the column", async () => {
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      unsettleStatutorySchedule(tx, ctx(), { scheduleId, reason: "correcting the totals" }),
    );
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
      update app.statutory_schedule set total_employee = total_employee + 1 where id = ${scheduleId}`,
    );
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) => readSchedule(tx, scheduleId));
    expect(read.totalEmployee.add(read.totalEmployer).toString()).toBe("301.0000");
  });
});

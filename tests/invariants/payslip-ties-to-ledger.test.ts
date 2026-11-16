// Acceptance test 30 (spec:2448) — "For every employee in a run: payslip net = credit to salaries payable tagged
// EMPLOYEE; Σ(employee + employer share) per scheme = credit to that scheme's payable; the monthly schedule per scheme
// equals that payable to the cent; a remittance for a different amount is refused." Four clauses, four `it`s, plus
// Phase 8's DoD clause "Σ payslip net = salaries-payable credit". 8C Task 8. Figures are the synthetic SYNTH table's
// (hazard 1): two employees, net 1950.0000 each, scheme shares 50.0000 + 100.0000 each.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The PRODUCTION withTenant (§4.2.2): root `tests/` never uses the 4-argument test helper.
import {
  generateStatutorySchedule,
  MemoryObjectStore,
  readPayrollRun,
  settleStatutorySchedule,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { Money, currency } from "@dulja/domain";
import { seedTenantV2, startDb, type Db, type Seed } from "@dulja/db/test";
import {
  moneyOutFixture,
  postPayrollPayment,
  postRemittance,
  type MoneyOutFixture,
} from "./support/payroll-money";

let db: Db;
let s: Seed;
let f: MoneyOutFixture;
let payableAccountId: string;
const store = new MemoryObjectStore();
const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const MYR = currency("MYR");

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test 30");
  f = await moneyOutFixture(db, s);
  // Clauses 2 and 3 measure "that scheme's payable", so they read the account off the SCHEME, never a code literal: a
  // re-ordered §4.15 would otherwise turn the clause into 0 = 0.
  const [payable] = await db.admin<{ payable_account_id: string | null }[]>`
    select payable_account_id from app.statutory_scheme where id = ${f.schemeId}`;
  if (!payable?.payable_account_id) {
    throw new Error(
      "statutory_scheme.payable_account_id is null — linkPayrollAccounts did not run",
    );
  }
  payableAccountId = payable.payable_account_id;
}, 240_000);
afterAll(async () => {
  await db.stop();
});

/** The base credit − debit on `code` on the run for ONE employee, read through the EMPLOYEE dimension tag. */
async function creditFor(code: string, employeeId: string): Promise<string> {
  const [row] = await db.admin<{ amount: string }[]>`
    select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      join app.ledger_entry_dimension led on led.entry_id = le.id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type  dt on dt.id = dv.dimension_type_id
      join app.employee e on e.company_id = le.company_id and e.employee_number = dv.code
     where le.company_id = ${s.company} and a.code = ${code}
       and dt.code = 'EMPLOYEE' and e.id = ${employeeId}
       and le.document_id = ${f.payrollDocumentId}`;
  return row!.amount;
}

/** The base credit − debit on one account on the run. */
async function movementOnRun(accountId: string): Promise<string> {
  const [row] = await db.admin<{ amount: string }[]>`
    select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
      from app.ledger_entry le
     where le.document_id = ${f.payrollDocumentId} and le.account_id = ${accountId}`;
  return row!.amount;
}

const run = () =>
  withTenant(db.rw, ctx(s.human), (tx) =>
    readPayrollRun(tx, f.payrollDocumentId, { companyId: s.company }),
  );
const sum = (amounts: readonly string[]) =>
  amounts.reduce((a, x) => a.add(Money.of(x, MYR)), Money.zero(MYR)).toString();

describe("acceptance test 30 — payslip ties to the ledger (spec:2448)", () => {
  it("clause 1: payslip net = the credit to salaries payable tagged EMPLOYEE, per employee", async () => {
    // `lines[].amount` is MoneySchema's object (8B); `.amount.amount` is the fixed-scale figure.
    const nets = new Map<string, string>();
    for (const line of (await run()).lines) {
      if (line.componentId === null && line.schemeId === null) {
        nets.set(line.employeeId, line.amount.amount);
      }
    }
    expect([...nets.keys()].toSorted()).toEqual([f.employeeAId, f.employeeBId].toSorted());
    for (const [employeeId, net] of nets) {
      expect(net).toBe("1950.0000");
      expect(await creditFor("2400", employeeId)).toBe(net);
    }
  });

  it("clause 2: Σ(employee + employer share) per scheme = the credit to that scheme's payable", async () => {
    const shares = (await run()).lines
      .filter((l) => l.schemeId === f.schemeId)
      .map((l) => l.amount.amount);
    expect(shares).toHaveLength(4); // two employees × two shares
    expect(await movementOnRun(payableAccountId)).toBe(sum(shares));
  });

  it("clause 3: the monthly schedule per scheme equals that payable TO THE CENT", async () => {
    const [schedule] = await withTenant(db.rw, ctx(s.human), (tx) =>
      generateStatutorySchedule(tx, ctx(s.human), store, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    // String equality, never toBeCloseTo: two figures that round differently are two figures (LEGACY-019).
    expect(schedule!.totalEmployee.add(schedule!.totalEmployer).toString()).toBe(
      await movementOnRun(payableAccountId),
    );
  });

  it("clause 4: a remittance for a different amount is refused, by the service AND by direct app_rw SQL", async () => {
    const [schedule] = await withTenant(db.rw, ctx(s.human), (tx) =>
      generateStatutorySchedule(tx, ctx(s.human), store, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    );
    const total = schedule!.totalEmployee.add(schedule!.totalEmployer);
    const wrongAmount = total.add(Money.of("0.0100", MYR)).toString(); // one cent over

    const wrong = await postRemittance(db, s, f, { amount: wrongAmount });
    await expect(
      withTenant(db.rw, ctx(s.human), (tx) =>
        settleStatutorySchedule(tx, ctx(s.human), {
          companyId: s.company,
          scheduleId: schedule!.scheduleId,
          remittanceDocumentId: wrong,
        }),
      ),
    ).rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH/);

    // …and through the door a service cannot guard.
    await expect(
      withTenant(
        db.rw,
        ctx(s.human),
        (tx) => tx`
        update app.statutory_schedule set remittance_document_id = ${wrong}
         where id = ${schedule!.scheduleId}`,
      ),
    ).rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH/);

    const right = await postRemittance(db, s, f, { amount: total.toString() });
    const settled = await withTenant(db.rw, ctx(s.human), (tx) =>
      settleStatutorySchedule(tx, ctx(s.human), {
        companyId: s.company,
        scheduleId: schedule!.scheduleId,
        remittanceDocumentId: right,
      }),
    );
    expect(settled.remittanceDocumentId).toBe(right);
    // The payable the run credited is cleared by the remittance that settled it.
    const [left] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
       where le.account_id = ${payableAccountId} and le.document_id in (${f.payrollDocumentId}, ${right})`;
    expect(left!.amount).toBe("0.0000");
  });
});

describe("the DoD clause: Σ payslip net = the salaries-payable credit for the whole run", () => {
  it("Σ over every employee equals 2400's movement on the run AND its period movement in account_balance", async () => {
    const sumNet = sum(
      (await run()).lines
        .filter((l) => l.componentId === null && l.schemeId === null)
        .map((l) => l.amount.amount),
    );
    const [onRun] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.document_id = ${f.payrollDocumentId} and a.code = '2400'`;
    expect(onRun!.amount).toBe(sumNet);
    // The run is the only document dated in January that touches 2400 (the batch pays on 2026-02-05).
    const [period] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(ab.base_credit) - sum(ab.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.account_balance ab
        join app.account a on a.id = ab.account_id
        join app.fiscal_period fp on fp.id = ab.fiscal_period_id
       where ab.company_id = ${s.company} and a.code = '2400'
         and date '2026-01-31' between fp.starts_on and fp.ends_on`;
    expect(period!.amount).toBe(sumNet);
  });

  it("and a posted PAYROLL_PAYMENT clears it back to zero for the employees it names", async () => {
    await postPayrollPayment(db, s, f, { effectiveDate: "2026-02-05" });
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le join app.account a on a.id = le.account_id
       where le.company_id = ${s.company} and a.code = '2400'`;
    expect(row!.amount).toBe("0.0000");
  });
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { MemoryObjectStore } from "../../src/attachment/object-store";
import {
  generateStatutorySchedule,
  listSchedules,
  readSchedule,
  SCHEDULE_CSV_HEADER,
  ScheduleError,
  scheduleCsv,
  type StatutoryScheduleResult,
} from "../../src/hr/schedule";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { seedPayrollRun, seedTenantV2, type Seed } from "../fixtures";
import { secondApprover } from "../../../../tests/invariants/support/payroll";
import {
  moneyOutFixture,
  type MoneyOutFixture,
} from "../../../../tests/invariants/support/payroll-money";

// 8C T7 — statutory schedules (spec:2083). Figures come from 8B's SYNTH table through payrollFixture (hazard 1):
// per employee BASIC 2000.0000, employee share 50.0000, employer share 100.0000 — so the schedule's totals are
// 100.0000 and 200.0000 over the two employees.

const REQUEST_ID = "00000000-0000-0000-0000-000000000000";
let db: Db;
let s: Seed;
let f: MoneyOutFixture;
let store: MemoryObjectStore;
let schemeCode: string;
let first: StatutoryScheduleResult;
const ctxOf = (actor: string) => ({ tenantId: s.tenant, actorId: actor, requestId: REQUEST_ID });

const generate = (extra: { schemeIds?: string[]; attachCsv?: boolean; payroll?: string } = {}) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    generateStatutorySchedule(tx, ctxOf(s.human), store, {
      companyId: s.company,
      payrollDocumentId: extra.payroll ?? f.payrollDocumentId,
      ...(extra.schemeIds === undefined ? {} : { schemeIds: extra.schemeIds }),
      ...(extra.attachCsv === undefined ? {} : { attachCsv: extra.attachCsv }),
    }),
  );

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Schedules");
  f = await moneyOutFixture(db, s);
  store = new MemoryObjectStore();
  // Read the scheme's code; never write it into an assertion. payrollFixture's scheme is `EPF` so that
  // linkPayrollAccounts wires it — only the RATE TABLE is SYNTH.
  const [scheme] = await db.admin<{ code: string }[]>`
    select code from app.statutory_scheme where id = ${f.schemeId}`;
  schemeCode = scheme!.code;
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("generateStatutorySchedule (spec:2083 — a record, from POSTED lines only)", () => {
  it("writes one row per scheme the run touched, with the employee and employer totals", async () => {
    const results = await generate();
    expect(results).toHaveLength(1); // payrollFixture seeds exactly one scheme
    first = results[0]!;
    expect(first.schemeId).toBe(f.schemeId);
    expect(first.schemeCode).toBe(schemeCode);
    expect(first.companyId).toBe(s.company);
    expect(first.periodStart).toBe("2026-01-01");
    expect(first.periodEnd).toBe("2026-01-31");
    expect(first.currency).toBe("MYR");
    expect(first.remittanceDocumentId).toBeNull();
    expect(first.rows.map((r) => r.employeeId)).toEqual([f.employeeAId, f.employeeBId]);
    for (const row of first.rows) {
      expect(row.employeeShare).toBe("50.0000");
      expect(row.employerShare).toBe("100.0000");
      expect(row.schemeReference).toBe("");
    }
    expect(first.totalEmployee.toString()).toBe("100.0000");
    expect(first.totalEmployer.toString()).toBe("200.0000");

    const [stored] = await db.admin<
      { total_employee: string; total_employer: string; generated_by: string }[]
    >`
      select total_employee::text, total_employer::text, generated_by
        from app.statutory_schedule where id = ${first.scheduleId}`;
    expect(stored).toEqual({
      total_employee: "100.0000",
      total_employer: "200.0000",
      generated_by: s.human,
    });
  });

  it("the totals are the scheme payable's credit on the run, to the cent (no other source)", async () => {
    const [row] = await db.admin<{ amount: string }[]>`
      select to_char(coalesce(sum(le.base_credit) - sum(le.base_debit), 0), 'FM999999999999990.0000') as amount
        from app.ledger_entry le
        join app.statutory_scheme sc on sc.payable_account_id = le.account_id
       where le.document_id = ${f.payrollDocumentId} and sc.id = ${f.schemeId}`;
    expect(first.totalEmployee.add(first.totalEmployer).toString()).toBe(row!.amount);
  });

  it("attaches the CSV under the PAYROLL run and records its sha256 on app.attachment", async () => {
    expect(first.attachmentId).not.toBeNull();
    const [att] = await db.admin<
      {
        mime_type: string;
        sha256: Buffer;
        object_key: string;
        byte_size: string;
        document_id: string;
        file_name: string;
      }[]
    >`
      select mime_type, sha256, object_key, byte_size::text, document_id, file_name
        from app.attachment where id = ${first.attachmentId}`;
    expect(att!.mime_type).toBe("text/csv");
    // §4.5.8: the owning document is the run (module hr → hr.payroll.read), never null (2C's default deny).
    expect(att!.document_id).toBe(f.payrollDocumentId);
    expect(att!.file_name).toBe(`${schemeCode}-2026-01-01.csv`);
    const object = await store.get(att!.object_key);
    expect(object).not.toBeNull();
    expect(createHash("sha256").update(object!.bytes).digest().equals(att!.sha256)).toBe(true);
    expect(Number(att!.byte_size)).toBe(object!.bytes.byteLength);
    expect(new TextDecoder().decode(object!.bytes)).toBe(scheduleCsv(first));
  });

  it("is idempotent on (scheme, period, run) — a second call returns the same row and keeps the same file", async () => {
    const again = await generate();
    const rows = await db.admin<{ id: string }[]>`
      select id from app.statutory_schedule where payroll_document_id = ${f.payrollDocumentId}`;
    expect(rows.map((r) => r.id)).toEqual([first.scheduleId]);
    expect(again[0]!.scheduleId).toBe(first.scheduleId);
    expect(again[0]!.attachmentId).toBe(first.attachmentId); // identical bytes: no second attachment
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.attachment where document_id = ${f.payrollDocumentId}`;
    expect(n!.n).toBe(1);
  });

  it("reads each scheme reference from the profile's `scheme_reference:<code>`, and a changed file is a NEW attachment, the old one archived", async () => {
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
      insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, extra)
      values (${s.tenant}, ${f.employeeAId}, '2026-01-01',
              ${tx.json({ [`scheme_reference:${schemeCode}`]: "SYNTH-REF-0001", "scheme_reference:OTHER": "nope" })})`,
    );
    const [regenerated] = await generate();
    expect(regenerated!.scheduleId).toBe(first.scheduleId);
    expect(regenerated!.rows.map((r) => r.schemeReference)).toEqual(["SYNTH-REF-0001", ""]);
    expect(regenerated!.attachmentId).not.toBe(first.attachmentId);

    const atts = await db.admin<{ id: string; archived: boolean }[]>`
      select id, archived_at is not null as archived from app.attachment
       where document_id = ${f.payrollDocumentId} order by created_at, id`;
    expect(atts).toEqual([
      { id: first.attachmentId, archived: true },
      { id: regenerated!.attachmentId, archived: false },
    ]);
    // The archived file still verifies against the hash it was recorded with — it was never rewritten.
    const [old] = await db.admin<{ object_key: string; sha256: Buffer }[]>`
      select object_key, sha256 from app.attachment where id = ${first.attachmentId}`;
    const bytes = (await store.get(old!.object_key))!.bytes;
    expect(createHash("sha256").update(bytes).digest().equals(old!.sha256)).toBe(true);
    first = regenerated!;
  });

  it("refuses a run that is not posted (spec:2083 'generated from posted lines only')", async () => {
    const draftRun = await seedPayrollRun(db, s, {
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      payDate: "2026-04-05",
      employeeIds: [f.employeeAId],
    });
    await expect(generate({ payroll: draftRun })).rejects.toThrow(
      /ERR_DOC_STATUS_ILLEGAL: payroll run .* is not posted \(status draft\)/,
    );
  });

  it("refuses a run of another company, and an id that is no run, as ERR_NOT_FOUND", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        generateStatutorySchedule(tx, ctxOf(s.human), store, {
          companyId: "00000000-0000-7000-8000-000000000000",
          payrollDocumentId: f.payrollDocumentId,
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND: payroll run .* is not visible in this company/);
  });

  it("refuses a named scheme the run carries no line of", async () => {
    const stranger = await uuidv7(db.admin);
    await expect(generate({ schemeIds: [f.schemeId, stranger] })).rejects.toThrow(
      new RegExp(`ERR_VALIDATION_FAILED: payroll run .* carries no line of scheme ${stranger}`),
    );
    // …and generates exactly the named one when it is on the run.
    const only = await generate({ schemeIds: [f.schemeId], attachCsv: false });
    expect(only.map((r) => r.schemeId)).toEqual([f.schemeId]);
  });

  it("refuses a generator without hr.compensation.read — the references would be silently blank", async () => {
    const officer = await secondApprover(db, s, ["hr.payroll.read", "hr.payroll.pay"]);
    const err = await withTenant(db.rw, s.tenant, officer, (tx) =>
      generateStatutorySchedule(tx, ctxOf(officer), store, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleError);
    expect((err as ScheduleError).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});

describe("scheduleCsv (OD-28's default — a GENERIC layout)", () => {
  it("has the five documented columns and names no authority, form or box", async () => {
    expect(SCHEDULE_CSV_HEADER).toEqual([
      "employee_number",
      "employee_name",
      "scheme_reference",
      "employee_share",
      "employer_share",
    ]);
    const [result] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, limit: 1 }),
    );
    const csv = scheduleCsv(result!);
    expect(csv.split("\r\n")[0]).toBe(SCHEDULE_CSV_HEADER.join(","));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/LHDN|EPF|KWSP|SOCSO|PERKESO|EIS|PCB|CP\d|borang/i);
  });

  it("neutralises a formula-leading text cell and quotes a comma, and leaves the shares untouched", () => {
    const MYR = currency("MYR");
    const csv = scheduleCsv({
      ...first,
      totalEmployee: Money.zero(MYR),
      rows: [
        {
          employeeId: f.employeeAId,
          employeeNumber: "-1",
          employeeName: '=HYPERLINK("x"), Ltd',
          schemeReference: "@ref",
          employeeShare: "0.0000",
          employerShare: "12.5000",
        },
      ],
    });
    expect(csv.split("\r\n")[1]).toBe(`'-1,"'=HYPERLINK(""x""), Ltd",'@ref,0.0000,12.5000`);
  });
});

describe("listSchedules and readSchedule", () => {
  it("readSchedule raises ERR_NOT_FOUND for an invisible id and for another company's scope", async () => {
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        readSchedule(tx, "00000000-0000-7000-8000-000000000000"),
      ),
    ).rejects.toThrow(ScheduleError);
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        readSchedule(tx, first.scheduleId, { companyId: "00000000-0000-7000-8000-000000000000" }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
    const read = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      readSchedule(tx, first.scheduleId, { companyId: s.company }),
    );
    expect(read.rows).toEqual(first.rows);
    expect(read.totalEmployee.toString()).toBe("100.0000");
    expect(read.attachmentId).toBe(first.attachmentId);
  });

  it("filters by settled state, by run and by period, and pages on (period_start, id)", async () => {
    const unsettled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, settled: false, limit: 100 }),
    );
    expect(unsettled.map((r) => r.scheduleId)).toEqual([first.scheduleId]);
    const settled = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, settled: true, limit: 100 }),
    );
    expect(settled).toEqual([]);
    const byRun = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, {
        companyId: s.company,
        payrollDocumentId: f.payrollDocumentId,
        limit: 100,
      }),
    );
    expect(byRun).toHaveLength(1);
    const later = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, { companyId: s.company, from: "2026-02-01", limit: 100 }),
    );
    expect(later).toEqual([]);
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSchedules(tx, {
        companyId: s.company,
        limit: 100,
        cursor: { periodStart: first.periodStart, id: first.scheduleId },
      }),
    );
    expect(after).toEqual([]);
  });
});

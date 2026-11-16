import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftDocument,
  grantCodes,
  seedAccount,
  seedStatutoryScheme,
  seedTenantV2,
  type Seed,
} from "../fixtures";
import { postJournal } from "../../../../tests/invariants/support/post-journal";

// 8C T1 — migration 0091: app.statutory_schedule (§4.6.1, round 18 B11) and the remittance-amount guard
// (spec:2082, acceptance test 30's fourth clause). Every figure is invented for this file (hazard 1).

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Sched A");
  b = await seedTenantV2(db, "Sched B");
  // `app.document` carries 6C's Form A `branch_isolation` (AS RESTRICTIVE): `s.human` needs a live, company-wide
  // role assignment before it may draft one. The codes are incidental; the role_assignment row is what matters.
  for (const s of [a, b]) await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** Every column §4.6.1 and amendment B11 name, with its type. */
const EXPECTED_COLUMNS: Readonly<Record<string, string>> = {
  id: "uuid",
  tenant_id: "uuid",
  company_id: "uuid",
  scheme_id: "uuid",
  period_start: "date",
  period_end: "date",
  payroll_document_id: "uuid",
  total_employee: "numeric",
  total_employer: "numeric",
  currency: "bpchar",
  attachment_id: "uuid",
  remittance_document_id: "uuid",
  generated_by: "uuid",
  created_at: "timestamptz",
};

describe("app.statutory_schedule (§4.6.1, amendment B11; spec:2083)", () => {
  it("has exactly the fourteen columns of §4.6.1 including B11's two, and no others", async () => {
    const rows = await db.admin<{ column_name: string; udt_name: string }[]>`
      select column_name, udt_name from information_schema.columns
       where table_schema = 'app' and table_name = 'statutory_schedule'
       order by column_name`;
    expect(Object.fromEntries(rows.map((r) => [r.column_name, r.udt_name]))).toEqual(
      EXPECTED_COLUMNS,
    );
  });

  it("is unique on (scheme_id, period_start, payroll_document_id) — one schedule per scheme per period per run", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.statutory_schedule'::regclass and contype = 'u'
         and pg_get_constraintdef(oid) like '%scheme_id%'`;
    expect(c!.def).toBe("UNIQUE (scheme_id, period_start, payroll_document_id)");
  });

  it("reports zero linter violations and is neither audit-exempt nor immutable", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "statutory_schedule")).toEqual([]);
    expect(AUDIT_EXEMPT.has("statutory_schedule")).toBe(false);
    expect(IMMUTABLE.has("statutory_schedule")).toBe(false);
  });

  it("stamps generated_by from the session and refuses a supplied value (SAH-044)", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH" });
    const docId = await draftDocument(db, a);
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.statutory_schedule
        (id, tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
         total_employee, total_employer, currency, generated_by)
      values (${id}, ${a.tenant}, ${a.company}, ${schemeId}, '2026-01-01', '2026-01-31', ${docId},
              10.0000, 20.0000, 'MYR', ${a.system})`,
    );
    const [row] = await db.admin<{ generated_by: string }[]>`
      select generated_by from app.statutory_schedule where id = ${id}`;
    expect(row!.generated_by).toBe(a.human); // the SESSION actor, not the supplied a.system
    const [audited] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where table_name = 'statutory_schedule' and row_id = ${id}`;
    expect(audited!.n).toBe(1);
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    const n = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.statutory_schedule`,
    );
    expect(n[0]!.n).toBe(0);
  });
});

describe("app.assert_remittance_matches_schedule (test 30's fourth clause)", () => {
  it("refuses a remittance whose bank leg differs from total_employee + total_employer", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_M" });
    const scheduleId = await insertSchedule(a, schemeId, "100.0000", "200.0000");
    const wrong = await postedRemittance(a, "299.0000");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        update app.statutory_schedule set remittance_document_id = ${wrong} where id = ${scheduleId}`,
      ),
    ).rejects.toThrow(
      /ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles 300\.0000, payment .* moves 299\.0000/,
    );
  });

  it("accepts a remittance whose bank leg equals the schedule total, to the cent", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_OK" });
    const scheduleId = await insertSchedule(a, schemeId, "100.0000", "200.0000");
    const right = await postedRemittance(a, "300.0000");
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${right} where id = ${scheduleId}`,
    );
    const [row] = await db.admin<{ remittance_document_id: string }[]>`
      select remittance_document_id from app.statutory_schedule where id = ${scheduleId}`;
    expect(row!.remittance_document_id).toBe(right);
  });

  it("refuses a remittance that is not posted", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_D" });
    const scheduleId = await insertSchedule(a, schemeId, "5.0000", "5.0000");
    const draft = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        update app.statutory_schedule set remittance_document_id = ${draft} where id = ${scheduleId}`,
      ),
    ).rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH: payment .* is not posted/);
  });

  it("refuses an INSERT that arrives already settled for the wrong amount", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_I" });
    const wrong = await postedRemittance(a, "7.0000");
    await expect(insertSchedule(a, schemeId, "4.0000", "4.0000", wrong)).rejects.toThrow(
      /ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles 8\.0000, payment .* moves 7\.0000/,
    );
  });

  it("refuses moving a SETTLED schedule's totals away from the payment that settled it", async () => {
    const schemeId = await seedStatutoryScheme(db, a, { code: "SYNTH_T" });
    const scheduleId = await insertSchedule(a, schemeId, "30.0000", "60.0000");
    const right = await postedRemittance(a, "90.0000");
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.statutory_schedule set remittance_document_id = ${right} where id = ${scheduleId}`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        update app.statutory_schedule set total_employee = 31.0000 where id = ${scheduleId}`,
      ),
    ).rejects.toThrow(/ERR_PAYROLL_REMITTANCE_MISMATCH: schedule .* settles 91\.0000/);
    // An unsettled row's totals move freely (the guard returns at its first statement).
    const open = await insertSchedule(a, schemeId, "1.0000", "1.0000");
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.statutory_schedule set total_employee = 2.0000 where id = ${open}`,
    );
  });
});

/** A schedule row against a fresh JOURNAL draft standing in for the run (the FK target only; the shape of a run is
 *  Task 7's business, not this table's). */
async function insertSchedule(
  s: Seed,
  schemeId: string,
  employee: string,
  employer: string,
  remittanceId: string | null = null,
): Promise<string> {
  const payrollId = await draftDocument(db, s);
  const id = await uuidv7(db.admin);
  await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.statutory_schedule
      (id, tenant_id, company_id, scheme_id, period_start, period_end, payroll_document_id,
       total_employee, total_employer, currency, remittance_document_id)
    values (${id}, ${s.tenant}, ${s.company}, ${schemeId}, '2026-01-01', '2026-01-31', ${payrollId},
            ${employee}, ${employer}, 'MYR', ${remittanceId})`,
  );
  return id;
}

/** A JOURNAL posted through the REAL postDocument with a CREDIT on `1100` — the leg the guard measures — and the
 *  balancing debit on 0A's `1000`. No hand-written ledger row. */
async function postedRemittance(s: Seed, amount: string): Promise<string> {
  const bank = await seedAccount(db, s, { code: "1100", nameEn: "Bank", type: "asset" });
  const { documentId } = await postJournal(db, s, [
    { account: s.cash, debit: amount },
    { account: bank, credit: amount },
  ]);
  return documentId;
}

import type { Sql } from "postgres";
/**
 * Migration 0126 — DBS-03 (full review 2026-11-15). A posted payroll is frozen for EVERY principal, not only for
 * one who can see its document: 0087's `forbid_payroll_line_change_unless_draft` read the parent status under the
 * caller's RLS and passed on NULL, so a principal restricted to another branch, or an employee holding no role,
 * rewrote a posted run's line; `payroll_run` had no freeze at all (its `pinned_tables` is the LEGACY-013 pin).
 * ADR 0074 and ADR 0076 amendments (2026-11-15), proposed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postDocument } from "../../src/posting";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedBranch,
  seedDocumentType,
  seedEmployee,
  seedTenantV2,
  type Seed,
} from "../fixtures";

const POLICY = {
  version: 1,
  documentType: "PAYROLL_DDL_TEST",
  direction: "none",
  requires: [],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "line.account" },
      amount: "line.debit",
      when: { "line.kind": "account" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "line.account" },
      amount: "line.credit",
      when: { "line.kind": "account" },
    },
  ],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "PDT", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.journal.post" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

let db: Db;
let a: Seed;
let typeId: string;
let b2: string;
let branchOnly: string; // a live role in company A restricted to branch B2
let employeeLogin: string; // E1's own login, no role at all
let officerEmployee: string; // a company-wide principal who is also an employee (R4)
let e1: string;
let eOfficer: string;
const ctxOf = (s: Seed) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** A run at HQ: a document, its payroll_run row, two lines and one payroll_line on the first. Posted unless asked. */
// Each run covers its own period (a January of its own year): one REGULAR run per company and period is a rule of
// its own (HRP-08), and every case here is about a single run.
let nextYear = 2000;
async function run(opts: { post: boolean; employeeId?: string }) {
  nextYear += 1;
  const from = `${nextYear}-01-01`;
  const to = `${nextYear}-01-31`;
  const d = await draftTypedDocument(db, a, {
    documentTypeId: typeId,
    series: "PDT",
    effectiveDate: "2026-01-31",
    lines: [
      { kind: "account", lineNo: 1, accountId: a.cash, debit: "8500.0000" },
      { kind: "account", lineNo: 2, accountId: a.sales, credit: "8500.0000" },
    ],
  });
  await withTenant(db.rw, a.tenant, a.human, async (tx) => {
    await tx`
      insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date,
                                   pinned_tables)
      values (${d.documentId}, ${a.tenant}, ${a.company}, 'regular', ${from}, ${to}, ${to},
              '[{"schemeId":"00000000-0000-0000-0000-000000000001","version":1}]'::jsonb)`;
    await tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${opts.employeeId ?? e1}, '8500.0000')`;
    if (opts.post) await postDocument(tx, ctxOf(a), { documentId: d.documentId });
  });
  return { ...d, payDate: to };
}

const amountOf = async (lineId: string) =>
  (
    await db.admin<{ amount: string }[]>`
      select amount::text from app.payroll_line where document_line_id = ${lineId}`
  )[0]!.amount;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "0126-freeze");
  typeId = await seedDocumentType(db, a, {
    code: "PAYROLL_DDL_TEST",
    module: "hr",
    policy: POLICY,
  });
  b2 = await seedBranch(db, a, { code: "B2" });
  branchOnly = await uuidv7(db.admin);
  employeeLogin = await uuidv7(db.admin);
  officerEmployee = await uuidv7(db.admin);
  await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
    for (const [id, n] of [
      [branchOnly, "Branch B2 clerk"],
      [employeeLogin, "Employee E1"],
      [officerEmployee, "Officer who is paid"],
    ] as const) {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${id}, ${`sub-${id}`}, 'human', ${n})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
    }
  });
  await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  await grantCodes(db, a, {
    codes: ["hr.payroll.read", "hr.payroll.prepare"],
    principalId: branchOnly,
    branchIds: [b2],
  });
  await grantCodes(db, a, {
    codes: ["hr.payroll.read", "hr.payroll.prepare"],
    principalId: officerEmployee,
  });
  e1 = await seedEmployee(db, a, { employeeNumber: "E1", principalId: employeeLogin });
  eOfficer = await seedEmployee(db, a, { employeeNumber: "E-OFF", principalId: officerEmployee });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("0126 — a posted payroll is frozen for everyone (DBS-03, LEGACY-031/041)", () => {
  it("a principal restricted to another branch cannot rewrite a posted run's line", async () => {
    const d = await run({ post: true });
    const [seen] = await withTenant(
      db.rw,
      a.tenant,
      branchOnly,
      (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.document where id = ${d.documentId}`,
    );
    expect(seen!.n).toBe(0);
    const touched = await withTenant(
      db.rw,
      a.tenant,
      branchOnly,
      (tx) =>
        tx`update app.payroll_line set amount = 1 where document_line_id = ${d.lineIds[0]!} returning amount`,
    ).catch((e: Error) => e);
    if (!(touched instanceof Error)) expect(touched.length).toBe(0);
    expect(await amountOf(d.lineIds[0]!)).toBe("8500.0000");
  });

  it("an employee holding no role cannot rewrite their own posted line", async () => {
    const d = await run({ post: true });
    const touched = await withTenant(
      db.rw,
      a.tenant,
      employeeLogin,
      (tx) =>
        tx`update app.payroll_line set amount = 2 where document_line_id = ${d.lineIds[0]!} returning amount`,
    ).catch((e: Error) => e);
    if (!(touched instanceof Error)) expect(touched.length).toBe(0);
    expect(await amountOf(d.lineIds[0]!)).toBe("8500.0000");
  });

  it("neither of them can see a payroll line or run whose document they cannot see", async () => {
    const d = await run({ post: true });
    for (const who of [branchOnly, employeeLogin]) {
      const [n] = await withTenant(
        db.rw,
        a.tenant,
        who,
        (tx) => tx<{ lines: number; runs: number }[]>`
          select (select count(*)::int from app.payroll_line where document_line_id = ${d.lineIds[0]!}) as lines,
                 (select count(*)::int from app.payroll_run where document_id = ${d.documentId}) as runs`,
      );
      expect(n).toEqual({ lines: 0, runs: 0 });
    }
  });

  it("a branch-B2 principal cannot rewrite a posted run's pay date, period or pinned tables", async () => {
    const d = await run({ post: true });
    const touched = await withTenant(
      db.rw,
      a.tenant,
      branchOnly,
      (tx) => tx`
        update app.payroll_run set pay_date = '2027-01-31', period_start = '2026-12-01', period_end = '2027-01-31',
               pinned_tables = '[{"schemeId":"x","version":9}]'::jsonb
         where document_id = ${d.documentId} returning document_id`,
    ).catch((e: Error) => e);
    if (!(touched instanceof Error)) expect(touched.length).toBe(0);
    const [r] = await db.admin<{ pay_date: string; pinned: unknown }[]>`
      select pay_date::text, pinned_tables as pinned from app.payroll_run where document_id = ${d.documentId}`;
    expect(r!.pay_date).toBe(d.payDate);
    expect(r!.pinned).toEqual([{ schemeId: "00000000-0000-0000-0000-000000000001", version: 1 }]);
  });

  it("payroll_run is frozen after draft for a principal who CAN see it — every column, LEGACY-013's pin included", async () => {
    const d = await run({ post: true });
    const id = d.documentId;
    const edits = [
      (tx: Sql) => tx`update app.payroll_run set pay_date = '2027-01-31' where document_id = ${id}`,
      (tx: Sql) =>
        tx`update app.payroll_run set period_start = period_start - 1 where document_id = ${id}`,
      (tx: Sql) => tx`update app.payroll_run set kind = 'supplementary' where document_id = ${id}`,
      (tx: Sql) =>
        tx`update app.payroll_run set pinned_tables = '[{"schemeId":"x","version":9}]'::jsonb where document_id = ${id}`,
      (tx: Sql) =>
        tx`update app.payroll_run set calculated_at = now() - interval '1 day' where document_id = ${id}`,
    ];
    for (const edit of edits) {
      await expect(withTenant(db.rw, a.tenant, a.human, edit)).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    }
  });

  it("a draft run's header and lines stay writable, and the recalculation cascade still runs", async () => {
    const d = await run({ post: false });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.payroll_run set pay_date = '2026-02-01', pinned_tables = '[]'::jsonb
                where document_id = ${d.documentId}`;
      await tx`update app.payroll_line set amount = '9000.0000' where document_line_id = ${d.lineIds[0]!}`;
      await tx`delete from app.document_line where document_id = ${d.documentId}`;
    });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where document_line_id = ${d.lineIds[0]!}`;
    expect(n!.n).toBe(0);
  });

  it("INSERT is guarded: no payroll_line is added to a posted run and no payroll_run to a posted document", async () => {
    const d = await run({ post: true });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
          values (${d.lineIds[1]!}, ${a.tenant}, ${a.company}, ${e1}, '1.0000')`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    const bare = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-31",
      lines: [
        { kind: "account", lineNo: 1, accountId: a.cash, debit: "1.0000" },
        { kind: "account", lineNo: 2, accountId: a.sales, credit: "1.0000" },
      ],
    });
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      postDocument(tx, ctxOf(a), { documentId: bare.documentId }),
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date)
          values (${bare.documentId}, ${a.tenant}, ${a.company}, 'regular', '1999-01-01', '1999-01-31', '1999-01-31')`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
  });

  it("a branch-B2 principal cannot add a line to a draft run at HQ (WITH CHECK needs a writable parent)", async () => {
    const d = await run({ post: false });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        branchOnly,
        (tx) => tx`
          insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
          values (${d.lineIds[1]!}, ${a.tenant}, ${a.company}, ${e1}, '1.0000')`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT|row-level security/);
  });

  it("R4 reaches payroll_line: nobody edits their own pay line, nor enters an override on it", async () => {
    const d = await run({ post: false, employeeId: eOfficer });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        officerEmployee,
        (tx) =>
          tx`update app.payroll_line set amount = '99999.0000' where document_line_id = ${d.lineIds[0]!}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        officerEmployee,
        (tx) => tx`
          insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount,
                                        override_reason, entered_by)
          values (${d.lineIds[1]!}, ${a.tenant}, ${a.company}, ${eOfficer}, '1.0000', 'mine', ${officerEmployee})`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    // Another employee's line is still theirs to edit while the run is a draft.
    const other = await run({ post: false });
    await withTenant(
      db.rw,
      a.tenant,
      officerEmployee,
      (tx) =>
        tx`update app.payroll_line set amount = '8600.0000' where document_line_id = ${other.lineIds[0]!}`,
    );
    expect(await amountOf(other.lineIds[0]!)).toBe("8600.0000");
  });
});

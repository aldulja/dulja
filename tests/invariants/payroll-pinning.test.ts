// 8B Task 14 — acceptance tests 29 (spec:2447) and 38 (spec:2456), and the PAYROLL re-runs of tests 9, 10 and 31
// (spec:2427, 2428, 2449). Every figure is the synthetic SYNTH table's or an in-test variant of it (hazard 1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The PRODUCTION withTenant, taking a TenantContext (§4.2.2, §4.2.12).
import {
  calculatePayrollRun,
  postDocument,
  readPayrollRun,
  systemContext,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedDocumentType,
  seedRateTable,
  seedTenantV2,
  startDb,
  type Db,
  type Seed,
} from "@dulja/db/test";
import {
  PAYROLL_PACK_ROOT,
  payrollFixture,
  postPayrollRun,
  secondApprover,
  SYNTH_TABLE,
  type PayrollFixture,
} from "./support/payroll";

let db: Db;
let s: Seed;
let f: PayrollFixture;
const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});
/** Test-side edits to audited rows, as the tenant's system principal (db.admin sets no tenant context). */
const asSystem = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.migrator, ctx(s.system), fn);
/**
 * A job's path: the context `apps/worker`'s `runJob` builds for every handler — `systemContext`, the tenant's system
 * principal resolved through `app.resolve_principal` (hazard 20) — and the same `withTenant` it runs inside.
 */
const asJob = async <T>(fn: (tx: Sql, jobCtx: TenantContext) => Promise<T>): Promise<T> => {
  const jobCtx = await systemContext(db.rw, s.tenant, "00000000-0000-0000-0000-000000000001");
  return withTenant(db.rw, jobCtx, (tx) => fn(tx, jobCtx));
};
const month = (start: string, end: string, pay: string) => ({
  companyId: s.company,
  kind: "regular" as const,
  periodStart: start,
  periodEnd: end,
  payDate: pay,
  effectiveDate: end,
  branchId: s.hq,
});

async function ledgerFingerprint(documentId: string): Promise<string> {
  const rows = await db.admin<{ line: string }[]>`
    select a.code || '|' || le.debit::text || '|' || le.credit::text || '|' || le.base_debit::text
             || '|' || le.base_credit::text as line
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId} order by le.line_no`;
  return rows.map((r) => r.line).join("\n");
}
const pinnedOf = async (documentId: string) =>
  (
    await db.admin<{ pinned_tables: { schemeId: string; version: number }[] }[]>`
      select pinned_tables from app.payroll_run where document_id = ${documentId}`
  )[0]!.pinned_tables;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Pinning");
  f = await payrollFixture(db, s); // twelve open 2026 periods; s.human holds hr.compensation.read
  await grantCodes(db, s, { codes: ["hr.payroll.prepare", "hr.payroll.read"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("acceptance test 29 — rate-table pinning (spec:2447, SAH-013, SAH-020)", () => {
  it("run M pins the version effective at M; a later version leaves M byte-identical", async () => {
    const january = await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const before = await ledgerFingerprint(january);
    expect(before.length).toBeGreaterThan(0);
    expect(await pinnedOf(january)).toEqual([{ schemeId: f.schemeId, version: 1 }]);

    // A LATER version arrives, effective from February. `effective_to` is the one column 8A's freeze leaves
    // writable on a verified row, which is how v1's window closes. Nothing about January may move.
    await asSystem(
      (tx) =>
        tx`update app.statutory_rate_table set effective_to = '2026-01-31' where id = ${f.rateTableId}`,
    );
    await seedRateTable(db, s, {
      schemeId: f.schemeId,
      version: 2,
      verified: true,
      definition: {
        ...SYNTH_TABLE,
        version: 2,
        effective_from: "2026-02-01",
        table: {
          bands: [{ from: "0.0000", to: null, employee: "999.0000", employer: "999.0000" }],
        },
      },
    });

    expect(await ledgerFingerprint(january)).toBe(before);
    expect(await pinnedOf(january)).toEqual([{ schemeId: f.schemeId, version: 1 }]);
    const detail = await withTenant(db.rw, ctx(s.human), (tx) => readPayrollRun(tx, january));
    const pinnedLines = detail.lines.filter((l) => l.schemeId !== null);
    expect(pinnedLines.length).toBeGreaterThan(0);
    for (const line of pinnedLines) expect(line.rateTableVersion).toBe(1);
  }, 180_000);

  it("a run in M+1 pins the NEW version, and its figures differ", async () => {
    const february = await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      payDate: "2026-03-05",
      effectiveDate: "2026-02-28",
    });
    expect(await pinnedOf(february)).toEqual([{ schemeId: f.schemeId, version: 2 }]);
    const detail = await withTenant(db.rw, ctx(s.human), (tx) => readPayrollRun(tx, february));
    const shares = detail.lines.filter((l) => l.share === "employee").map((l) => l.amount.amount);
    expect(new Set(shares)).toEqual(new Set(["999.0000"]));
  }, 180_000);

  it("a posted run's posting_policy_id is PINNED — a later policy version leaves it unchanged", async () => {
    // The other half of the DoD clause, "under pinned POLICY and rate-table versions". The run service never writes
    // the column; postDocument does (§4.3.2 step 13).
    const august = await postPayrollRun(db, s, f, {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      payDate: "2026-09-05",
      effectiveDate: "2026-08-31",
    });
    const [before] = await db.admin<{ policy: string | null; type: string }[]>`
      select posting_policy_id::text as policy, document_type_id::text as type
        from app.document where id = ${august}`;
    expect(before!.policy).not.toBeNull();

    // A LATER version of the same policy, effective IN the run's own month: app.effective_policy now resolves an
    // August document to version 9, which is what makes the assertion below non-vacuous.
    const envelope = JSON.parse(
      readFileSync(join(PAYROLL_PACK_ROOT, "document-types/PAYROLL.json"), "utf8"),
    ) as { policy: unknown };
    await seedDocumentType(db, s, {
      code: "PAYROLL",
      module: "hr",
      policy: envelope.policy,
      policyVersion: 9,
      effectiveFrom: "2026-08-01",
    });
    const [v9] = await db.admin<{ id: string; resolved: string }[]>`
      select p.id::text as id,
             (select pp.id::text from app.posting_policy pp
               where pp.document_type_id = ${before!.type}::uuid and pp.effective_from <= '2026-08-31'
               order by pp.effective_from desc, pp.version desc limit 1) as resolved
        from app.posting_policy p
       where p.document_type_id = ${before!.type}::uuid and p.version = 9`;
    expect(v9!.id).not.toBe(before!.policy);
    expect(v9!.resolved).toBe(v9!.id); // August now resolves to v9 …

    const [after] = await db.admin<{ policy: string | null }[]>`
      select posting_policy_id::text as policy from app.document where id = ${august}`;
    expect(after!.policy).toBe(before!.policy); // … and the posted run's pin did not move
    const pinned = await db.admin<{ policy: string }[]>`
      select distinct posting_policy_id::text as policy from app.ledger_entry where document_id = ${august}`;
    expect(pinned.map((p) => p.policy)).toEqual([before!.policy]);
  }, 180_000);

  it("an UNVERIFIED table refuses through the service and through a job's system principal", async () => {
    // The API leg of test 29 is apps/api/test/routes/hr/payroll-runs.test.ts ("an unverified rate table answers
    // 422 … through the wire"). A verified table cannot be un-verified (`verified_by` is a write-once stamp), so
    // the unverified table is LOADED: version 3 opens 2026-01-01 and is the highest version covering March.
    const v3 = await seedRateTable(db, s, {
      schemeId: f.schemeId,
      version: 3,
      verified: false,
      definition: { ...SYNTH_TABLE, version: 3 },
    });
    const march = month("2026-03-01", "2026-03-31", "2026-04-05");
    // (1) the service
    await expect(
      withTenant(db.rw, ctx(s.human), (tx) => calculatePayrollRun(tx, ctx(s.human), march)),
    ).rejects.toThrow(/ERR_PAYROLL_RATE_TABLE_UNVERIFIED/);
    // (2) a job's system principal passes app.actor_has (spec:2179) and is refused just the same
    await expect(asJob((tx, jobCtx) => calculatePayrollRun(tx, jobCtx, march))).rejects.toThrow(
      /ERR_PAYROLL_RATE_TABLE_UNVERIFIED/,
    );
    const [none] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_run where company_id = ${s.company} and period_start = '2026-03-01'`;
    expect(none!.n).toBe(0);

    // Verify it the ONE legal way, so the cases after this one have a usable table: a DIFFERENT principal issues
    // the statement 8A's verifyRateTable issues, inside withTenant so the stamp sees the session actor.
    await withTenant(
      db.rw,
      ctx(f.verifier),
      (
        tx,
      ) => tx`update app.statutory_rate_table set verified_at = now(), verified_by = app.current_actor()
                  where id = ${v3}`,
    );
    const [row] = await db.admin<{ verified_by: string | null }[]>`
      select verified_by::text as verified_by from app.statutory_rate_table where id = ${v3}`;
    expect(row!.verified_by).toBe(f.verifier);
  }, 180_000);
});

describe("acceptance test 38 — payroll period lock (spec:2456, SAH-031)", () => {
  it("a run whose period is CLOSED cannot post, and reopening with a reason is the only remedy", async () => {
    const [marchPeriod] = await db.admin<{ id: string }[]>`
      select id from app.fiscal_period where company_id = ${s.company}
         and '2026-03-31'::date between starts_on and ends_on`;
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), month("2026-03-01", "2026-03-31", "2026-04-05")),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: r.documentId, to: "approved" }),
    );

    await asSystem(
      (tx) => tx`update app.fiscal_period set status = 'closed' where id = ${marchPeriod!.id}`,
    );
    await expect(
      withTenant(db.rw, ctx(f.approver), (tx) =>
        postDocument(tx, ctx(f.approver), { documentId: r.documentId }),
      ),
    ).rejects.toThrow(/ERR_PERIOD_NOT_OPEN/);
    const [stillApproved] = await db.admin<{ status: string; n: number }[]>`
      select d.status::text as status,
             (select count(*)::int from app.ledger_entry le where le.document_id = d.id) as n
        from app.document d where d.id = ${r.documentId}`;
    expect(stillApproved).toEqual({ status: "approved", n: 0 });

    // The remedy is a reopen WITH A REASON, by a principal holding accounting.period.reopen (spec:2179).
    const reopener = await secondApprover(db, s, ["accounting.period.reopen"]);
    await withTenant(
      db.rw,
      ctx(reopener),
      (
        tx,
      ) => tx`update app.fiscal_period set status = 'open', reopen_reason = 'March payroll approved after close'
                  where id = ${marchPeriod!.id}`,
    );
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      postDocument(tx, ctx(f.approver), { documentId: r.documentId }),
    );
    const [doc] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(doc!.status).toBe("posted");

    // "the reopen is audited and reported" — the reason is a COLUMN so the audit row's after-image carries it.
    const [audit] = await db.admin<{ reason: string; actor: string }[]>`
      select (after->>'reopen_reason') as reason, actor_id::text as actor from app.audit_log
       where table_name = 'fiscal_period' and row_id = ${marchPeriod!.id}
       order by seq desc limit 1`;
    expect(audit).toEqual({ reason: "March payroll approved after close", actor: reopener });
  }, 180_000);

  it("test 9 re-run — a LOCKED period reaches the payroll LINES, not only the ledger (SAH-031)", async () => {
    const documentId = await postPayrollRun(db, s, f, {
      periodStart: "2026-04-01",
      periodEnd: "2026-04-30",
      payDate: "2026-05-05",
      effectiveDate: "2026-04-30",
    });
    const [period] = await db.admin<{ id: string }[]>`
      select fiscal_period_id as id from app.document where id = ${documentId}`;
    await asSystem(
      (tx) => tx`update app.fiscal_period set status = 'locked' where id = ${period!.id}`,
    );

    // The legacy failure was verbatim "Period locks … do not reach the line items". Three paths, one answer.
    const [line] = await db.admin<{ id: string }[]>`
      select pl.document_line_id as id from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${documentId} limit 1`;
    await expect(
      withTenant(
        db.rw,
        ctx(s.human),
        (tx) =>
          tx`update app.payroll_line set amount = '1.0000' where document_line_id = ${line!.id}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // Deleted through the PARENT: app_rw holds no DELETE on app.payroll_line (§3.5.4), so a direct delete would
    // prove only the grant. 2B's document_line guard is what refuses this.
    await expect(
      withTenant(
        db.rw,
        ctx(s.human),
        (tx) => tx`delete from app.document_line where id = ${line!.id}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(
      withTenant(
        db.rw,
        ctx(s.human),
        (tx) => tx`update app.ledger_entry set base_debit = 0 where document_id = ${documentId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE|permission denied/);
  }, 180_000);
});

describe("re-runs of tests 10 and 31 on PAYROLL (spec:2428, 2449)", () => {
  it("test 31 — the SUBMITTER cannot approve, through the service and through raw app_rw SQL", async () => {
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), month("2026-05-01", "2026-05-31", "2026-06-05")),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }),
    );
    // R1's token EXACTLY, never an alternation with ERR_RBAC_FORBIDDEN: 2B's trigger evaluates R1 before R2, and an
    // alternation would stay green if R1 were deleted and the case fell through to R2.
    const r1 = /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/;
    // (1) the service
    await expect(
      withTenant(db.rw, ctx(s.human), (tx) =>
        transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(r1);
    // (2) raw app_rw SQL — the trigger, not the handler, is the control (spec:2173)
    await expect(
      withTenant(
        db.rw,
        ctx(s.human),
        (tx) => tx`update app.document set status = 'approved' where id = ${r.documentId}`,
      ),
    ).rejects.toThrow(r1);
  }, 180_000);

  it("test 31 — R1 binds the system principal too: a job cannot approve what the same job submitted", async () => {
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), month("2026-09-01", "2026-09-30", "2026-10-05")),
    );
    await asJob((tx, jobCtx) =>
      transitionDocument(tx, jobCtx, { documentId: r.documentId, to: "submitted" }),
    );
    await expect(
      asJob((tx, jobCtx) =>
        transitionDocument(tx, jobCtx, { documentId: r.documentId, to: "approved" }),
      ),
    ).rejects.toThrow(
      /ERR_SOD_MAKER_IS_CHECKER: principal .* submitted document .* and cannot approve it/,
    );
    // … and a human second principal still can, because the submitting actor was the system principal.
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: r.documentId, to: "approved" }),
    );
    const [row] = await db.admin<{ status: string }[]>`
      select status::text as status from app.document where id = ${r.documentId}`;
    expect(row!.status).toBe("approved");
  }, 180_000);

  it("test 10 — a principal without hr.payroll.post cannot post, however it asks", async () => {
    const r = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), month("2026-06-01", "2026-06-30", "2026-07-05")),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: r.documentId, to: "submitted" }),
    );
    const halfAuthorised = await secondApprover(db, s, ["hr.payroll.approve", "hr.payroll.read"]);
    await withTenant(db.rw, ctx(halfAuthorised), (tx) =>
      transitionDocument(tx, ctx(halfAuthorised), { documentId: r.documentId, to: "approved" }),
    );
    await expect(
      withTenant(db.rw, ctx(halfAuthorised), (tx) =>
        postDocument(tx, ctx(halfAuthorised), { documentId: r.documentId }),
      ),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    const [row] = await db.admin<{ status: string; n: number }[]>`
      select d.status::text as status,
             (select count(*)::int from app.ledger_entry le where le.document_id = d.id) as n
        from app.document d where d.id = ${r.documentId}`;
    expect(row).toEqual({ status: "approved", n: 0 });
  }, 180_000);
});

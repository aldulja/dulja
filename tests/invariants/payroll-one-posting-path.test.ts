// Acceptance test 28 (spec:2446, SAH-003, SAH-009) — "the run posts through the posting service": a posted PAYROLL
// and a hand-keyed JOURNAL carrying the same lines produce identical ledger_entry and ledger_entry_dimension
// multisets on hazard 18's fixed projection. 8B Task 13. Figures are the synthetic SYNTH table's (hazard 1).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The PRODUCTION withTenant (§4.2.2, §4.2.12): root `tests/` never uses the 4-argument test helper.
import {
  calculatePayrollRun,
  postDocument,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { grantCodes, seedTenantV2, startDb, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";
import { payrollFixture, type PayrollFixture } from "./support/payroll";

let db: Db;
let s: Seed;
let f: PayrollFixture;
const ctx = (actor: string): TenantContext => ({
  tenantId: s.tenant,
  actorId: actor,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** Hazard 18's fixed projection: id, document_id, line_no, posted_at, posted_by and posting_policy_id are OUT. */
async function ledgerMultiset(documentId: string): Promise<string[]> {
  const rows = await db.admin<Record<string, string>[]>`
    select a.code as account_code, le.debit::text as debit, le.credit::text as credit, le.currency,
           le.exchange_rate::text as exchange_rate, le.base_debit::text as base_debit,
           le.base_credit::text as base_credit, to_char(le.effective_date, 'YYYY-MM-DD') as effective_date,
           le.fiscal_period_id::text as fiscal_period_id
      from app.ledger_entry le join app.account a on a.id = le.account_id
     where le.document_id = ${documentId}`;
  return rows.map((r) => JSON.stringify(r)).toSorted();
}

/** Each ledger row's dimensions, keyed by the row's own projection so a dimension cannot hop between rows. */
async function dimensionMultiset(documentId: string): Promise<string[]> {
  const rows = await db.admin<{ row: string; type_code: string; value_id: string }[]>`
    select a.code || '|' || le.debit::text || '|' || le.credit::text as row,
           dt.code as type_code, led.dimension_value_id::text as value_id
      from app.ledger_entry_dimension led
      join app.ledger_entry le on le.id = led.entry_id
      join app.account a on a.id = le.account_id
      join app.dimension_value dv on dv.id = led.dimension_value_id
      join app.dimension_type dt on dt.id = dv.dimension_type_id
     where le.document_id = ${documentId}`;
  return rows.map((r) => `${r.row}:${r.type_code}:${r.value_id}`).toSorted();
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Test28");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, {
    codes: ["hr.payroll.prepare", "accounting.journal.post", "accounting.journal.create"],
  });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("acceptance test 28 — one payroll posting path (spec:2446, SAH-003, SAH-009)", () => {
  it("a PAYROLL run and a hand-keyed JOURNAL with the same lines produce IDENTICAL ledger rows", async () => {
    // ── the PAYROLL side: employee A alone, so BRANCH is s.hq on both sides ──────────────────────────
    const run = await withTenant(db.rw, ctx(s.human), (tx) =>
      calculatePayrollRun(tx, ctx(s.human), {
        companyId: s.company,
        kind: "supplementary",
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        payDate: "2026-02-05",
        effectiveDate: "2026-01-15",
        branchId: s.hq,
        employeeIds: [f.employeeAId],
      }),
    );
    await withTenant(db.rw, ctx(s.human), (tx) =>
      transitionDocument(tx, ctx(s.human), { documentId: run.documentId, to: "submitted" }),
    );
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      transitionDocument(tx, ctx(f.approver), { documentId: run.documentId, to: "approved" }),
    );
    await withTenant(db.rw, ctx(f.approver), (tx) =>
      postDocument(tx, ctx(f.approver), { documentId: run.documentId }),
    );

    // ── the hand-keyed JOURNAL side, built FROM the payroll ledger so the figures cannot drift ──────
    const payrollRows = await db.admin<
      { code: string; debit: string; credit: string; dims: Record<string, string> }[]
    >`
      select a.code, le.debit::text as debit, le.credit::text as credit,
             coalesce(jsonb_object_agg(dt.code, led.dimension_value_id)
                        filter (where dt.code is not null), '{}'::jsonb) as dims
        from app.ledger_entry le
        join app.account a on a.id = le.account_id
        left join app.ledger_entry_dimension led on led.entry_id = le.id
        left join app.dimension_value dv on dv.id = led.dimension_value_id
        left join app.dimension_type dt on dt.id = dv.dimension_type_id
       where le.document_id = ${run.documentId}
       group by le.id, a.code, le.debit, le.credit, le.line_no
       order by le.line_no`;
    expect(payrollRows.length).toBeGreaterThan(0);
    // Every payroll ledger row carries BOTH dimensions (spec:2101), so the second comparison is not vacuous.
    for (const r of payrollRows)
      expect(Object.keys(r.dims).toSorted()).toEqual(["BRANCH", "EMPLOYEE"]);

    const accountIdByCode = new Map(
      (
        await db.admin<{ code: string; id: string }[]>`
          select code, id from app.account where company_id = ${s.company}`
      ).map((a) => [a.code, a.id]),
    );
    // `account`, not `accountId` — 1B's frozen JournalLine; `dimensions` is amendment A13's one member.
    const journal = await postJournal(
      db,
      s,
      payrollRows.map((r) => ({
        account: accountIdByCode.get(r.code)!,
        debit: r.debit,
        credit: r.credit,
        dimensions: r.dims,
      })),
      { effectiveDate: "2026-01-15" },
    );

    // ── the comparison, on hazard 18's fixed projection ─────────────────────────────────────────────
    expect(await ledgerMultiset(journal.documentId)).toEqual(await ledgerMultiset(run.documentId));
    expect(await dimensionMultiset(journal.documentId)).toEqual(
      await dimensionMultiset(run.documentId),
    );
  }, 180_000);

  it("the two documents pin DIFFERENT policies, which is why posting_policy_id is projected out", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(distinct posting_policy_id)::int as n from app.document
       where company_id = ${s.company} and posting_policy_id is not null`;
    expect(row!.n).toBeGreaterThanOrEqual(2);
  });
});

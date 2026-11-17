import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { postDocument } from "../../src/posting";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedEmployee,
  seedTenantV2,
  type Seed,
} from "../fixtures";

/** A JOURNAL-shaped policy over `account` lines. Task 4 seeds the real PAYROLL policy; this file only needs a
 *  posted document whose lines carry payroll_line rows, so it uses the simplest policy that posts.
 *
 *  `PAYROLL_DDL_TEST` / `PDT` is a REGISTERED test-only document-type code — §4.14, 8B amendment A15 (round 3,
 *  re-recorded in round 17). It is configured here through `seedDocumentType` and is never a file under
 *  `packages/db/seed/`. It cannot be the real `PAYROLL` type: that type's `approval` block names the payroll
 *  codes Task 3 seeds, and `validatePolicy` refuses a policy naming a code absent from the catalogue. */
const ACCOUNT_POLICY = {
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
let b: Seed;
let typeId: string;
let cashId: string;
let salesId: string;
let employeeId: string;
const ctxOf = (s: Seed) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "Alpha");
  b = await seedTenantV2(db, "Beta");
  // seedTenant already ships 1000 and 4000 (a.cash, a.sales); the plan's seedAccount calls would collide.
  cashId = a.cash;
  salesId = a.sales;
  typeId = await seedDocumentType(db, a, {
    code: "PAYROLL_DDL_TEST",
    module: "hr",
    policy: ACCOUNT_POLICY,
  });
  employeeId = await seedEmployee(db, a, { employeeNumber: "E-0001" });
  // A company-wide role: 2B's R2 asks for the post code, and 6C's branch isolation on app.employee and Form A
  // on app.document hide every row from a principal with no live role in the company.
  await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  await grantCodes(db, b, { codes: [] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const line = (documentLineId: string, amount: string) =>
  withTenant(
    db.rw,
    a.tenant,
    a.human,
    (tx) => tx`
    insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
    values (${documentLineId}, ${a.tenant}, ${a.company}, ${employeeId}, ${amount})`,
  );

describe("migration 0087 — payroll_run and payroll_line (§4.12.6, amendment A5)", () => {
  it("document_line.kind admits all six labels — the SAME union 6A's 0061 writes (§4.3.4)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'document_line_kind_check'`;
    for (const label of ["account", "item", "tax", "text", "tender", "payroll"]) {
      expect(c!.def).toContain(`'${label}'`);
    }
  });

  it("payroll_run is keyed on document_id and carries no id column (NO_ID_TABLES, §3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'payroll_run' order by 1`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "calculated_at",
      "calculated_by",
      "company_id",
      "created_at",
      "document_id",
      "kind",
      "pay_date",
      "period_end",
      "period_start",
      "pinned_tables",
      "tenant_id",
    ]);
  });

  it("payroll_line's three shapes are mutually exclusive — the policy's `when` filters cannot both match", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, component_id, scheme_id, share, amount)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${null}, ${null}, ${"employee"}, ${"100.0000"})`,
      ),
    ).rejects.toThrow(/payroll_line_shape_check/);
  });

  it("payroll_line.amount is a non-negative MAGNITUDE — side carries direction (§4.4.2 A9)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await expect(line(d.lineIds[0]!, "-1.0000")).rejects.toThrow(/payroll_line_amount_check/);
  });

  it("an override carries its reason AND the stamped principal, or neither (spec:2087)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount,
                                    override_reason, entered_by)
      values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, '1.0000',
              'agreed with the employee', ${a.system})`,
    );
    const [row] = await db.admin<{ entered_by: string | null }[]>`
      select entered_by::text as entered_by from app.payroll_line where document_line_id = ${d.lineIds[0]!}`;
    // The payload named the system principal; app.stamp_actor wrote the SESSION actor over it (LEGACY-044).
    expect(row!.entered_by).toBe(a.human);
    // A reason with no principal at all is refused: the write-once stamp fills a supplied column only.
    const n = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "1.0000" }],
    });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount, override_reason)
      values (${n.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, '1.0000', 'no principal named')`,
      ),
    ).rejects.toThrow(/payroll_line_override_check/);
    const e = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "1.0000" }],
    });
    // An actor with no reason is refused too: `entered_by` alone is not an override.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount, entered_by)
      values (${e.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, '1.0000', ${a.human})`,
      ),
    ).rejects.toThrow(/payroll_line_override_check/);
  });

  it("a POSTED run's payroll_line cannot be updated, and its parent line cannot be deleted — ERR_DOC_NOT_DRAFT (spec:2105, LEGACY-031/041)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [
        { kind: "account", lineNo: 1, accountId: cashId, debit: "100.0000" },
        { kind: "account", lineNo: 2, accountId: salesId, credit: "100.0000" },
      ],
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"100.0000"})`;
      await postDocument(tx, ctxOf(a), { documentId: d.documentId });
    });
    // UPDATE is app_rw's through default privileges, so this reaches 8B's own draft-only trigger.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      update app.payroll_line set amount = '5.0000' where document_line_id = ${d.lineIds[0]!}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    // DELETE is NOT app_rw's on app.payroll_line (§3.5.4's list is closed and 8B grants nothing): the only way
    // a payroll_line is ever removed is the CASCADE from its parent, so the parent is what the test deletes —
    // 2B's document_line_delete_draft_only refuses it on a posted document with the same token.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.document_line where id = ${d.lineIds[0]!}`,
      ),
    ).rejects.toThrow(/ERR_DOC_NOT_DRAFT/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.payroll_line where document_line_id = ${d.lineIds[0]!}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("a DRAFT run's payroll_line is removed by the CASCADE from its parent (spec:2081 — 'only while draft or submitted')", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [{ kind: "account", accountId: cashId, debit: "100.0000" }],
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
        values (${d.lineIds[0]!}, ${a.tenant}, ${a.company}, ${employeeId}, ${"100.0000"})`;
      await tx`update app.payroll_line set amount = '120.0000' where document_line_id = ${d.lineIds[0]!}`;
      // The recalculation path: the run service replaces `document_line` rows and the composite FK's
      // ON DELETE CASCADE takes the payroll_line with it. During that cascade the parent row is already gone,
      // which is exactly the state `app.forbid_payroll_line_change_unless_draft()` admits (its predicate is
      // `s is not null and s <> 'draft'`, 2B's shape).
      await tx`delete from app.document_line where id = ${d.lineIds[0]!}`;
    });
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where document_line_id = ${d.lineIds[0]!}`;
    expect(n!.n).toBe(0);
  });

  it("tenant B sees neither table's rows (test 12, spec:106)", async () => {
    const d = await draftTypedDocument(db, a, {
      documentTypeId: typeId,
      series: "PDT",
      effectiveDate: "2026-01-15",
      lines: [
        { kind: "account", lineNo: 1, accountId: cashId, debit: "7.0000" },
        { kind: "account", lineNo: 2, accountId: cashId, debit: "8.0000" },
      ],
    });
    await line(d.lineIds[0]!, "7.0000");
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.payroll_line`,
    );
    expect(seen[0]!.n).toBe(0);
    const runs = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.payroll_run`,
    );
    expect(runs[0]!.n).toBe(0);
    // And B cannot point a row of its own at A's line: the composite FK carries the tenant. Since 0126 the draft-only
    // guard reaches the row first and refuses it too, because B cannot read the parent (it fails closed, DBS-03).
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`
      insert into app.payroll_line (document_line_id, tenant_id, company_id, employee_id, amount)
      values (${d.lineIds[1]!}, ${b.tenant}, ${b.company}, ${employeeId}, '1.0000')`,
      ),
    ).rejects.toThrow(
      /violates foreign key constraint|violates row-level security|ERR_DOC_NOT_DRAFT/,
    );
  });

  it("the schema linter reports zero violations after 0087 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("a run's pinned_tables survives a round trip as jsonb (LEGACY-013 — what was originally applied)", async () => {
    const docId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, series, fiscal_period_id,
                                  effective_date, currency, exchange_rate, branch_id)
        values (${docId}, ${a.tenant}, ${a.company}, ${typeId}, 'PDT', ${a.period},
                '2026-01-31', 'MYR', '1.00000000', ${a.hq})`;
      await tx`
        insert into app.payroll_run (document_id, tenant_id, company_id, kind, period_start, period_end, pay_date, pinned_tables)
        values (${docId}, ${a.tenant}, ${a.company}, 'regular', '2026-01-01', '2026-01-31', '2026-02-05',
                ${JSON.stringify([{ schemeId: "s1", version: 3 }])}::text::jsonb)`;
    });
    const [row] = await db.admin<
      { pinned_tables: { schemeId: string; version: number }[]; calculated_by: string | null }[]
    >`
      select pinned_tables, calculated_by::text as calculated_by from app.payroll_run where document_id = ${docId}`;
    expect(row!.pinned_tables).toEqual([{ schemeId: "s1", version: 3 }]);
    expect(row!.calculated_by).toBe(a.human); // stamped by app.stamp_actor, never from a payload (LEGACY-044)
  });
});

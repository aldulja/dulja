import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculatePayrollRun } from "../../src/hr/run";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, noId } from "../../src/lint-schema";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, grantCodes, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import {
  payrollFixture,
  postPayrollRun,
  type PayrollFixture,
} from "../../../../tests/invariants/support/payroll";

// 8C T2 — migration 0092: app.employee_ytd (§4.12.8), app.employee_ytd_opening (spec:2084) and the one delta
// function (round 18 B6). Every figure comes from 8B's synthetic SYNTH table through payrollFixture: a BASIC of
// 2000.0000 gives an employee share of 50.0000 and an employer share of 100.0000 (hazard 1 — no real rate).

let db: Db;
let a: Seed;
let b: Seed;
let f: PayrollFixture;
const ctxOf = (s: Seed) => ({
  tenantId: s.tenant,
  actorId: s.human,
  requestId: "00000000-0000-0000-0000-000000000000",
});
const asHuman = <T>(s: Seed, fn: (tx: Sql) => Promise<T>) =>
  withTenant(db.rw, s.tenant, s.human, fn);

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "YTD A");
  b = await seedTenantV2(db, "YTD B");
  // payrollFixture grants `a.human` a company-wide role (6C's branch_isolation on employee and document);
  // `b.human` gets one here so tenant B's zero is RLS's, not branch isolation's.
  f = await payrollFixture(db, a);
  await grantCodes(db, a, { codes: ["hr.payroll.prepare"] });
  await grantCodes(db, b, { codes: ["hr.employee.read"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("app.employee_ytd (§4.12.8)", () => {
  it("is keyed on (company_id, employee_id, tax_year) and carries no id column", async () => {
    const [pk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.employee_ytd'::regclass and contype = 'p'`;
    expect(pk!.def).toBe("PRIMARY KEY (company_id, employee_id, tax_year)");
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'employee_ytd' and column_name = 'id'`;
    expect(cols).toEqual([]);
  });

  it("is in the no-id set and AUDIT_EXEMPT, and is not immutable (§3.5.3, round 18 B16 item 1)", () => {
    expect(noId.has("employee_ytd")).toBe(true);
    expect(AUDIT_EXEMPT.has("employee_ytd")).toBe(true);
    expect(IMMUTABLE.has("employee_ytd")).toBe(false); // the MERGE updates it every post
    // The opening is an ordinary audited table with an id.
    expect(noId.has("employee_ytd_opening")).toBe(false);
    expect(AUDIT_EXEMPT.has("employee_ytd_opening")).toBe(false);
  });

  it("reports zero linter violations for both new tables", async () => {
    const violations = await lintSchema(db.admin);
    expect(
      violations.filter((v) => v.table === "employee_ytd" || v.table === "employee_ytd_opening"),
    ).toEqual([]);
  });

  it("stamps employee_ytd_opening.loaded_by from the session and audits the row", async () => {
    const id = await uuidv7(db.admin);
    await asHuman(
      a,
      (tx) => tx`
      insert into app.employee_ytd_opening (id, tenant_id, company_id, employee_id, tax_year, gross, net, source, loaded_by)
      values (${id}, ${a.tenant}, ${a.company}, ${f.employeeAId}, 2025, 100.0000, 90.0000, 'manual:table test',
              ${a.system})`,
    );
    const [row] = await db.admin<{ loaded_by: string }[]>`
      select loaded_by from app.employee_ytd_opening where id = ${id}`;
    expect(row!.loaded_by).toBe(a.human);
    const [audited] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where table_name = 'employee_ytd_opening' and row_id = ${id}`;
    expect(audited!.n).toBe(1);
  });

  it("a second tenant cannot see either table's rows (spec:106)", async () => {
    await asHuman(
      a,
      (tx) => tx`
      insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net)
      values (${a.tenant}, ${a.company}, ${f.employeeBId}, 2030, 100.0000, 90.0000)`,
    );
    const seen = await asHuman(
      b,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`,
    );
    expect(seen[0]!.n).toBe(0);
    const openings = await asHuman(
      b,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.employee_ytd_opening`,
    );
    expect(openings[0]!.n).toBe(0);
    // …and tenant A sees its own.
    const own = await asHuman(
      a,
      (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.employee_ytd where tax_year = 2030`,
    );
    expect(own[0]!.n).toBe(1);
  });

  it("refuses an employee of another tenant (composite FK)", async () => {
    const foreign = await seedEmployee(db, b, { employeeNumber: "E-B-1" });
    await expect(
      asHuman(
        a,
        (tx) => tx`
        insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year)
        values (${a.tenant}, ${a.company}, ${foreign}, 2026)`,
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("app.employee_ytd_delta (round 18 B6 — THE one aggregation)", () => {
  type Delta = {
    employee_id: string;
    tax_year: number;
    gross: string;
    net: string;
    by_component: Record<string, string>;
    by_scheme: Record<string, { employee: string; employer: string }>;
  };
  const delta = (documentId: string) =>
    asHuman(
      a,
      (tx) => tx<Delta[]>`
        select employee_id, tax_year, gross::text as gross, net::text as net, by_component, by_scheme
          from app.employee_ytd_delta(${documentId}) order by employee_id`,
    );

  it("returns nothing for a document that is not a payroll run", async () => {
    // A real JOURNAL document (series JV), not a company id: no payroll_run row carries it.
    const journalId = await draftDocument(db, a);
    expect(await delta(journalId)).toEqual([]);
  });

  it("returns nothing for a DRAFT run — posted lines only (spec:2083)", async () => {
    const r = await asHuman(a, (tx) =>
      calculatePayrollRun(tx, ctxOf(a), {
        companyId: a.company,
        kind: "regular",
        periodStart: "2026-03-01",
        periodEnd: "2026-03-31",
        payDate: "2026-04-05",
        effectiveDate: "2026-03-31",
        branchId: a.hq,
      }),
    );
    expect(await delta(r.documentId)).toEqual([]);
  });

  it("groups a posted run by (employee, tax year) and builds by_component and by_scheme in SQL", async () => {
    const documentId = await postPayrollRun(db, a, f, {
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      payDate: "2027-01-05",
      effectiveDate: "2026-12-31",
    });
    const rows = await delta(documentId);
    expect(rows.map((r) => r.employee_id).toSorted()).toEqual(
      [f.employeeAId, f.employeeBId].toSorted(),
    );
    for (const row of rows) {
      expect(row.tax_year).toBe(2027); // round 18 B7 — the year of pay_date, not of the period
      expect(row.gross).toBe("2000.0000");
      expect(row.net).toBe("1950.0000"); // 2000 less the employee share; the employer share is in neither
      expect(row.by_component).toEqual({ BASIC: "2000.0000" });
      expect(row.by_scheme).toEqual({ EPF: { employee: "50.0000", employer: "100.0000" } });
    }
  });
});

describe("the jsonb money helpers (0092 §§4–5)", () => {
  it("jsonb_add_money ADDS key-wise and keeps fixed-scale strings, including a trailing zero", async () => {
    const [row] = await db.admin<{ v: Record<string, string> }[]>`
      select app.jsonb_add_money('{"A":"1.5000","B":"0.1000"}'::jsonb, '{"A":"2.0000","C":"10.0000"}'::jsonb) as v`;
    expect(row!.v).toEqual({ A: "3.5000", B: "0.1000", C: "10.0000" });
  });

  it("jsonb_add_scheme adds each share and fills a share the other side lacks with 0.0000", async () => {
    const [row] = await db.admin<{ v: Record<string, { employee: string; employer: string }> }[]>`
      select app.jsonb_add_scheme(
        '{"X":{"employee":"1.0000","employer":"2.0000"}}'::jsonb,
        '{"X":{"employee":"0.5000","employer":"0.5000"},"Y":{"employee":"3.0000","employer":"0.0000"}}'::jsonb) as v`;
    expect(row!.v).toEqual({
      X: { employee: "1.5000", employer: "2.5000" },
      Y: { employee: "3.0000", employer: "0.0000" },
    });
  });

  it("the aggregate forms fold rows with the same functions", async () => {
    const [row] = await db.admin<{ m: Record<string, string>; s: Record<string, unknown> }[]>`
      select app.jsonb_add_money_agg(c) as m, app.jsonb_add_scheme_agg(sc) as s
        from (values ('{"A":"1.0000"}'::jsonb, '{"X":{"employee":"1.0000","employer":"1.0000"}}'::jsonb),
                     ('{"A":"2.0000"}'::jsonb, '{"X":{"employee":"2.0000","employer":"0.0000"}}'::jsonb)) v(c, sc)`;
    expect(row!.m).toEqual({ A: "3.0000" });
    expect(row!.s).toEqual({ X: { employee: "3.0000", employer: "1.0000" } });
  });
});

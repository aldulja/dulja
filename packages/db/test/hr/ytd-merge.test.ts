import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currency, Money } from "@dulja/domain";
import { mergeEmployeeYtd } from "../../src/posting/ytd";
import { ytdFromEmployeeYtd } from "../../src/hr/ytd";
import { startDb, withTenant, type Db } from "../harness";
import { draftDocument, grantCodes, seedTenantV2, type Seed } from "../fixtures";
import {
  payrollFixture,
  postPayrollRun,
  type PayrollFixture,
} from "../../../../tests/invariants/support/payroll";
import { REPO_ROOT, sourceFiles } from "../../../../tests/support/source";

// 8C T3 — §4.3.2 step 12's employee_ytd MERGE (§4.12.8, round 18 B6/B7/B14). Every figure comes from 8B's SYNTH
// table through payrollFixture: BASIC 2000.0000, employee share 50.0000, employer share 100.0000 (hazard 1).

const MYR = currency("MYR");
let db: Db;
let s: Seed;
let f: PayrollFixture;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "YTD merge");
  f = await payrollFixture(db, s);
  await grantCodes(db, s, { codes: ["hr.payroll.prepare"] });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

type Row = {
  employee_id: string;
  tax_year: number;
  gross: string;
  net: string;
  by_component: Record<string, string>;
  by_scheme: Record<string, { employee: string; employer: string }>;
};
const projection = (year?: number) =>
  db.admin<Row[]>`
    select employee_id, tax_year, gross::text as gross, net::text as net, by_component, by_scheme
      from app.employee_ytd
     where company_id = ${s.company} and (${year ?? null}::int is null or tax_year = ${year ?? null}::int)
     order by employee_id, tax_year`;

describe("§4.3.2 step 12 — the employee_ytd MERGE (contracts §4.12.8)", () => {
  it("writes one row per employee per tax year when a PAYROLL run posts", async () => {
    await postPayrollRun(db, s, f, {
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      payDate: "2026-02-05",
      effectiveDate: "2026-01-31",
    });
    const rows = await projection();
    expect(rows).toHaveLength(2); // payrollFixture seeds two employees
    for (const row of rows) {
      expect(row.tax_year).toBe(2026);
      expect(row.gross).toBe("2000.0000");
      expect(row.net).toBe("1950.0000");
      expect(row.by_component).toEqual({ BASIC: "2000.0000" });
      expect(row.by_scheme).toEqual({ EPF: { employee: "50.0000", employer: "100.0000" } });
    }
  });

  it("ACCUMULATES a second period into the same row rather than replacing it", async () => {
    await postPayrollRun(db, s, f, {
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      payDate: "2026-03-05",
      effectiveDate: "2026-02-28",
    });
    const rows = await projection(2026);
    expect(rows).toHaveLength(2); // no new row: same employees, same year
    for (const row of rows) {
      expect(row.gross).toBe("4000.0000");
      expect(row.net).toBe("3900.0000");
      expect(row.by_component).toEqual({ BASIC: "4000.0000" });
      expect(row.by_scheme).toEqual({ EPF: { employee: "100.0000", employer: "200.0000" } });
    }
  });

  it("starts a NEW row when the pay date crosses into the next tax year (round 18 B7)", async () => {
    await postPayrollRun(db, s, f, {
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      payDate: "2027-01-05",
      effectiveDate: "2026-12-31",
    });
    const years = await db.admin<{ tax_year: number }[]>`
      select distinct tax_year from app.employee_ytd where company_id = ${s.company} order by tax_year`;
    expect(years.map((r) => r.tax_year)).toEqual([2026, 2027]);
    expect((await projection(2026))[0]!.gross).toBe("4000.0000"); // December's run did not land in 2026
  });

  it("the maintained row equals the fold of every posted run's delta (one aggregation, B6)", async () => {
    const [folded] = await db.admin<{ same: boolean }[]>`
      with deltas as (
        select d.* from app.payroll_run r
          join app.document doc on doc.id = r.document_id and doc.status = 'posted'
          cross join lateral app.employee_ytd_delta(r.document_id) d
         where r.company_id = ${s.company}
      ), rebuilt as (
        select company_id, employee_id, tax_year, sum(gross) as gross, sum(net) as net,
               app.jsonb_add_money_agg(by_component) as by_component,
               app.jsonb_add_scheme_agg(by_scheme) as by_scheme
          from deltas group by company_id, employee_id, tax_year
      )
      select not exists (
        (select company_id, employee_id, tax_year, gross, net, by_component::text, by_scheme::text from rebuilt
         except
         select company_id, employee_id, tax_year, gross, net, by_component::text, by_scheme::text
           from app.employee_ytd where company_id = ${s.company})
        union all
        (select company_id, employee_id, tax_year, gross, net, by_component::text, by_scheme::text
           from app.employee_ytd where company_id = ${s.company}
         except
         select company_id, employee_id, tax_year, gross, net, by_component::text, by_scheme::text from rebuilt)
      ) as same`;
    expect(folded!.same).toBe(true);
  });

  it("by_component and by_scheme are fixed-scale STRINGS, so a rebuild can compare them byte for byte", async () => {
    const [row] = await projection(2026);
    for (const v of Object.values(row!.by_component)) {
      expect(typeof v).toBe("string");
      expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }
    for (const share of Object.values(row!.by_scheme)) {
      expect(share.employee).toMatch(/^-?\d+\.\d{4}$/);
      expect(share.employer).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it("does nothing for a document that is not a PAYROLL run", async () => {
    const journalId = await draftDocument(db, s);
    const before = await db.admin<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`;
    const r = await withTenant(db.rw, s.tenant, s.human, (tx) => mergeEmployeeYtd(tx, journalId));
    expect(r.rows).toBe(0);
    const after = await db.admin<{ n: number }[]>`select count(*)::int as n from app.employee_ytd`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("ytdFromEmployeeYtd reads the projection as Money, keyed by employee then measure", async () => {
    const ytd = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId]),
    );
    expect(Object.keys(ytd)).toEqual([f.employeeAId]);
    expect(ytd[f.employeeAId]!.gross).toBeInstanceOf(Money);
    expect(ytd[f.employeeAId]!.gross!.currency).toBe(MYR);
    expect(ytd[f.employeeAId]!.gross!.toString()).toBe("4000.0000");
    expect(ytd[f.employeeAId]!.net!.toString()).toBe("3900.0000");
  });

  it("ytdFromEmployeeYtd adds the cut-over opening at READ time and never writes it into the projection (B14)", async () => {
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`
      insert into app.employee_ytd_opening (tenant_id, company_id, employee_id, tax_year, gross, net, source)
      values (${s.tenant}, ${s.company}, ${f.employeeBId}, 2026, 1000.0000, 800.0000, 'manual:merge test')`,
    );
    const ytd = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2026, [f.employeeAId, f.employeeBId]),
    );
    expect(ytd[f.employeeAId]!.gross!.toString()).toBe("4000.0000");
    expect(ytd[f.employeeBId]!.gross!.toString()).toBe("5000.0000");
    expect(ytd[f.employeeBId]!.net!.toString()).toBe("4700.0000");
    const [stored] = await db.admin<{ gross: string }[]>`
      select gross::text as gross from app.employee_ytd
       where employee_id = ${f.employeeBId} and tax_year = 2026`;
    expect(stored!.gross).toBe("4000.0000"); // the projection is Σ posted deltas only
  });

  it("ytdFromEmployeeYtd answers zeros for an employee with no posted run in the year", async () => {
    const ytd = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      ytdFromEmployeeYtd(tx, s.company, 2031, [f.employeeAId]),
    );
    expect(ytd[f.employeeAId]!.gross!.toString()).toBe("0.0000");
    expect(ytd[f.employeeAId]!.net!.toString()).toBe("0.0000");
  });
});

describe("the closed write list (§4.3.2, hazard 22)", () => {
  // `packages/db/src/integrity/` is NOT excluded: the nightly rebuild lives there and only ever reads. The one
  // exclusion besides the posting service is a test tree, which §3.7.5 grants.
  it("no shipped file outside packages/db/src/posting names app.employee_ytd in DML", () => {
    const offenders = sourceFiles(["apps", "packages"])
      .filter((file) => !file.path.startsWith("packages/db/src/posting/"))
      .filter((file) => !/(^|\/)tests?\//.test(file.path))
      .filter((file) =>
        /(insert\s+into|update|delete\s+from|merge\s+into)\s+app\.employee_ytd\b(?!_)/i.test(
          file.text,
        ),
      )
      .map((file) => file.path);
    expect(offenders).toEqual([]);
    expect(REPO_ROOT.length).toBeGreaterThan(0);
  });

  it("…and the posting service does, exactly once, in posting/ytd.ts", () => {
    const writers = sourceFiles(["packages/db/src/posting"]).filter((file) =>
      /merge\s+into\s+app\.employee_ytd\b(?!_)/i.test(file.text),
    );
    expect(writers.map((file) => file.path)).toEqual(["packages/db/src/posting/ytd.ts"]);
  });
});

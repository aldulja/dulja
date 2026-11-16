import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  currency,
  Money,
  parseReportDefinition,
  validateReportDefinition,
  type ReportDefinition,
} from "@dulja/domain";
import { DATASET_IDS } from "../../src/reports/datasets";
import { reportDefinitionSets } from "../../src/reports/definition-store";
import { assertDefinitionFields } from "../../src/reports/statement";
import { upsertEmployeeYtdOpening } from "../../src/hr";
import {
  CONTRACT_ENDS_ON,
  HR_CATALOGUE,
  HR_CATALOGUE_DIR,
  hrReportFixture,
  readHrDefinition,
  readHrEnvelope,
  type HrReportCode,
  type HrReportFixture,
} from "../../../../tests/invariants/support/hr-reports";
import {
  assertFieldCoverage,
  assertTieOut,
  runDefinition,
} from "../../../../tests/invariants/support/reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

// 8D T3–T6 — the eight §4.16.1 `hr.*` definitions, read off `packages/db/seed/my/reports/8d/` and executed against the
// payroll corpus (`hrReportFixture`, 8D A7). Tasks 4, 5 and 6 add their own describe blocks over the same fixture.
// Figures come from 8B's SYNTH table (hazard 1).

/** The three Task 3 ships. */
const ESTABLISHMENT = ["hr.employee_list", "hr.contract_expiry", "hr.attendance"] as const;

/**
 * Every 8D code whose JSON file is ON DISK right now. The validation case below iterates THIS and not `ESTABLISHMENT`,
 * so a definition written in a later task is schema-, registry- and catalogue-checked the moment its file lands, with
 * the offending JSON Pointer named. Tasks 4, 5 and 6 therefore add no validation case of their own.
 */
function shippedCodes(): HrReportCode[] {
  const onDisk = new Set(
    readdirSync(HR_CATALOGUE_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, "")),
  );
  return HR_CATALOGUE.filter((c) => onDisk.has(c));
}

/** Names test 32 forbids any HR report from carrying — a sensitive, compensation or statutory-profile field. */
const SIDE_CHANNEL_NAMES = [
  "national_id",
  "passport",
  "date_of_birth",
  "bank_account",
  "residency_category",
  "epf_number",
  "socso_number",
  "tax_number",
  "work_permit_expiry",
  "compensation",
  "statutory_profile",
  "marital_status",
  "child_relief",
] as const;

const MYR = currency("MYR");

let db: Db;
let s: Seed;
let f: HrReportFixture;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "hr-definitions");
  f = await hrReportFixture(db, s);
}, 300_000);
afterAll(async () => {
  await db.stop();
});

describe("the 8D report catalogue — contracts §4.16.1", () => {
  it("the directory holds only 8D's registered codes, named <code>.json", () => {
    const shipped = readdirSync(HR_CATALOGUE_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/, ""));
    for (const code of shipped) {
      expect(HR_CATALOGUE as readonly string[], `${code} is not an §4.16.1 8D code`).toContain(
        code,
      );
    }
    for (const code of ESTABLISHMENT) expect(shipped).toContain(code);
  });

  it("every shipped definition validates against the schema, the dataset registry, the catalogue and its dataset's fields", async () => {
    const sets = await withTenant(db.rw, s.tenant, s.human, (tx) => reportDefinitionSets(tx));
    const codes = shippedCodes();
    // Never vacuous: at Task 3 this is the three of ESTABLISHMENT, and it only grows.
    expect(codes).toEqual(expect.arrayContaining([...ESTABLISHMENT]));
    for (const code of codes) {
      const envelope = readHrEnvelope(code);
      // No 8D code is a re-expression (§4.16.1). `hr.annual_statement` is at 2 because 9B changed what it prints — the
      // cut-over opening added at read time, named in its footer (contracts round 18 B14) — and a changed statement is a
      // new row version, so a run records which basis it printed (the OD-28 runbook's own rule for a statement edit).
      expect(envelope.definitionVersion, code).toBe(code === "hr.annual_statement" ? 2 : 1);
      const result = validateReportDefinition(envelope.definition, sets);
      // `errors` first: it names the JSON Pointer and the rule, and `ok` alone names neither.
      expect(result.errors, code).toEqual([]);
      expect(result.ok, code).toBe(true);
      // The seed loader's own field-and-gate check (7A): a definition this passes is one `bun run seed --only
      // reports` applies.
      expect(() => assertDefinitionFields(envelope.definition), code).not.toThrow();
    }
  });

  it("no 8D definition declares a companyId parameter — the run's company is the route's, never a parameter", () => {
    // Phase 7's definitions declare none either: `rowsForDefinition` takes `companyId` as a named member, and a
    // declared `companyId` would be a free-text box on the run screen that the run ignores.
    for (const code of shippedCodes()) {
      expect(
        readHrDefinition(code).parameters.map((p) => p.name),
        code,
      ).not.toContain("companyId");
    }
  });

  it("every definition's module is the first segment of its code, and its permission is the register's", () => {
    const expected: Record<string, string> = {
      "hr.employee_list": "hr.employee.read",
      "hr.contract_expiry": "hr.employee.read",
      "hr.attendance": "hr.employee.read",
    };
    for (const code of ESTABLISHMENT) {
      const d = readHrDefinition(code);
      expect(d.code).toBe(code);
      expect(d.module).toBe(code.split(".")[0]);
      expect(d.permission).toBe(expected[code]);
      expect(d.layout.paper).toBe("A4"); // §4.5.9's three tokens; no fourth
      expect(DATASET_IDS as readonly string[]).toContain(d.dataset.source);
    }
  });

  it("each report returns rows over the fixture, and every field it names exists in its dataset", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      for (const code of ESTABLISHMENT) {
        const d = readHrDefinition(code);
        const rows = await runDefinition(tx, d, {
          companyId: s.company,
          fromDate: f.periodStart,
          toDate: f.periodEnd,
          asOf: "2026-12-31",
        });
        expect(rows.length, code).toBeGreaterThan(0);
        assertFieldCoverage(d, rows);
      }
    });
  });

  it("hr.employee_list lists every employee of the company once, by branch", async () => {
    const d = readHrDefinition("hr.employee_list");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // tieOut none → the row witness of 7B's A5: an independent read of app.employee.
      await assertTieOut(tx, d, {
        params: { companyId: s.company },
        baseCurrency: MYR,
        witness: {
          key: ["employee_number", "branch_code"],
          rows: (w) => w<Record<string, string | null>[]>`
            select e.employee_number, bv.code as branch_code
              from app.employee e join app.dimension_value bv on bv.id = e.home_branch_id
             where e.company_id = ${s.company}`,
        },
      });
      const onlyContract = await runDefinition(tx, d, {
        companyId: s.company,
        employmentType: "contract",
      });
      expect(onlyContract.map((r) => r.employee_number)).toEqual(["E-1099"]);
    });
  });

  it("hr.contract_expiry finds the fixed-term contractor and carries no permit column", async () => {
    const d = readHrDefinition("hr.contract_expiry");
    expect(d.columns.map((c) => c.field)).not.toContain("work_permit_expiry");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await runDefinition(tx, d, { companyId: s.company, asOf: "2026-12-31" });
      // Only an employee WITH a contract end on or before `asOf` — the two payroll employees have none.
      expect(rows.map((r) => String(r.employee_number))).toEqual(["E-1099"]);
      expect(rows[0]!.contract_ends_on).toBe(CONTRACT_ENDS_ON);
      // Before the end date, nobody is listed.
      const early = await runDefinition(tx, d, { companyId: s.company, asOf: "2026-03-30" });
      expect(early).toEqual([]);
    });
  });

  it("hr.attendance declares tieOut none — an attendance figure is NEVER a pay input (spec:2089)", async () => {
    const d = readHrDefinition("hr.attendance");
    expect(d.tieOut).toEqual({ kind: "none" });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // The local-day filter: 6 January (company time) holds three of the four events, the late 16:30Z clock-out
      // included (00:30 local on the 6th).
      const sixth = await runDefinition(tx, d, {
        companyId: s.company,
        fromDate: "2026-01-06",
        toDate: "2026-01-06",
      });
      expect(sixth.map((r) => r.kind)).toEqual(
        expect.arrayContaining(["clock_out", "clock_in", "manual_correction"]),
      );
      expect(sixth).toHaveLength(3);
      await assertTieOut(tx, d, {
        params: { companyId: s.company, fromDate: f.periodStart, toDate: f.periodEnd },
        baseCurrency: MYR,
        witness: {
          key: ["attendance_event_id"],
          rows: (w) => w<Record<string, string | null>[]>`
            select id::text as attendance_event_id from app.attendance_event where company_id = ${s.company}`,
        },
      });
    });
  });

  it("no 8D definition names a sensitive, compensation or statutory-profile field — test 32", () => {
    for (const code of shippedCodes()) {
      const text = JSON.stringify(readHrDefinition(code));
      for (const forbidden of SIDE_CHANNEL_NAMES) {
        expect(text, `${code} names ${forbidden}`).not.toContain(forbidden);
      }
      const d = readHrDefinition(code);
      const fields = [
        ...d.columns.map((c) => c.field),
        ...d.dataset.filters.map((x) => x.field),
        ...d.groups.map((g) => g.field),
        ...d.totals.map((t) => t.field),
        ...d.sort.map((k) => k.field),
      ];
      for (const field of fields) {
        for (const forbidden of SIDE_CHANNEL_NAMES) {
          expect(field, `${code} references ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });
});

describe("the three 8D money reports tie to the ledger — spec:2091, test 30's re-run (8D T4)", () => {
  const MONEY = [
    "hr.payroll_register",
    "hr.statutory_summary",
    "hr.payable_reconciliation",
  ] as const;

  it("each declares an executable tieOut whose first money sum total is a measure the harness maps (A10)", () => {
    expect(readHrDefinition("hr.payroll_register").tieOut).toEqual({
      kind: "ledger_sum",
      account: "2400",
    });
    expect(readHrDefinition("hr.payroll_register").totals[0]).toEqual({
      field: "net_contribution",
      fn: "sum",
    });
    expect(readHrDefinition("hr.statutory_summary").tieOut).toEqual({
      kind: "projection",
      projection: "statutory_schedule",
    });
    expect(readHrDefinition("hr.payable_reconciliation").tieOut).toEqual({ kind: "ledger_sum" });
    expect(readHrDefinition("hr.payable_reconciliation").totals[0]).toEqual({
      field: "payable_contribution",
      fn: "sum",
    });
    // None sums `amount`: 7B's firstMoneyTotal would throw "not in the closed measure map", and a run's earnings,
    // deductions and both shares added together equal nothing the ledger holds.
    for (const code of MONEY) {
      expect(
        readHrDefinition(code).totals.map((x) => x.field),
        code,
      ).not.toContain("amount");
    }
  });

  it("hr.payroll_register's net_contribution total equals the run's credit to salaries payable (2400)", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.payroll_register"), {
        params: { companyId: s.company, payrollDocumentId: f.runDocumentId },
        baseCurrency: MYR,
        // The run's own date window as well as its type and account (8D Self-Review question (f)): the ledger side has
        // no document filter, so without the dates a second posted run would be summed against this one's rows.
        window: {
          documentTypeCodes: ["PAYROLL"],
          accountCode: "2400",
          fromDate: f.periodStart,
          toDate: f.periodEnd,
        },
      });
      // Per employee the subtotal is that employee's net: SYNTH's 2000.0000 − 50.0000 for each of the two.
      const rows = await runDefinition(tx, readHrDefinition("hr.payroll_register"), {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
      });
      const byEmployee = new Map<string, Money>();
      for (const r of rows) {
        const key = String(r.employee_number);
        byEmployee.set(
          key,
          (byEmployee.get(key) ?? Money.zero(MYR)).add(Money.of(String(r.net_contribution), MYR)),
        );
      }
      expect([...byEmployee.values()].map((m) => m.toString())).toEqual(["1950.0000", "1950.0000"]);
      // The net-pay leg itself is a row of the register with a zero contribution — never counted twice.
      const legs = rows.filter((r) => r.component_id === null && r.scheme_id === null);
      expect(legs.length).toBe(2);
      for (const leg of legs) expect(String(leg.net_contribution)).toBe("0.0000");
    });
  });

  it("posted figures only: the February DRAFT run yields an empty register", async () => {
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      runDefinition(tx, readHrDefinition("hr.payroll_register"), {
        companyId: s.company,
        payrollDocumentId: f.draftRunDocumentId,
      }),
    );
    expect(rows).toEqual([]);
  });

  it("hr.statutory_summary equals every statutory_schedule row the period selects", async () => {
    expect(f.schedules.length).toBeGreaterThan(0);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.statutory_summary"), {
        params: { companyId: s.company, fromDate: f.periodStart, toDate: f.periodEnd },
        baseCurrency: MYR,
      });
      // February has no schedule: the harness refuses to compare nothing rather than passing.
      await expect(
        assertTieOut(tx, readHrDefinition("hr.statutory_summary"), {
          params: { companyId: s.company, fromDate: "2026-02-01", toDate: "2026-02-28" },
          baseCurrency: MYR,
        }),
      ).rejects.toThrow(/no rows|compare nothing/);
    });
  });

  it("hr.payable_reconciliation ties, once per scheme, to that scheme's own 241n payable", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // One assertion per (scheme, payable account) pair the company holds. Both sides are narrowed to the SAME
      // scheme — the report by `schemeCode`, the ledger by `accountCode`.
      const pairs = await tx<{ code: string; account: string }[]>`
        select sc.code, a.code as account
          from app.statutory_scheme sc join app.account a on a.id = sc.payable_account_id
         where sc.company_id = ${s.company} order by sc.code`;
      expect(pairs.length).toBeGreaterThan(0);
      for (const p of pairs) {
        await assertTieOut(tx, readHrDefinition("hr.payable_reconciliation"), {
          params: {
            companyId: s.company,
            fromDate: f.periodStart,
            toDate: f.periodEnd,
            schemeCode: p.code,
          },
          baseCurrency: MYR,
          window: {
            fromDate: f.periodStart,
            toDate: f.periodEnd,
            documentTypeCodes: ["PAYROLL"],
            accountCode: p.account,
          },
        });
      }
    });
  });

  it("hr.payable_reconciliation's net_contribution total, unfiltered, is the 2400 credit — both halves of §4.16.1's row", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await runDefinition(tx, readHrDefinition("hr.payable_reconciliation"), {
        companyId: s.company,
        fromDate: f.periodStart,
        toDate: f.periodEnd,
      });
      const reported = rows.reduce(
        (a, r) => a.add(Money.of(String(r.net_contribution), MYR)),
        Money.zero(MYR),
      );
      const [row] = await tx<{ credit: string }[]>`
        select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as credit
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.company_id = ${s.company} and a.code = '2400'
           and le.effective_date between ${f.periodStart}::date and ${f.periodEnd}::date`;
      expect(reported.toString()).toBe(Money.of(row!.credit, MYR).toString());
      expect(reported.toString()).toBe("3900.0000");
    });
  });

  it("the employee_ytd projection arm compares distinct (employee, year) pairs and each scheme's shares", async () => {
    // Registered by A6 and EXERCISED here over a probe definition, because the arm's shipped consumer
    // (`hr.annual_statement`) is Task 6's. `code` is a registered §4.16.1 literal (hazard 32): `assertTieOut` reads it
    // only to name itself in an error, and this object is never seeded or written to disk.
    const probe: ReportDefinition = parseReportDefinition({
      version: 1,
      code: "hr.payroll_register",
      nameEn: "employee_ytd tie-out probe",
      nameAr: "اختبار المطابقة السنوية",
      module: "hr",
      permission: "hr.payroll.read",
      parameters: [{ name: "taxYear", kind: "text", required: true }],
      dataset: {
        source: "employee_ytd",
        filters: [{ field: "tax_year", op: "eq", param: "taxYear" }],
      },
      columns: [
        {
          field: "employee_number",
          labelEn: "Number",
          labelAr: "الرقم",
          format: "text",
          align: "start",
        },
        { field: "tax_year", labelEn: "Year", labelAr: "السنة", format: "integer", align: "end" },
        { field: "gross", labelEn: "Gross", labelAr: "الإجمالي", format: "money", align: "end" },
        { field: "net", labelEn: "Net", labelAr: "الصافي", format: "money", align: "end" },
        {
          field: "scheme_code",
          labelEn: "Scheme",
          labelAr: "النظام",
          format: "text",
          align: "start",
        },
        {
          field: "scheme_employee",
          labelEn: "Employee share",
          labelAr: "حصة الموظف",
          format: "money",
          align: "end",
        },
        {
          field: "scheme_employer",
          labelEn: "Employer share",
          labelAr: "حصة صاحب العمل",
          format: "money",
          align: "end",
        },
      ],
      groups: [{ field: "employee_number", subtotal: true }],
      totals: [{ field: "scheme_employee", fn: "sum" }],
      sort: [{ field: "employee_number", dir: "asc" }],
      layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
      tieOut: { kind: "projection", projection: "employee_ytd" },
    });

    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // The corpus has rows to compare: 8C's step-12 MERGE ran when `hrReportFixture` posted the run.
      const [stored] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.employee_ytd where company_id = ${s.company}`;
      expect(stored!.n).toBe(2);
      await assertTieOut(tx, probe, {
        params: { companyId: s.company, taxYear: String(f.taxYear) },
        baseCurrency: MYR,
      });
      // A year with no projection row is refused, not passed vacuously.
      await expect(
        assertTieOut(tx, probe, {
          params: { companyId: s.company, taxYear: String(f.taxYear + 1) },
          baseCurrency: MYR,
        }),
      ).rejects.toThrow(/compare nothing|no rows/);
    });
  });

  it("no money definition names a rate, a threshold or a ceiling — hazard 1", () => {
    for (const code of MONEY) {
      const text = JSON.stringify(readHrDefinition(code));
      for (const forbidden of ["rate_percent", "threshold", "ceiling", "bracket", "relief"]) {
        expect(text, `${code} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("hr.payslip — the definition the payslip route renders (8D T5)", () => {
  it("declares tieOut none because 7B's ledger_sum has no dimension filter (A10); its total is the net", () => {
    const d = readHrDefinition("hr.payslip");
    expect(d.tieOut).toEqual({ kind: "none" });
    // The clause is proved instead by packages/db/test/hr/payslip.test.ts, in SQL, per employee and in total. This
    // assertion exists so a later slice does not "fix" the missing tie-out.
    expect(d.parameters.map((p) => p.name)).toEqual(["payrollDocumentId", "employeeId"]);
    // The total is the signed `net_contribution`, never `amount`: a payslip's earnings, deductions and the
    // employer's share added together are not a figure the employee is paid.
    expect(d.totals).toEqual([{ field: "net_contribution", fn: "sum" }]);
    expect(d.layout.paper).toBe("A5");
  });

  it("one employee's run of the definition returns exactly that employee's lines, and its total is their net", async () => {
    const d = readHrDefinition("hr.payslip");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const params = {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
        employeeId: f.payroll.employeeAId,
      };
      await assertTieOut(tx, d, {
        params,
        baseCurrency: MYR,
        witness: {
          key: ["payroll_line_id"],
          rows: (w) => w<Record<string, string | null>[]>`
            select pl.document_line_id::text as payroll_line_id
              from app.payroll_line pl join app.document_line dl on dl.id = pl.document_line_id
             where dl.document_id = ${f.runDocumentId} and pl.employee_id = ${f.payroll.employeeAId}`,
        },
      });
      const rows = await runDefinition(tx, d, params);
      const net = rows.reduce(
        (a, r) => a.add(Money.of(String(r.net_contribution), MYR)),
        Money.zero(MYR),
      );
      expect(net.toString()).toBe("1950.0000");
    });
  });
});

describe("hr.annual_statement — ⚠️ OD-28, form names are configuration (8D T6)", () => {
  it("is a definition over employee_ytd, gated hr.payroll.read, tying to the projection", () => {
    const d = readHrDefinition("hr.annual_statement");
    expect(d.dataset.source).toBe("employee_ytd");
    expect(d.permission).toBe("hr.payroll.read");
    expect(d.tieOut).toEqual({ kind: "projection", projection: "employee_ytd" });
    // No `gross` or `net` total: the dataset repeats both across an employee's scheme rows, so a sum would multiply
    // by the scheme count. The shares are per row and sum correctly.
    expect(d.totals.map((t) => t.field)).toEqual(["scheme_employee", "scheme_employer"]);
  });

  it("names NO form identifier, deadline, channel or schema version anywhere — hazard 2 in spirit", () => {
    const text = JSON.stringify(readHrDefinition("hr.annual_statement")).toLowerCase();
    for (const forbidden of [
      "lhdn",
      "myinvois",
      "e-filing",
      "efiling",
      "borang",
      "cp8",
      "ea form",
      "deadline",
    ]) {
      expect(text, `the definition names ${forbidden} — OD-28 has not been answered`).not.toContain(
        forbidden,
      );
    }
  });

  it("carries formName and formYear as optional PARAMETERS, so a verified name is a seed edit and not a code change", () => {
    const d = readHrDefinition("hr.annual_statement");
    const names = d.parameters.map((p) => p.name);
    expect(names).toContain("formName");
    expect(names).toContain("formYear");
    const formName = d.parameters.find((p) => p.name === "formName")!;
    expect(formName.required).toBe(false);
    expect(d.parameters.find((p) => p.name === "formYear")!.required).toBe(false);
    // The default (OD-28 unanswered): free text with NO enumerated options. An `enum` must offer at least one option
    // (7A's schema `minItems: 1` and validator rule 3), so the plan's `enum` with `options: []` would not seed; the
    // owner's verified identifiers turn it into an `enum` with those options — one seed edit.
    expect(formName.kind).toBe("text");
    expect(d.layout.header).toContain("{formName}");
    expect(d.layout.header).toContain("{formYear}");
    // The verify line of this task's owner gate reads this.
    console.log(
      `hr.annual_statement: formName options = ${JSON.stringify(formName.options ?? [])}`,
    );
  });

  it("its per-employee gross, net and scheme shares tie to app.employee_ytd row for row", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await assertTieOut(tx, readHrDefinition("hr.annual_statement"), {
        params: { companyId: s.company, taxYear: String(f.taxYear) },
        baseCurrency: MYR,
        asOf: `${f.taxYear}-12-31`,
      });
    });
  });

  it("adds the cut-over opening (round 18 B14) and still ties out — to the projection PLUS app.employee_ytd_opening (9B)", async () => {
    // The Phase 8 raise for 9B: a mid-year switch's statement must carry the figures the year started from. Written by
    // 8C's one writer inside a rolled-back transaction, so the shared fixture is untouched. The executed tie-out reads
    // the two tables on its own and adds them as Money; the report reads them through the `employee_ytd` dataset.
    const d = readHrDefinition("hr.annual_statement");
    const opening = (
      employeeId: string,
      gross: string,
      byScheme: Record<string, { employee: string; employer: string }>,
    ) => ({
      companyId: s.company,
      employeeId,
      year: f.taxYear,
      gross: Money.of(gross, MYR),
      net: Money.of(gross, MYR),
      byComponent: {},
      byScheme,
      source: "manual:9B annual statement opening test",
    });
    const outcome = await withTenant(db.rw, s.tenant, s.system, async (tx) => {
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: randomUUID() };
      await upsertEmployeeYtdOpening(
        tx,
        ctx,
        opening(f.payroll.employeeAId, "24000.0000", {
          EPF: { employee: "1200.0000", employer: "2400.0000" },
        }),
      );
      await upsertEmployeeYtdOpening(tx, ctx, opening(f.contractorId, "800.0000", {}));
      await assertTieOut(tx, d, {
        params: { companyId: s.company, taxYear: String(f.taxYear) },
        baseCurrency: MYR,
        asOf: `${f.taxYear}-12-31`,
      });
      const rows = await runDefinition(tx, d, { companyId: s.company, taxYear: String(f.taxYear) });
      throw Object.assign(new Error("rollback"), { rows });
    }).catch((e: { rows?: Record<string, unknown>[] }) => {
      if (e.rows === undefined) throw e;
      return e.rows;
    });
    // Employee A's year starts from the opening: 24000.0000 more gross and 1200.0000/2400.0000 more EPF than the run
    // alone (the run's SYNTH shares are 50.0000/100.0000); the contractor, on no run, is on the statement from the
    // opening alone. The employer return therefore covers all three.
    const a = outcome.filter((r) => r["employee_id"] === f.payroll.employeeAId);
    expect(a.map((r) => [r["scheme_code"], r["scheme_employee"], r["scheme_employer"]])).toEqual([
      ["EPF", "1250.0000", "2500.0000"],
    ]);
    expect(new Set(outcome.map((r) => String(r["employee_id"])))).toEqual(
      new Set([f.payroll.employeeAId, f.payroll.employeeBId, f.contractorId]),
    );
    // The footer says so: the printed statement names its basis.
    expect(d.layout.footer).toContain("plus the cut-over opening");
  });

  it("the employer return is the SAME code with no employeeId filter — one definition, two uses", async () => {
    const d = readHrDefinition("hr.annual_statement");
    // spec:2083 asks for "the annual per-employee statement AND employer return". They differ only by whether an
    // employee is named: the per-employee statement passes `employeeId`, the employer return omits it and the report
    // groups by employee. A second report CODE for the same numbers would be a second thing to keep tied to the same
    // projection (§4.16.1 keeps the register closed for exactly this).
    expect(d.dataset.filters.map((x) => x.param)).toContain("employeeId");
    expect(d.parameters.find((p) => p.name === "employeeId")!.required).toBe(false);
    expect(d.groups.map((g) => g.field)).toContain("employee_number");
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const employer = await runDefinition(tx, d, {
        companyId: s.company,
        taxYear: String(f.taxYear),
      });
      const employees = new Set(employer.map((r) => String(r.employee_id)));
      expect(employees).toEqual(new Set([f.payroll.employeeAId, f.payroll.employeeBId]));
      const one = await runDefinition(tx, d, {
        companyId: s.company,
        taxYear: String(f.taxYear),
        employeeId: f.payroll.employeeAId,
      });
      expect(one.length).toBeGreaterThan(0);
      expect(new Set(one.map((r) => String(r.employee_id)))).toEqual(
        new Set([f.payroll.employeeAId]),
      );
      // The per-employee statement is exactly the employer return's rows for that employee.
      expect(one).toEqual(employer.filter((r) => r.employee_id === f.payroll.employeeAId));
      // A year with no posted payroll prints nothing — no row is invented.
      const none = await runDefinition(tx, d, {
        companyId: s.company,
        taxYear: String(f.taxYear + 1),
      });
      expect(none).toEqual([]);
    });
  });
});

// tests/golden/payroll.test.ts — acceptance test 33 (spec:2451) and the payroll half of §4.11's golden files
// (spec:2262–2267). Every figure comes from the synthetic SYNTH table (§4.12.4, hazard 1).
//
// Amendment A10: for the payroll area `expected.json` is a PayrollGoldenExpectation — the lines (each with the
// rate-table version it pinned), the ledger and the payslips — compared on CODES, never ids, so a formula change
// shows as a diff (spec:2264) instead of as a fresh set of uuids.
//
// `bun run --cwd tests test -- golden/payroll.test.ts` compares; `bun run --cwd tests golden:payroll`
// (GOLDEN_WRITE=1) regenerates — a DEV script, never CI. A regenerated file is reviewed line by line against the
// hand-check table in the 8B plan's Task 13 before it is committed (AGENTS.md, Change Discipline).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calculatePayrollRun,
  ensureEmployeeDimensionValue,
  linkPayrollAccounts,
  postDocument,
  transitionDocument,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import {
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedEmployee,
  seedPayComponent,
  seedRateTable,
  seedStatutoryScheme,
  seedTenantV2,
  startDb,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { REPO_ROOT } from "../support/source";
import { ensureOpenPeriods } from "../invariants/support/post-inventory";
import { PAYROLL_PACK_ROOT, SYNTH_TABLE, secondApprover } from "../invariants/support/payroll";

export interface GoldenPayrollLine {
  employeeNumber: string;
  kind: "payroll" | "account";
  componentCode: string | null;
  schemeCode: string | null;
  share: "employee" | "employer" | null;
  quantity: string | null;
  amount: string;
  rateTableVersion: number | null;
  overrideReason: string | null;
  branchCode: string;
  employeeDimensionCode: string;
}
export interface GoldenLedgerRow {
  accountCode: string;
  debit: string;
  credit: string;
  dimensions: Record<string, string>;
}
export interface GoldenPayslip {
  employeeNumber: string;
  gross: string;
  net: string;
  schemes: { schemeCode: string; employee: string; employer: string }[];
}
export interface PayrollGoldenExpectation {
  lines: GoldenPayrollLine[];
  ledger: GoldenLedgerRow[];
  payslips: GoldenPayslip[];
  refusal?: { code: string; detailContains: string };
}
export interface PayrollGoldenInput {
  period: {
    start: string;
    end: string;
    payDate: string;
    prorationRule: "calendar_days" | "working_days";
  };
  kind: "regular" | "supplementary" | "final";
  effectiveDate: string;
  employees: {
    employeeNumber: string;
    branchCode: string;
    hiredOn: string;
    terminatedOn: string | null;
    statutoryProfile: Record<string, string | number | boolean | null>;
    compensation: { componentCode: string; amount: string | null; quantity: string | null }[];
  }[];
  /** `quantityBased` is additive to the plan's shape: a quantity-only line needs a quantity-based component. */
  components: {
    code: string;
    kind: "earning" | "deduction";
    accountCode: string;
    schemeCodes: string[];
    quantityBased?: boolean;
  }[];
  schemes: { code: string; table: "SYNTH" }[];
}

const GOLDEN_DIR = join(REPO_ROOT, "tests/golden/payroll");
const WRITE = process.env["GOLDEN_WRITE"] === "1";
const CASES = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .toSorted();

const CHART = JSON.parse(
  readFileSync(join(PAYROLL_PACK_ROOT, "chart-of-accounts/8b-payroll.json"), "utf8"),
) as {
  code: string;
  nameEn: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  isGroup?: boolean;
}[];
const PAYROLL_ENVELOPE = JSON.parse(
  readFileSync(join(PAYROLL_PACK_ROOT, "document-types/PAYROLL.json"), "utf8"),
) as { policy: unknown };

let db: Db;
beforeAll(async () => {
  db = await startDb();
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const ctxOf = (s: Seed, actorId: string): TenantContext => ({
  tenantId: s.tenant,
  actorId,
  requestId: "00000000-0000-0000-0000-000000000000",
});

/** One seeded tenant PER CASE — two cases posting into one company would sum into each other's ledger. */
async function seedCase(name: string, input: PayrollGoldenInput) {
  const s = await seedTenantV2(db, `golden-${name}`);
  await ensureOpenPeriods(db, s, 2026);
  for (const row of CHART) {
    if (row.isGroup === true) continue;
    await seedAccount(db, s, { code: row.code, nameEn: row.nameEn, type: row.type });
  }
  await seedDocumentType(db, s, { code: "PAYROLL", module: "hr", policy: PAYROLL_ENVELOPE.policy });
  const approver = await secondApprover(db, s, [
    "hr.payroll.approve",
    "hr.payroll.post",
    "hr.payroll.read",
  ]);
  await grantCodes(db, s, {
    codes: ["hr.payroll.prepare", "hr.payroll.read", "hr.compensation.read"],
  });

  const schemeIdByCode = new Map<string, string>();
  for (const scheme of input.schemes) {
    const id = await seedStatutoryScheme(db, s, { code: scheme.code });
    schemeIdByCode.set(scheme.code, id);
    await seedRateTable(db, s, {
      schemeId: id,
      version: 1,
      definition: SYNTH_TABLE,
      verified: true,
    });
  }
  const componentIdByCode = new Map<string, string>();
  for (const c of input.components) {
    componentIdByCode.set(
      c.code,
      await seedPayComponent(db, s, {
        code: c.code,
        kind: c.kind,
        quantityBased: c.quantityBased ?? false,
      }),
    );
  }

  const asHuman = ctxOf(s, s.human);
  await withTenant(db.rw, asHuman, async (tx) => {
    await linkPayrollAccounts(tx, s.company);
    for (const c of input.components) {
      const [account] = await tx<{ id: string }[]>`
        select id from app.account where company_id = ${s.company} and code = ${c.accountCode}`;
      await tx`update app.pay_component set expense_account_id = ${account!.id}
                where id = ${componentIdByCode.get(c.code)!}`;
      for (const schemeCode of c.schemeCodes) {
        await tx`insert into app.pay_component_scheme (tenant_id, component_id, scheme_id)
                 values (${s.tenant}, ${componentIdByCode.get(c.code)!}, ${schemeIdByCode.get(schemeCode)!})`;
      }
    }
    await tx`insert into app.company_hr_setting (tenant_id, company_id, proration_rule, pay_day)
             values (${s.tenant}, ${s.company}, ${input.period.prorationRule}, 5)
             on conflict (company_id) do nothing`;
  });

  const branchIdByCode = new Map<string, string>([["HQ", s.hq]]);
  const employeeIdByNumber = new Map<string, string>();
  for (const e of input.employees) {
    if (!branchIdByCode.has(e.branchCode)) {
      branchIdByCode.set(
        e.branchCode,
        await seedBranch(db, s, { code: e.branchCode, nameEn: e.branchCode }),
      );
    }
    const employeeId = await seedEmployee(db, s, {
      employeeNumber: e.employeeNumber,
      homeBranchId: branchIdByCode.get(e.branchCode)!,
      hiredOn: e.hiredOn,
    });
    employeeIdByNumber.set(e.employeeNumber, employeeId);
    await withTenant(db.rw, asHuman, async (tx) => {
      if (e.terminatedOn !== null) {
        await tx`update app.employee set terminated_on = ${e.terminatedOn}::date where id = ${employeeId}`;
      }
      if (Object.keys(e.statutoryProfile).length > 0) {
        await tx`insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, extra)
                 values (${s.tenant}, ${employeeId}, ${e.hiredOn}::date,
                         ${JSON.stringify(e.statutoryProfile)}::text::jsonb)`;
      }
      for (const c of e.compensation) {
        // No `company_id`: 8A's compensation_line reaches its company through employee_id.
        await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, quantity)
                 values (${s.tenant}, ${employeeId}, ${componentIdByCode.get(c.componentCode)!},
                         ${e.hiredOn}::date, ${c.amount}::numeric, ${c.quantity}::numeric)`;
      }
      await ensureEmployeeDimensionValue(tx, s.company, employeeId);
    });
  }
  return { s, approver, employeeIdByNumber, schemeIdByCode, componentIdByCode };
}

async function runGoldenCase(
  name: string,
  input: PayrollGoldenInput,
): Promise<PayrollGoldenExpectation> {
  const { s, approver, employeeIdByNumber, componentIdByCode, schemeIdByCode } = await seedCase(
    name,
    input,
  );
  const run = {
    companyId: s.company,
    kind: input.kind,
    periodStart: input.period.start,
    periodEnd: input.period.end,
    payDate: input.period.payDate,
    effectiveDate: input.effectiveDate,
    branchId: s.hq,
  };

  /**
   * Every id this case minted, replaced by the CODE it stands for. The calculator is pure and names an employee
   * and a component by id; a raw message in `expected.json` would differ on every run. Longest id first, so no
   * id is a prefix of another's substitution.
   */
  const toCodes = (text: string): string =>
    [
      ...[...employeeIdByNumber].map(([code, id]) => [id, code] as const),
      ...[...componentIdByCode].map(([code, id]) => [id, code] as const),
      ...[...schemeIdByCode].map(([code, id]) => [id, code] as const),
    ]
      .toSorted((a, b) => b[0].length - a[0].length)
      .reduce((acc, [id, code]) => acc.split(id).join(code), text);

  // A refusal is an OUTCOME the fixture pins (test 33's second clause: "fails the run naming the employee, never a
  // silent zero"), so the case does not say in advance whether it expects one.
  let r: { documentId: string };
  try {
    r = await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
      calculatePayrollRun(tx, ctxOf(s, s.human), run),
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === undefined) throw error;
    // A refused run writes nothing: no document of any kind exists in this case's company.
    const [docs] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.document where company_id = ${s.company}`;
    expect(docs!.n).toBe(0);
    const detail = toCodes((error as { detail?: string }).detail ?? (error as Error).message);
    return { lines: [], ledger: [], payslips: [], refusal: { code, detailContains: detail } };
  }
  await withTenant(db.rw, ctxOf(s, s.human), (tx) =>
    transitionDocument(tx, ctxOf(s, s.human), { documentId: r.documentId, to: "submitted" }),
  );
  await withTenant(db.rw, ctxOf(s, approver), (tx) =>
    transitionDocument(tx, ctxOf(s, approver), { documentId: r.documentId, to: "approved" }),
  );
  await withTenant(db.rw, ctxOf(s, approver), (tx) =>
    postDocument(tx, ctxOf(s, approver), { documentId: r.documentId }),
  );

  const lines = await db.admin<GoldenPayrollLine[]>`
    select e.employee_number as "employeeNumber", dl.kind, pc.code as "componentCode",
           sc.code as "schemeCode", pl.share, pl.quantity::text as quantity, pl.amount::text as amount,
           pl.rate_table_version as "rateTableVersion", pl.override_reason as "overrideReason",
           bv.code as "branchCode", ev.code as "employeeDimensionCode"
      from app.payroll_line pl
      join app.document_line dl on dl.id = pl.document_line_id
      join app.employee e on e.id = pl.employee_id
      left join app.pay_component pc on pc.id = pl.component_id
      left join app.statutory_scheme sc on sc.id = pl.scheme_id
      join app.dimension_value bv on bv.id = (dl.dimensions->>'BRANCH')::uuid
      join app.dimension_type et on et.company_id = pl.company_id and et.code = 'EMPLOYEE'
      join app.dimension_value ev on ev.dimension_type_id = et.id and ev.code = e.employee_number
     where dl.document_id = ${r.documentId}
     order by dl.line_no`;

  const ledger = await db.admin<GoldenLedgerRow[]>`
    select a.code as "accountCode", le.debit::text as debit, le.credit::text as credit,
           coalesce(jsonb_object_agg(dt.code, dv.code) filter (where dt.code is not null), '{}'::jsonb)
             as dimensions
      from app.ledger_entry le
      join app.account a on a.id = le.account_id
      left join app.ledger_entry_dimension led on led.entry_id = le.id
      left join app.dimension_value dv on dv.id = led.dimension_value_id
      left join app.dimension_type dt on dt.id = dv.dimension_type_id
     where le.document_id = ${r.documentId}
     group by le.id, a.code, le.debit, le.credit, le.line_no
     order by le.line_no`;

  const payslips = await db.admin<GoldenPayslip[]>`
    with per_employee as (
      select e.employee_number,
             coalesce(sum(pl.amount) filter (where pc.kind = 'earning'), 0.0000) as gross,
             coalesce(sum(pl.amount) filter (where pl.component_id is null and pl.scheme_id is null), 0.0000)
               as net
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.employee e on e.id = pl.employee_id
        left join app.pay_component pc on pc.id = pl.component_id
       where dl.document_id = ${r.documentId}
       group by e.employee_number),
    per_scheme as (
      select e.employee_number, sc.code as scheme_code,
             coalesce(sum(pl.amount) filter (where pl.share = 'employee'), 0.0000) as employee,
             coalesce(sum(pl.amount) filter (where pl.share = 'employer'), 0.0000) as employer
        from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
        join app.employee e on e.id = pl.employee_id
        join app.statutory_scheme sc on sc.id = pl.scheme_id
       where dl.document_id = ${r.documentId}
       group by e.employee_number, sc.code)
    select pe.employee_number as "employeeNumber", pe.gross::text as gross, pe.net::text as net,
           coalesce(jsonb_agg(jsonb_build_object('schemeCode', ps.scheme_code,
                                                 'employee', ps.employee::text,
                                                 'employer', ps.employer::text)
                              order by ps.scheme_code) filter (where ps.scheme_code is not null),
                    '[]'::jsonb) as schemes
      from per_employee pe left join per_scheme ps on ps.employee_number = pe.employee_number
     group by pe.employee_number, pe.gross, pe.net
     order by pe.employee_number`;

  // postgres.js returns RowList objects; spread them into plain arrays so the byte comparison sees JSON only.
  return { lines: [...lines], ledger: [...ledger], payslips: [...payslips] };
}

describe("golden payroll (test 33, spec:2264) — byte-identical lines, ledger and payslips on SYNTH", () => {
  it("every case directory holds exactly input.json and expected.json", () => {
    expect(CASES).toEqual(["synth-missing-input", "synth-proration", "synth-regular"]);
    for (const name of CASES) {
      expect(readdirSync(join(GOLDEN_DIR, name)).toSorted()).toEqual([
        "expected.json",
        "input.json",
      ]);
    }
  });

  for (const name of CASES) {
    it(`${name} matches expected.json byte for byte`, async () => {
      const input = JSON.parse(
        readFileSync(join(GOLDEN_DIR, name, "input.json"), "utf8"),
      ) as PayrollGoldenInput;
      const file = join(GOLDEN_DIR, name, "expected.json");
      const actual = await runGoldenCase(name, input);
      const text = `${JSON.stringify(actual, null, 2)}\n`;
      if (WRITE) writeFileSync(file, text, "utf8");
      const expected = JSON.parse(readFileSync(file, "utf8")) as PayrollGoldenExpectation;
      expect(actual).toEqual(expected);
      // Byte identity, not merely deep equality: spec:2264 wants "any formula change visible in a diff".
      expect(text).toBe(readFileSync(file, "utf8"));
    }, 180_000);
  }
});

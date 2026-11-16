import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { PAYROLL_ACCOUNT_CODES, linkPayrollAccounts } from "../../src/hr/accounts";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { linkPayrollAccountsForTenant, main } from "../../src/seed/payroll-accounts";
import type { LoaderContext } from "../../src/seed/packs";
import { startDb, withTenant, type Db } from "../harness";
import { seedPayComponent, seedStatutoryScheme, seedTenantV2, type Seed } from "../fixtures";

const PACK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../seed/my");

interface ChartRow {
  code: string;
  nameEn: string;
  nameAr: string;
  type: string;
  isGroup?: boolean;
  parentCode?: string;
}
interface Rule {
  for: string;
  side: string;
  account: { from?: string; code?: string };
  amount: string;
  when: Record<string, string>;
  dimensions?: { from?: string[] };
}
interface Envelope {
  code: string;
  module: string;
  policy: {
    lines: Rule[];
    dimensions: { required: string[] };
    reversal: { allowed: boolean; producesType: string | null };
    approval: { required: boolean; approve: string; post: string; create: string };
    numbering: { series: string; assignAt: string };
    direction: string;
    inventory: { effect: string };
    tax: { applies: boolean };
  };
}

const chart = (): ChartRow[] =>
  JSON.parse(
    readFileSync(join(PACK_ROOT, "chart-of-accounts/8b-payroll.json"), "utf8"),
  ) as ChartRow[];
const envelope = (): Envelope =>
  JSON.parse(readFileSync(join(PACK_ROOT, "document-types/PAYROLL.json"), "utf8")) as Envelope;

let db: Db;
let s: Seed;
/** The permission catalogue as `app.permission` ROWS — `packages/db` may not import `@dulja/contracts`
 *  (§3.1, dependency-rule); the 6D pack test's precedent. */
let catalogue: string[];

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Payroll");
  catalogue = (
    await db.admin<{ code: string }[]>`select code from app.permission order by code`
  ).map((r) => r.code);
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("8b-payroll.json and PAYROLL.json (§4.15, §4.14, §4.3.7)", () => {
  it("the chart file holds exactly the eleven §4.15 leaves this slice owns plus one presentation parent", () => {
    const rows = chart();
    const leaves = rows.filter((r) => r.isGroup !== true).map((r) => r.code);
    expect(leaves.toSorted()).toEqual([
      "1400",
      "2400",
      "2411",
      "2412",
      "2413",
      "2414",
      "5300",
      "5311",
      "5312",
      "5313",
      "5314",
    ]);
    expect(rows.filter((r) => r.isGroup === true).map((r) => r.code)).toEqual(["2410"]);
    // The four statutory payables hang off the 2410 parent; everything else off 0C's type group (the 3C, 5A and
    // 6D chart files' shape), so the block presents under Assets / Liabilities / Expenses.
    for (const r of rows) {
      const expected = /^241[1-4]$/.test(r.code) ? "2410" : r.code[0];
      expect(r.parentCode, r.code).toBe(expected);
    }
    // The same eleven, read out of the ONE exported literal (hazard 32).
    expect(
      [
        PAYROLL_ACCOUNT_CODES.staffAdvances,
        PAYROLL_ACCOUNT_CODES.salariesPayable,
        PAYROLL_ACCOUNT_CODES.salariesExpense,
        ...Object.values(PAYROLL_ACCOUNT_CODES.schemePayable),
        ...Object.values(PAYROLL_ACCOUNT_CODES.schemeEmployerExpense),
      ].toSorted(),
    ).toEqual(leaves.toSorted());
    const firstDigitType: Record<string, string> = {
      "1": "asset",
      "2": "liability",
      "3": "equity",
      "4": "income",
      "5": "expense",
    };
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.type).toBe(firstDigitType[r.code[0]!]);
      expect(r.nameAr.length).toBeGreaterThan(0);
    }
    // Hazard 1: account NAMES only — no digit other than the code in any row.
    for (const r of rows) expect(`${r.nameEn} ${r.nameAr}`, r.code).not.toMatch(/[0-9]/);
  });

  it("no other chart file seeds one of the eleven (one seeder per §4.15 code)", () => {
    const mine = new Set(chart().map((r) => r.code));
    for (const file of [
      "0c-base",
      "3c-purchasing",
      "3d-adjustments",
      "5a-tax",
      "6a-pos-tenders",
      "6d-till",
    ]) {
      const rows = JSON.parse(
        readFileSync(join(PACK_ROOT, `chart-of-accounts/${file}.json`), "utf8"),
      ) as ChartRow[];
      for (const r of rows) expect(mine.has(r.code), `${file}:${r.code}`).toBe(false);
    }
  });

  it("the PAYROLL envelope validates, and its policy validates against the frozen schema and the catalogue", () => {
    const env = envelope();
    expect(validateDocumentTypeSeed(env)).toEqual({ ok: true, errors: [] });
    expect(env.module).toBe("hr");
    expect(validatePolicy(env.policy, catalogue)).toEqual({ ok: true, errors: [] });
  });

  it("every PAYROLL rule declares dimensions.from WITHOUT document.branch (round 17 A3, spec:2101)", () => {
    const env = envelope();
    expect(env.policy.dimensions.required).toEqual(["BRANCH", "EMPLOYEE"]);
    for (const rule of env.policy.lines) {
      expect(rule.dimensions?.from).toEqual(["line.dimensions", "line.employee"]);
    }
  });

  it("the seven rules are spec:2101's five shapes — and no rule names an account code literal", () => {
    const shapes = envelope().policy.lines.map(
      (r) => `${r.side} ${r.account.from} ${r.amount} ${JSON.stringify(r.when)}`,
    );
    expect(shapes).toEqual([
      'debit line.component.expense_account line.amount {"line.kind":"payroll","line.component.kind":"earning"}',
      'credit line.component.expense_account line.amount {"line.kind":"payroll","line.component.kind":"deduction"}',
      'credit line.scheme.payable_account line.amount {"line.kind":"payroll","line.share":"employee"}',
      'debit line.scheme.expense_account line.amount {"line.kind":"payroll","line.share":"employer"}',
      'credit line.scheme.payable_account line.amount {"line.kind":"payroll","line.share":"employer"}',
      'credit line.account line.credit {"line.kind":"account"}',
      'debit line.account line.debit {"line.kind":"account"}',
    ]);
    for (const r of envelope().policy.lines) expect(r.account.code).toBeUndefined();
  });

  it("PAYROLL refuses reversal — correction is a supplementary run (round 17 A4, ADR 0076)", () => {
    const { policy } = envelope();
    expect(policy.reversal).toEqual({ allowed: false, producesType: null });
    expect(policy.approval).toEqual({
      required: true,
      approve: "hr.payroll.approve",
      post: "hr.payroll.post",
      create: "hr.payroll.prepare",
    });
    expect(policy.numbering).toEqual({ series: "PAY", assignAt: "issue" });
    expect(policy.direction).toBe("none");
    expect(policy.inventory).toEqual({ effect: "none" });
    expect(policy.tax).toEqual({ applies: false });
  });

  it("0C's chart loader picks the file up and seeds all twelve rows idempotently — a second run changes nothing", async () => {
    // 8B ships a FILE, not a loader: `chartOfAccountsLoader` reads every `.json` in the sub-pack in name order.
    const ctx: LoaderContext = {
      config: {
        tenantId: s.tenant,
        only: ["chart-of-accounts"],
        packRoot: PACK_ROOT,
        appEnv: "dev" as const,
        tenantName: "payroll",
        ownerEmail: "owner@example.invalid",
        companyCode: "HQ",
        companyName: "payroll HQ",
        baseCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        fiscalYearStartMonth: 1,
        fiscalYear: 2026,
      },
      tenantId: s.tenant,
      companyId: s.company,
      systemPrincipalId: s.system,
      packRoot: PACK_ROOT,
    };
    await withTenant(db.migrator, s.tenant, s.system, (tx) => chartOfAccountsLoader.load(tx, ctx));
    const second = await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, ctx),
    );
    expect(second).toBe(0);
    const rows = await db.admin<{ code: string; parent: string | null; is_group: boolean }[]>`
      select a.code, p.code as parent, a.is_group from app.account a
        left join app.account p on p.id = a.parent_id
       where a.company_id = ${s.company}
         and a.code in ('1400','2400','2410','2411','2412','2413','2414','5300','5311','5312','5313','5314')
       order by a.code`;
    expect(rows.map((r) => r.code)).toEqual([
      "1400",
      "2400",
      "2410",
      "2411",
      "2412",
      "2413",
      "2414",
      "5300",
      "5311",
      "5312",
      "5313",
      "5314",
    ]);
    expect(rows.find((r) => r.code === "2410")).toEqual({
      code: "2410",
      parent: "2",
      is_group: true,
    });
    expect(rows.find((r) => r.code === "2412")!.parent).toBe("2410");
  });

  it("linkPayrollAccounts wires components and schemes from the codes, and never overwrites a chosen value", async () => {
    await seedStatutoryScheme(db, s, { code: "EPF" });
    await seedStatutoryScheme(db, s, { code: "SOCSO" });
    await seedPayComponent(db, s, { code: "BASIC", kind: "earning" });
    const chosen = await seedPayComponent(db, s, { code: "OT", kind: "earning" });
    const [other] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '5900'`;
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.pay_component set expense_account_id = ${other!.id} where id = ${chosen}`,
    );

    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkPayrollAccounts(tx, s.company),
    );
    expect(result.missingCodes).toEqual([]);
    expect(result.componentsLinked).toBe(1); // BASIC only — OT already had one
    expect(result.schemesLinked).toBe(2);

    const rows = await db.admin<{ code: string; expense: string | null }[]>`
      select c.code, a.code as expense from app.pay_component c
        left join app.account a on a.id = c.expense_account_id
       where c.company_id = ${s.company} order by c.code`;
    expect(rows).toEqual([
      { code: "BASIC", expense: "5300" },
      { code: "OT", expense: "5900" },
    ]);

    const schemes = await db.admin<{ code: string; payable: string; employer: string | null }[]>`
      select sc.code, p.code as payable, e.code as employer from app.statutory_scheme sc
        join app.account p on p.id = sc.payable_account_id
        left join app.account e on e.id = sc.employer_expense_account_id
       where sc.company_id = ${s.company} order by sc.code`;
    expect(schemes).toEqual([
      { code: "EPF", payable: "2411", employer: "5311" },
      { code: "SOCSO", payable: "2412", employer: "5312" },
    ]);
  });

  it("the wiring entry point runs as the tenant's SYSTEM principal and is idempotent", async () => {
    const first = await linkPayrollAccountsForTenant(db.rw, s.tenant, s.company);
    const second = await linkPayrollAccountsForTenant(db.rw, s.tenant, s.company);
    expect(first.missingCodes).toEqual([]);
    expect(second.componentsLinked).toBe(0); // nothing left to link on a second run
    expect(second.schemesLinked).toBe(0);
    // The earlier case's writes were the human's; the audit trail names the system principal for none of them,
    // and a wiring that changes nothing writes no audit row at all.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_log
       where tenant_id = ${s.tenant} and actor_id = ${s.system}
         and table_name in ('pay_component', 'statutory_scheme')`;
    expect(n!.n).toBe(0);
  });

  it("the CLI refuses a missing flag with exit 2 and names the usage", async () => {
    expect(await main(["--tenant", s.tenant], { DATABASE_URL: undefined })).toBe(2);
  });

  it("linkPayrollAccounts NAMES a code it cannot resolve rather than leaving a null account (hazard 33)", async () => {
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`delete from app.account where company_id = ${s.company} and code = '2413'`,
    );
    await seedStatutoryScheme(db, s, { code: "EIS" });
    await seedStatutoryScheme(db, s, { code: "SYNTH" });
    const result = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkPayrollAccounts(tx, s.company),
    );
    // A scheme whose statutory payable has no account is skipped WHOLE — 5313 resolves but is not linked, and it is
    // not named either, because it is not missing. A scheme §4.15 has no row for is named as `scheme:<CODE>`.
    expect(result.missingCodes).toEqual(["2413", "scheme:SYNTH"]);
    expect(result.schemesLinked).toBe(0);
    const [eis] = await db.admin<{ payable: string | null; employer: string | null }[]>`
      select sc.payable_account_id::text as payable, sc.employer_expense_account_id::text as employer
        from app.statutory_scheme sc where sc.company_id = ${s.company} and sc.code = 'EIS'`;
    expect(eis).toEqual({ payable: null, employer: null }); // skipped whole, not linked halfway
    await expect(linkPayrollAccountsForTenant(db.rw, s.tenant, s.company)).rejects.toThrow(
      /ERR_POLICY_REQUIRES_MISSING: .*2413, scheme:SYNTH/,
    );
  });
});

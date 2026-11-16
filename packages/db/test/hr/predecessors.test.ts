import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASET_IDS } from "../../src/reports/datasets";
import { discover, lintSchema, listApplied } from "../../src";
import { payrollFixture, type PayrollFixture } from "../../../../tests/invariants/support/payroll";
import { seedTenantV2, type Seed } from "../fixtures";
import { MIGRATIONS_DIR, startDb, withTenant, type Db } from "../harness";

// 8D Task 0 — the 8C / 7A / 7C / 2C repository gate (contracts round 19). It proves, by executing assertions, that the
// predecessor surfaces 8D consumes are in the tree in the shape §4 and the 8C handoff promise. A failure here is the
// phase gate speaking: merge or correct the predecessor, never weaken the assertion.
//
// The gate is written to stay TRUE after 8D's own tasks land (round 19 A13): it pins what the predecessors shipped
// (the first twenty-eight registry members, the predecessor migrations and codes) and admits only 8D's own named
// additions beyond them — the plan's "0096–0099 not applied" and "none of 8D's six" assertions would turn this file
// red the moment Task 1 or Task 2 merged.
//
// No `@dulja/contracts` import: a packages/db test other than permission-catalogue.test.ts may not import it
// (dependency-rule; round 18 B16 item 3), so the catalogue half reads `app.permission`. No `apps/**` import either
// (§3.1): 2C's engine surface is asserted over its SOURCE TEXT. Every repository path is built from `__dirname`.

const PACKAGES_DB = join(__dirname, "../..");
const REPO = join(PACKAGES_DB, "../..");

/** ⚠️ OD-09: `pdc` is not built (migration 0051 reserved and unused), so 7A shipped twenty-five and 7C three. */
const EXPECTED_BASE = 28;
/** §4.16.2's 8D row — five ship in Task 2, `leave_record` in Task 8 (OD-13 answered build, round 19 A14). */
const EIGHT_D_DATASETS = [
  "employee",
  "attendance_event",
  "payroll_line",
  "employee_ytd",
  "statutory_schedule",
  "leave_record",
];
/** §3.6.2's 8D codes: `hr.filing.generate` (0097) and the two `hr.leave.*` rows 0096 inserts (8D A9). */
const EIGHT_D_CODES = ["hr.filing.generate", "hr.leave.record", "hr.leave.approve"];
/** §2.9's 8D migration names; 0099 is allocated and left unused (§3.4.1). */
const EIGHT_D_MIGRATIONS: Readonly<Record<number, string>> = {
  96: "create_leave_register",
  97: "seed_permission_phase8d",
  98: "add_employee_contract_end",
};

describe("8D's predecessors are in the repository in the shape §4 promises", () => {
  let db: Db;
  let s: Seed;
  let f: PayrollFixture;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "8d-gate");
    f = await payrollFixture(db, s);
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  it("every migration 8D consumes has been applied; 0096–0098 are only 8D's own names and 0099 is unused", async () => {
    const applied = await listApplied(db.migrator);
    // 2C 0025–0027, 6C 0064/0067, 7A 0074–0076, 7C 0078–0079, 8A 0080–0086, 8B 0087–0090, 8C 0091–0095 and the
    // two tails 0120 (8A) and 0121 (8C).
    for (const n of [
      25, 26, 27, 64, 67, 74, 75, 76, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
      93, 94, 95, 120, 121,
    ]) {
      expect(applied, `migration ${n} is missing — 8D's phase gate is not met`).toContain(n);
    }
    expect(applied).not.toContain(99);
    for (const m of discover(MIGRATIONS_DIR).filter((x) => x.version >= 96 && x.version <= 99)) {
      expect(
        EIGHT_D_MIGRATIONS[m.version],
        `migration ${m.version} is not one of 8D's`,
      ).toBeDefined();
      expect(m.name).toBe(EIGHT_D_MIGRATIONS[m.version]);
    }
  });

  it("8C's three tables carry the columns §4.6.1 and §4.12.8 fix", async () => {
    const columns = async (table: string) => {
      const rows = await db.admin<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'app' and table_name = ${table} order by column_name`;
      return rows.map((r) => r.column_name);
    };
    expect(await columns("employee_ytd")).toEqual([
      "by_component",
      "by_scheme",
      "company_id",
      "created_at",
      "employee_id",
      "gross",
      "net",
      "tax_year",
      "tenant_id",
      "updated_at",
    ]);
    // 8C's 0091 ships §4.6.1's columns PLUS round 18 B11's `currency` and `generated_by` — fourteen names.
    expect(await columns("statutory_schedule")).toEqual(
      [
        "attachment_id",
        "company_id",
        "created_at",
        "currency",
        "generated_by",
        "id",
        "period_end",
        "period_start",
        "payroll_document_id",
        "remittance_document_id",
        "scheme_id",
        "tenant_id",
        "total_employee",
        "total_employer",
      ].toSorted(),
    );
    expect(await columns("employee_ytd_opening")).toContain("loaded_by");
  });

  it("7A's registry opens with exactly the twenty-eight members 7A and 7C shipped; only 8D's six may follow", () => {
    expect(DATASET_IDS.length).toBeGreaterThanOrEqual(EXPECTED_BASE);
    const base = DATASET_IDS.slice(0, EXPECTED_BASE) as readonly string[];
    expect(base.slice(-3)).toEqual(["shift", "till_event", "needs_attention"]);
    for (const id of EIGHT_D_DATASETS) expect(base).not.toContain(id);
    expect(base).not.toContain("pdc");
    const tail = DATASET_IDS.slice(EXPECTED_BASE) as readonly string[];
    for (const id of tail) expect(EIGHT_D_DATASETS, `${id} is not 8D's`).toContain(id);
  });

  it("2C's engine surface is the one Task 5 calls: four names, and render takes { paper, dir }", () => {
    // Source text, NEVER an import: `packages/db/test/**` may not import `apps/**` (§3.1).
    const src = readFileSync(join(REPO, "apps/api/src/print/engines/index.ts"), "utf8");
    for (const name of [
      "export type PrintEngineCode",
      "export interface PdfEngine",
      "export const PDF_ENGINES",
      "export function engineFor",
    ]) {
      expect(src, `${name} is 2C's and 8D Task 5 consumes it`).toContain(name);
    }
    // Two option members, pinned by NAME and ORDER (a regex, so a reformat changes nothing). Task 5's
    // renderPayslip must not pass `orientation`: there is nowhere to put it.
    expect(src).toMatch(
      /render\(\s*source:\s*string,\s*opts:\s*\{\s*paper:\s*string;\s*dir:\s*"ltr"\s*\|\s*"rtl"\s*\}\s*\)/,
    );
    expect(src).not.toMatch(/opts:\s*\{[^}]*orientation/);
    expect(src).not.toContain("engineCodeFromAdr"); // there is no such reader; Task 5 uses PAYSLIP_ENGINE
  });

  it("the catalogue holds every code 8D gates on, and no 8D-looking code beyond §3.6.2's three", async () => {
    const codes = new Set(
      (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code),
    );
    for (const c of [
      "hr.employee.read",
      "hr.employee.read_sensitive",
      "hr.payroll.read",
      "hr.compensation.read",
    ]) {
      expect(codes, `${c} is 6C's or 8A's and must be merged before 8D`).toContain(c);
    }
    for (const c of codes) {
      if (c.startsWith("hr.filing.") || c.startsWith("hr.leave.")) {
        expect(EIGHT_D_CODES, `${c} is in no §3.6.2 8D row`).toContain(c);
      }
    }
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("every §4.15 account 8D's definitions name is already seeded by 8B, and 8D seeds none", async () => {
    const codes = ["2400", "2411", "2412", "2413", "2414", "5300"];
    const found = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<{ id: string; code: string; type: string }[]>`
        select id, code, type::text as type from app.account
         where company_id = ${s.company} and code = any(${codes}::text[]) order by code`,
    );
    expect(found.map((r) => r.code)).toEqual(codes);
    expect(found.find((r) => r.code === "2400")?.type).toBe("liability");
    expect(found.find((r) => r.code === "5300")?.type).toBe("expense");
    // 8B's fixture resolved 2400 to the SAME row — one account, not two spellings.
    expect(f.salariesPayableAccountId).toBe(found.find((r) => r.code === "2400")!.id);
    // The chart file is 8B's and this slice adds no file beside it (§4.15's one-file-per-slice rule).
    const dir = readdirSync(join(PACKAGES_DB, "seed/my/chart-of-accounts"));
    expect(dir).toContain("8b-payroll.json");
    expect(dir.filter((n) => n.startsWith("8d"))).toEqual([]);
  });
});

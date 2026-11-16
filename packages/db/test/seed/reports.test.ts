import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReportDefinitions, reportsLoader } from "../../src/seed/reports";
import { SUB_PACKS } from "../../src/seed/types";
import { OWNED_ELSEWHERE, PHASE_0_SUB_PACK_DIRECTORIES } from "../../src/seed/packs";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = (code: string) => ({
  version: 1,
  code,
  nameEn: `Report ${code}`,
  nameAr: `تقرير ${code}`,
  module: code.split(".")[0],
  permission: "accounting.report.read",
  parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
});

/** §4.16.1's envelope. `definitionVersion` is the ROW version; `definition.version` stays the format's 1. */
const FILE = (code: string, definitionVersion = 1, overrides: Record<string, unknown> = {}) => ({
  definitionVersion,
  definition: { ...DEF(code), ...overrides },
});

async function pack(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dulja-reports-pack-"));
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, "reports", relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  }
  return root;
}

describe("the reports sub-pack loader — contracts §3.4.8, §4.2.13", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "reports-loader");
  });
  afterAll(async () => {
    await db.stop();
  });

  const ctx = () => ({ tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() });
  const auditRows = async () => {
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.audit_log where table_name like '%report_definition'`,
    );
    return row!.n;
  };

  it("registers the sub-pack: SUB_PACKS gains 'reports' after every sub-pack it can name, the directory joins the required list, and OWNED_ELSEWHERE loses it", () => {
    expect(SUB_PACKS).toContain("reports");
    // Application order, never alphabetical (§4.2.13): a definition is validated against the datasets and the
    // permission catalogue, and the permission rows arrive with the migrations — so reports come after every
    // earlier sub-pack. 8A's `statutory` follows it (contracts round 16, A12): no definition names a statutory row.
    expect(SUB_PACKS.slice(-2)).toEqual(["reports", "statutory"]);
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toContain("reports");
    expect(Object.keys(OWNED_ELSEWHERE)).not.toContain("reports");
    expect(Object.keys(OWNED_ELSEWHERE)).not.toContain("statutory"); // 8A shipped its loader
  });

  it("loads every <slice>/<code>.json, keyed by the file name, and reports the codes", async () => {
    const root = await pack({
      "7b/accounting.general_ledger.json": FILE("accounting.general_ledger"),
      "7b/inventory.movement_register.json": FILE("inventory.movement_register"),
      "7c/accounting.party_statement.json": FILE("accounting.party_statement"),
    });
    const result = await loadReportDefinitions(db.rw, ctx(), root, s.company);
    expect(result.applied).toBe(3);
    expect(result.inserted).toBe(3);
    expect([...result.codes]).toEqual([
      "accounting.general_ledger",
      "accounting.party_statement",
      "inventory.movement_register",
    ]);
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; version: number; is_core: boolean }[]>`
        select code, version, is_core from app.report_definition order by code`,
    );
    expect(rows.every((r) => r.is_core)).toBe(true);
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  it("is idempotent: re-running the same file replaces the row rather than duplicating it, and writes no audit row (§3.4.8, spec:2317)", async () => {
    const root = await pack({ "7b/accounting.audit_log.json": FILE("accounting.audit_log") });
    await loadReportDefinitions(db.rw, ctx(), root, s.company);
    const before = await auditRows();
    const again = await loadReportDefinitions(db.rw, ctx(), root, s.company);
    expect(again.applied).toBe(1); // re-applied, not duplicated
    expect(again.inserted).toBe(0);
    // "Running it twice changes nothing" includes app.audit_log — an identical file writes nothing at all.
    expect(await auditRows()).toBe(before);

    const edited = await pack({
      "7b/accounting.audit_log.json": FILE("accounting.audit_log", 1, {
        nameEn: "Audit log corrected",
      }),
    });
    await loadReportDefinitions(db.rw, ctx(), edited, s.company);
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number; name: string }[]>`
        select count(*)::int as n, max(definition->>'nameEn') as name
          from app.report_definition where code = 'accounting.audit_log'`,
    );
    expect(row!.n).toBe(1);
    expect(row!.name).toBe("Audit log corrected");
  });

  it("seeds a RE-EXPRESSED code at definitionVersion 2 beside version 1 — §4.16.1's rule for 7B and 7C", async () => {
    // The envelope carries the ROW version. `definition.version` is the FORMAT version and the schema pins it
    // to `"const": 1`, so a loader that wrote it into the column could never seed a version-2 row at all —
    // and every re-expressed code (7B's five, 7C's three) would be unshippable.
    const v1 = await pack({
      "7b/accounting.trial_balance.json": FILE("accounting.trial_balance", 1),
    });
    await loadReportDefinitions(db.rw, ctx(), v1, s.company);
    const v2 = await pack({
      "7b/accounting.trial_balance.json": FILE("accounting.trial_balance", 2, {
        nameEn: "Trial balance (7B)",
      }),
    });
    await loadReportDefinitions(db.rw, ctx(), v2, s.company);

    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ version: number; name: string }[]>`
        select version, definition->>'nameEn' as name
          from app.report_definition where code = 'accounting.trial_balance' order by version`,
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]!.name).toBe("Trial balance (7B)");
    // The format version never moved with it.
    const [format] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ v: string }[]>`select definition->>'version' as v from app.report_definition
                           where code = 'accounting.trial_balance' and version = 2`,
    );
    expect(format!.v).toBe("1");
  });

  it("refuses a body that is not the envelope, and a definitionVersion below 1 or non-integer", async () => {
    const bare = await pack({ "7b/accounting.ledger.json": DEF("accounting.ledger") }); // no envelope at all
    await expect(loadReportDefinitions(db.rw, ctx(), bare, s.company)).rejects.toThrowError(
      /must be exactly \{ "definitionVersion"/,
    );

    for (const bad of [0, -1, 1.5, "2", null]) {
      const root = await pack({
        "7b/accounting.ledger.json": {
          definitionVersion: bad,
          definition: DEF("accounting.ledger"),
        },
      });
      await expect(
        loadReportDefinitions(db.rw, ctx(), root, s.company),
        String(bad),
      ).rejects.toThrowError(/it must be an integer of at least 1/);
    }
  });

  it("refuses a definition naming a field its dataset does not serve, at SEED time", async () => {
    const typo = await pack({
      "7b/accounting.period_comparison.json": FILE("accounting.period_comparison", 1, {
        columns: [
          {
            field: "acount_code",
            labelEn: "Code",
            labelAr: "الرمز",
            format: "text",
            align: "start",
          },
        ],
      }),
    });
    await expect(loadReportDefinitions(db.rw, ctx(), typo, s.company)).rejects.toThrowError(
      /dataset 'account_balance' has no such field: acount_code/,
    );
  });

  it("REFUSES to overwrite a tenant's clone, naming the code and version", async () => {
    const root = await pack({
      "7b/accounting.account_statement.json": FILE("accounting.account_statement"),
    });
    await loadReportDefinitions(db.rw, ctx(), root, s.company);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.report_definition set is_core = false where code = 'accounting.account_statement'`;
    });
    await expect(loadReportDefinitions(db.rw, ctx(), root, s.company)).rejects.toThrowError(
      /accounting.account_statement version 1 is a tenant's own definition/,
    );
  });

  it("refuses a definition whose file name disagrees with its code, and one that fails validation", async () => {
    const wrongName = await pack({
      "7b/accounting.ledger.json": FILE("accounting.general_ledger"),
    });
    await expect(loadReportDefinitions(db.rw, ctx(), wrongName, s.company)).rejects.toThrowError(
      /file '7b\/accounting.ledger.json' declares code 'accounting.general_ledger'/,
    );

    const invalid = await pack({
      "7b/accounting.ledger.json": FILE("accounting.ledger", 1, {
        dataset: { source: "invoices", filters: [] },
      }),
    });
    await expect(loadReportDefinitions(db.rw, ctx(), invalid, s.company)).rejects.toThrowError(
      /\/dataset\/source/,
    );

    const unseededCode = await pack({
      "7b/accounting.ledger.json": FILE("accounting.ledger", 1, {
        permission: "accounting.report.print",
      }),
    });
    // F-21: a definition naming a permission code no slice has seeded is refused at SEED time, not at run time.
    await expect(loadReportDefinitions(db.rw, ctx(), unseededCode, s.company)).rejects.toThrowError(
      /\/permission/,
    );
  });

  it("reportsLoader.load runs on a transaction runLoaders already opened, never nests, and returns rows inserted", async () => {
    const root = await pack({ "7b/inventory.expiry_list.json": FILE("inventory.expiry_list") });
    const load = () =>
      withTenant(db.rw, s.tenant, s.system, (tx) =>
        reportsLoader.load(tx, {
          config: { tenantId: s.tenant, only: ["reports"], packRoot: root } as never,
          tenantId: s.tenant,
          companyId: s.company,
          systemPrincipalId: s.system,
          packRoot: root,
        }),
      );
    expect(await load()).toBe(1);
    // §4.2.13: a loader returns the rows it inserted — zero on a re-run, which is what "changes nothing" means.
    expect(await load()).toBe(0);
    expect(reportsLoader.name).toBe("reports");
  });

  it("the shipped pack directory exists, 7A seeds none (§2.8), and every definition lives in a slice directory", async () => {
    const dir = fileURLToPath(new URL("../../seed/my/reports", import.meta.url));
    const entries = await readdir(dir, { withFileTypes: true });
    expect(entries.map((e) => e.name)).toContain("README.md");
    // Nothing at the top level is a definition, and 7A owns no directory of its own: the loader walks
    // `<slice>/<code>.json`, and the catalogue slices (7B's `7b/` first) fill their own (§4.16.1; contracts 7B
    // amendment A18 item 4 — this case pinned an empty pack until 7B's first file landed).
    expect(entries.filter((e) => e.isFile() && e.name.endsWith(".json"))).toEqual([]);
    const slices = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(slices).not.toContain("7a");
    for (const slice of slices)
      expect(slice, "a §4.16.1 owning-slice directory").toMatch(/^[0-9][a-z]$/);
  });

  it("the reports loader applies the 7c directory beside 7b's (§3.4.8, no loader change)", async () => {
    // A tenant of its own: the cases above leave synthetic rows for some of these codes in `s`.
    const t = await seedTenantV2(db, "reports-loader-7c");
    const shipped = fileURLToPath(new URL("../../seed/my", import.meta.url));
    const applied = await loadReportDefinitions(
      db.rw,
      { tenantId: t.tenant, actorId: t.system, requestId: crypto.randomUUID() },
      shipped,
      t.company,
    );
    for (const code of [
      "accounting.ageing",
      "accounting.party_statement",
      "accounting.allocation_register",
      "accounting.unreconciled_items",
      "accounting.branch_profit_and_loss",
      "accounting.tax_return_view",
      "pos.z_report",
      "pos.sales_by_cashier",
      "pos.sales_by_branch",
      "pos.needs_attention",
    ]) {
      expect([...applied.codes], code).toContain(code);
    }
    const versions = await withTenant(
      db.rw,
      t.tenant,
      t.human,
      (tx) => tx<{ code: string; version: number; is_core: boolean }[]>`
        select code, version, is_core from app.report_definition
         where company_id = ${t.company}
           and code in ('accounting.ageing', 'pos.z_report', 'pos.sales_by_cashier')
         order by code, version`,
    );
    // The three re-expressed codes are seeded at definitionVersion 2 (§4.16.1's rule). 4B and 6D shipped no
    // definition file of their own — their reports are JSON routes — so no version-1 row sits beside them.
    expect(versions).toEqual([
      { code: "accounting.ageing", version: 2, is_core: true },
      { code: "pos.sales_by_cashier", version: 2, is_core: true },
      { code: "pos.z_report", version: 2, is_core: true },
    ]);
  });

  it("loads the eight shipped 8d/ definitions from the real pack, idempotently (8D T11)", async () => {
    // A tenant of its own, as the 7c case: the synthetic cases above leave rows in `s`.
    const t = await seedTenantV2(db, "reports-loader-8d");
    const shipped = fileURLToPath(new URL("../../seed/my", import.meta.url));
    const tctx = () => ({ tenantId: t.tenant, actorId: t.system, requestId: crypto.randomUUID() });
    const first = await loadReportDefinitions(db.rw, tctx(), shipped, t.company);
    const hr = [...first.codes].filter((c) => c.startsWith("hr.")).toSorted();
    // §4.16.1's eight 8D codes — no leave definition (round 19 A13 item 19: `leave_record` is a designer source).
    expect(hr).toEqual(
      [
        "hr.employee_list",
        "hr.payroll_register",
        "hr.statutory_summary",
        "hr.payable_reconciliation",
        "hr.contract_expiry",
        "hr.attendance",
        "hr.payslip",
        "hr.annual_statement",
      ].toSorted(),
    );
    const second = await loadReportDefinitions(db.rw, tctx(), shipped, t.company);
    expect([...second.codes]).toEqual([...first.codes]);
    expect(second.inserted).toBe(0);
    const [row] = await withTenant(
      db.rw,
      t.tenant,
      t.human,
      (tx) => tx<{ n: number; versions: number[] }[]>`
        select count(*)::int as n, array_agg(distinct version) as versions
          from app.report_definition
         where company_id = ${t.company} and code like 'hr.%'`,
    );
    // Upsert on (company_id, code, version), never a second row; every 8D code is new at version 1 but
    // `hr.annual_statement`, which 9B re-versioned at 2 when its dataset began adding the cut-over opening (contracts
    // round 18 B14) — on a fresh tenant no version-1 row sits beside it.
    expect(row!.n).toBe(8);
    expect(row!.versions).toEqual([1, 2]);
    const statement = await withTenant(
      db.rw,
      t.tenant,
      t.human,
      (tx) => tx<{ version: number }[]>`
        select version from app.report_definition
         where company_id = ${t.company} and code = 'hr.annual_statement' order by version`,
    );
    expect(statement).toEqual([{ version: 2 }]);
  });
});

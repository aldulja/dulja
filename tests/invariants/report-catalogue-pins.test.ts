import { describe, expect, it } from "vitest";
// ONE statement per module specifier: `no-duplicate-imports` is on.
import { ERRORS, ReportCodeSchema } from "@dulja/contracts";
import { PERMISSIONS, isMutating, type PermissionCode } from "@dulja/contracts/permissions";
import { DATASET_IDS, EXPORT_TABLES, JOB_NAMES, NEVER_EXPORTED, discover } from "@dulja/db";
import { MIGRATIONS_DIR } from "@dulja/db/test";
import { ROUTES } from "@dulja/api/routes";
import { repoFile } from "../support/regression";
import { CATALOGUE_7B, readEnvelope } from "./support/reports";
import { CATALOGUE_7C, readEnvelope7C } from "./support/reports-7c";
import { HR_CATALOGUE, readHrEnvelope } from "./support/hr-reports";

/**
 * 7B Task 14 — every count and membership this slice's prose claims, in one file, so a later slice's change
 * fails here rather than in a review. Membership and subsets, never a total a later slice must edit (§3.7.3):
 * 7C and 8D widen `ReportCodeSchema` and the `DatasetId` union in the PRs that ship their own rows.
 */
describe("7B pins — every count this slice's prose claims (§2.8, §4.16)", () => {
  it("twenty-two definitions: seventeen new at version 1, five re-expressed at version 2", () => {
    expect(CATALOGUE_7B.length).toBe(22);
    const versions = CATALOGUE_7B.map((c) => readEnvelope(c).definitionVersion);
    expect(versions.filter((v) => v === 1).length).toBe(17);
    expect(versions.filter((v) => v === 2).length).toBe(5);
  });

  // Moved here from Task 9's catalogue gate: `packages/db` may not import `@dulja/contracts` (dependency-rule),
  // and both checks need it.
  it("every definition's gate is a registered, non-mutating permission code", () => {
    const codes = new Set<string>(PERMISSIONS.map((p) => p.code));
    for (const code of CATALOGUE_7B) {
      const permission = readEnvelope(code).definition.permission;
      expect(codes.has(permission), `${code} names ${permission}`).toBe(true);
      expect(isMutating(permission as PermissionCode), `${code}'s gate must be a read code`).toBe(
        false,
      );
    }
  });

  it("ReportCodeSchema holds this slice's twenty-two, every member is a §4.16.1 code, and none is duplicated", () => {
    const options: readonly string[] = ReportCodeSchema.options;
    for (const code of CATALOGUE_7B) expect(options).toContain(code);
    // The earlier slices' members are untouched (amendment A4: appended, never re-sorted or removed).
    for (const code of [
      "pos.z_report",
      "pos.sales_by_cashier",
      "accounting.trial_balance",
      "accounting.ledger",
      "inventory.stock_on_hand",
      "inventory.valuation",
      "inventory.sales_by_item",
      "accounting.ageing",
    ]) {
      expect(options).toContain(code);
    }
    expect(new Set(options).size, "a duplicated member").toBe(options.length);
    // §4.16.1's register, transcribed in full — all forty-one rows. A member outside it is a code invented
    // without the one-line register PR §4.16.1 requires.
    const REGISTERED = new Set<string>([
      "accounting.trial_balance",
      "accounting.ledger",
      "accounting.ageing",
      "inventory.stock_on_hand",
      "inventory.valuation",
      "inventory.sales_by_item",
      "pos.z_report",
      "pos.sales_by_cashier",
      ...CATALOGUE_7B,
      // 7C's and 8D's: registered, and members only once those slices land (`accounting.pdc_register` is
      // OD-09's and is not built).
      "accounting.party_statement",
      "accounting.allocation_register",
      "accounting.unreconciled_items",
      "accounting.pdc_register",
      "accounting.branch_profit_and_loss",
      "accounting.tax_return_view",
      "pos.sales_by_branch",
      "pos.needs_attention",
      "hr.employee_list",
      "hr.payroll_register",
      "hr.statutory_summary",
      "hr.payable_reconciliation",
      "hr.contract_expiry",
      "hr.attendance",
      "hr.payslip",
      "hr.annual_statement",
    ]);
    expect(REGISTERED.size).toBe(41);
    for (const code of options) {
      expect(REGISTERED, `${code} is not in §4.16.1's register`).toContain(code);
    }
    // Nothing from a later slice was seeded early BY THIS SLICE — asserted against 7B's own pack, not the enum.
    for (const notYet of [
      "accounting.party_statement",
      "accounting.branch_profit_and_loss",
      "pos.needs_attention",
      "hr.payroll_register",
    ]) {
      expect(CATALOGUE_7B as readonly string[], `${notYet} belongs to 7C or 8D`).not.toContain(
        notYet,
      );
    }
  });

  it("this slice added no DatasetId: every member of the union is in a slice's §4.16.2 row", () => {
    // §4.16.2's register as three sets. A SUBSET, never a count and never the absence of a later member.
    const REGISTERED_DATASETS = new Set([
      // 7A — `pdc` is registered and not built (OD-09).
      "ledger_entry",
      "account_balance",
      "account",
      "document",
      "document_line",
      "document_event",
      "audit_log",
      "party",
      "party_ageing",
      "allocation",
      "payment_term",
      "bank_statement_line",
      "bank_match",
      "pdc",
      "item",
      "lot",
      "warehouse",
      "price_list_line",
      "promotion",
      "inventory_movement",
      "stock_on_hand",
      "cost_layer",
      "cost_consumption",
      "stock_valuation",
      "item_profitability",
      "tax_transaction",
      // 7C — the Phase 6 tables.
      "shift",
      "till_event",
      "needs_attention",
      // 8D.
      "employee",
      "attendance_event",
      "payroll_line",
      "employee_ytd",
      "statutory_schedule",
      "leave_record",
    ]);
    const src = repoFile("packages/db/src/reports/datasets.ts");
    const start = src.indexOf("export type DatasetId");
    const union = src.slice(start, src.indexOf(";", start));
    const members = (union.match(/"[a-z_]+"/g) ?? []).map((m) => m.slice(1, -1));
    expect(members.length, "7A creates the union with its whole set").toBeGreaterThanOrEqual(25);
    for (const id of members) {
      expect(REGISTERED_DATASETS, `${id} is in no slice's §4.16.2 row`).toContain(id);
    }
    // The thirteen this catalogue reads are all still members, read off the catalogue rather than re-listed.
    const mine = new Set(CATALOGUE_7B.map((c) => readEnvelope(c).definition.dataset.source));
    expect(mine.size, "thirteen sources across twenty-two definitions").toBe(13);
    for (const source of mine)
      expect(members, `${source} is a source of this catalogue`).toContain(source);
  });

  it("this slice mounted no route module and added no job", () => {
    const reports = ROUTES.filter((r) => r.path.endsWith("/reports"));
    expect(reports.length, "1B's module is the only one on that path (§4.2.7)").toBe(1);
    expect(
      JOB_NAMES.filter((n) => n.startsWith("reporting.")),
      "reporting.render is 7A's and the only one",
    ).toEqual(["reporting.render"]);
  });

  it("this slice added no ERRORS row and consumes 7A's one report code", () => {
    expect(Object.keys(ERRORS)).toContain("ERR_REPORT_DATASET_UNKNOWN");
    for (const invented of [
      "ERR_REPORT_TIE_OUT",
      "ERR_REPORT_FIELD_UNKNOWN",
      "ERR_REPORT_INVALID",
    ]) {
      expect(Object.keys(ERRORS), `${invented} is not a registered code`).not.toContain(invented);
    }
  });

  it("0077 is this slice's only migration, and it has a hand-written down", () => {
    const all = discover(MIGRATIONS_DIR);
    const mine = all.filter((m) => m.version === 77);
    expect(mine.length).toBe(1);
    expect(mine[0]!.name).toBe("add_report_filter_indexes");
    expect(mine[0]!.downPath).toMatch(/0077\.down\.sql$/);
    // 0078-0079 are 7C's, and 7B wrote neither: whatever occupies them carries 7C's names (7C's pins below).
    expect(
      all
        .filter((m) => m.version > 77 && m.version < 80)
        .map((m) => m.name)
        .toSorted(),
      "0078-0079 are 7C's and this slice writes neither",
    ).toEqual(["create_export_job", "seed_permission_phase7c"]);
    // Indexes only (contracts 7B A7): no table, column, constraint, function, grant or row.
    const sql = repoFile("packages/db/migrations/0077_add_report_filter_indexes.sql")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\b(create|alter|drop)\s+(table|function|procedure|trigger|policy)\b/i);
    expect(sql).not.toMatch(/\b(insert|update|delete|grant|revoke)\b/i);
  });

  it("the linter sets and the DELETE pin are untouched (§3.5.3, §3.5.4)", () => {
    const lint = repoFile("packages/db/src/lint-schema.ts");
    expect(lint).not.toContain("report_definition");
    expect(lint).not.toContain("7B");
    const privileges = repoFile("packages/db/test/privileges.test.ts").replace(/\s+/g, " ");
    expect(privileges).toContain(
      '"document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission",',
    );
  });

  it("the re-expression left every owning slice's route and read function in place (amendment A2)", () => {
    const route = repoFile("apps/api/src/routes/accounting/reports.ts");
    for (const call of ["trialBalance(", "accountLedger(", "accountOpeningBalance("]) {
      expect(route, `1B's handler must still call ${call}`).toContain(call);
    }
    for (const fn of ["stockOnHand(", "salesByItem(", "valuationAsOf("]) {
      expect(route, `3D's and 3B's handlers must still call ${fn}`).toContain(fn);
    }
    expect(route, "no definition-driven handler on the JSON list routes").not.toContain(
      "datasetFor(",
    );
  });
});

/**
 * 7C Task 14 — the counts the 7C slice and Phase 7's close-out claim (contracts round 15, A15 and A16 item 1).
 * Two of them are TOTALS, deliberately, and say so: the code register and the dataset registry are closed for
 * v1 (§4.16), and 8D, the next slice to widen either, edits these two pins in the PR that ships its own rows
 * (§3.7.3 — the slice that changes a shared registry updates its pin, as 7C's Task 1 did to 6D's).
 */
describe("7C pins — the Phase 7 catalogue as it closes (§2.8, §4.16)", () => {
  it("ten 7C definitions: seven new at version 1, three re-expressed at version 2 (OD-09's eleventh dropped)", () => {
    expect(CATALOGUE_7C.length).toBe(10);
    const v2 = CATALOGUE_7C.filter((c) => readEnvelope7C(c).definitionVersion === 2).toSorted();
    expect(v2).toEqual(["accounting.ageing", "pos.sales_by_cashier", "pos.z_report"]);
    expect(CATALOGUE_7C as readonly string[]).not.toContain("accounting.pdc_register");
    // The two seed directories are disjoint (§4.16.1).
    for (const code of CATALOGUE_7C) expect(CATALOGUE_7B as readonly string[]).not.toContain(code);
  });

  it("ReportCodeSchema is exactly the shipped definitions — every member has a seed file and every file a member", () => {
    // Phase 7 closed it at thirty-two; 8D Task 11 appended §4.16.1's eight `hr.*` codes (forty) in the PR that
    // ships their files, moving this total as the comment above says the next widening slice must.
    const options = [...ReportCodeSchema.options].toSorted();
    const shipped = [...CATALOGUE_7B, ...CATALOGUE_7C, ...HR_CATALOGUE].toSorted();
    expect(options).toEqual(shipped);
    expect(options.length).toBe(40);
    expect(options).not.toContain("accounting.pdc_register");
  });

  it("every 7C gate is a registered code, mutating only where §4.16.1 makes it so", () => {
    const codes = new Set<string>(PERMISSIONS.map((p) => p.code));
    const mutating: string[] = [];
    for (const code of CATALOGUE_7C) {
      const permission = readEnvelope7C(code).definition.permission;
      expect(codes.has(permission), `${code} names ${permission}`).toBe(true);
      if (isMutating(permission as PermissionCode)) mutating.push(code);
    }
    // A reconciler's, a tax manager's and a queue resolver's report — each gated by the code that acts on what
    // it lists (spec:2147; round 15, A7 and A8).
    expect(mutating.toSorted()).toEqual([
      "accounting.tax_return_view",
      "accounting.unreconciled_items",
      "pos.needs_attention",
    ]);
  });

  it("the dataset registry closed Phase 7 at twenty-eight: 7A's twenty-five and 7C's three, no pdc", () => {
    // 8D appends after 7C's three (contracts round 19, 8D A13 item 1): five in 8D Task 2 (33), `leave_record` in
    // Task 8 (34; ⚠️ OD-13 answered build, round 19 A14). Phase 7's twenty-eight keep their positions.
    expect(DATASET_IDS.length).toBe(34);
    expect(DATASET_IDS.slice(25, 28)).toEqual(["shift", "till_event", "needs_attention"]);
    expect(DATASET_IDS.slice(28)).toEqual([
      "employee",
      "attendance_event",
      "payroll_line",
      "employee_ytd",
      "statutory_schedule",
      "leave_record",
    ]);
    expect(DATASET_IDS as readonly string[]).not.toContain("pdc");
    // `till_event` is registered and read by no core definition — a designer source (A2).
    const sources = new Set(
      [
        ...CATALOGUE_7B.map((c) => readEnvelope(c)),
        ...CATALOGUE_7C.map((c) => readEnvelope7C(c)),
      ].map((e) => e.definition.dataset.source),
    );
    expect(sources.has("till_event")).toBe(false);
    for (const source of sources) expect(DATASET_IDS as readonly string[]).toContain(source);
  });

  it("7C added one job, one route module, two migrations and one permission", () => {
    expect(JOB_NAMES).toContain("admin.export.run");
    expect(JOB_NAMES.filter((n) => n.startsWith("reporting."))).toEqual(["reporting.render"]);
    expect(ROUTES.filter((r) => r.path === "/v1/companies/:companyId/exports").length).toBe(1);
    const all = discover(MIGRATIONS_DIR);
    for (const [version, name] of [
      [78, "create_export_job"],
      [79, "seed_permission_phase7c"],
    ] as const) {
      const mine = all.filter((m) => m.version === version);
      expect(mine.length, String(version)).toBe(1);
      expect(mine[0]!.name).toBe(name);
      expect(mine[0]!.downPath).toMatch(new RegExp(`00${version}\\.down\\.sql$`));
    }
    // Phase 7 owns 0074-0079 and used all six; nothing else landed in its range.
    expect(all.filter((m) => m.version >= 74 && m.version <= 79).map((m) => m.version)).toEqual([
      74, 75, 76, 77, 78, 79,
    ]);
    const exportCode = PERMISSIONS.find((p) => p.code === "admin.data.export");
    expect(exportCode?.mutating).toBe(false);
  });

  it("the export registry and the never-exported pins are disjoint, and every table is classified once", () => {
    const exported = new Set(EXPORT_TABLES.map((t) => t.name));
    expect(exported.size, "a table registered twice").toBe(EXPORT_TABLES.length);
    for (const [table, columns] of Object.entries(NEVER_EXPORTED)) {
      if (columns.includes("*"))
        expect(exported.has(table), `${table} is pinned whole`).toBe(false);
    }
  });
});

/**
 * 8D Task 11 — `ReportCodeSchema` widened by §4.16.1's eight `hr.*` codes (§4.16.3). The wire enum and the register
 * agree in both directions: every 8D code is a member, and every `hr.` member is one of the eight — a ninth would be
 * a literal invented outside the register (hazard 32). Kept here, not in `packages/db`, because a `packages/db` test
 * may not import `@dulja/contracts` (dependency-rule; round 18 B16 item 3).
 */
/** The 8D codes whose definition asks `gate`, sorted. */
const hrCodesGatedBy = (gate: string): string[] =>
  HR_CATALOGUE.filter((c) => readHrEnvelope(c).definition.permission === gate).toSorted();

describe("8D pins — the HR report codes reach the wire (§4.16.1, §4.16.3)", () => {
  it("ReportCodeSchema holds every 8D code and nothing 8D did not ship", () => {
    const wire = new Set<string>(ReportCodeSchema.options);
    for (const code of HR_CATALOGUE) expect(wire, code).toContain(code);
    for (const code of [...wire].filter((c) => c.startsWith("hr."))) {
      expect(HR_CATALOGUE as readonly string[], code).toContain(code);
    }
    // Appended after 7C's last member, in §4.16.1's register order — never re-sorted.
    const options: readonly string[] = ReportCodeSchema.options;
    expect(options.slice(-8)).toEqual([
      "hr.employee_list",
      "hr.payroll_register",
      "hr.statutory_summary",
      "hr.payable_reconciliation",
      "hr.contract_expiry",
      "hr.attendance",
      "hr.payslip",
      "hr.annual_statement",
    ]);
  });

  it("every 8D gate is a registered read code, and the payroll reports ask hr.payroll.read", () => {
    const codes = new Set<string>(PERMISSIONS.map((p) => p.code));
    for (const code of HR_CATALOGUE) {
      const { definition, definitionVersion } = readHrEnvelope(code);
      // Every 8D code is new in 8D (version 1) but `hr.annual_statement`, which 9B re-versioned when the employee_ytd
      // dataset began adding the cut-over opening (contracts round 18 B14; the runbook's "bump on a statement edit").
      expect(definitionVersion, `${code} is new in 8D`).toBe(
        code === "hr.annual_statement" ? 2 : 1,
      );
      expect(codes.has(definition.permission), `${code} names ${definition.permission}`).toBe(true);
      expect(isMutating(definition.permission as PermissionCode), code).toBe(false);
      expect(definition.module).toBe("hr");
    }
    expect(hrCodesGatedBy("hr.employee.read")).toEqual(
      ["hr.attendance", "hr.contract_expiry", "hr.employee_list"].toSorted(),
    );
    expect(hrCodesGatedBy("hr.payroll.read")).toEqual(
      [
        "hr.annual_statement",
        "hr.payable_reconciliation",
        "hr.payroll_register",
        "hr.payslip",
        "hr.statutory_summary",
      ].toSorted(),
    );
  });
});

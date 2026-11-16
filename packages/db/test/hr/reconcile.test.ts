import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { currency, Money } from "@dulja/domain";
import { payslipRows } from "../../src/hr/payslip";
import {
  parseLegacyCsv,
  ReconcileError,
  reconcileParallelRun,
  renderReconciliation,
  type LegacyPayslip,
  type ReconciliationReport,
} from "../../src/hr/reconcile";
import {
  hrReportFixture,
  type HrReportFixture,
} from "../../../../tests/invariants/support/hr-reports";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

// 8D T9 (⚠️ OD-23) — the Phase 8 DoD's first clause made mechanical. The "legacy" side of every case is DERIVED from
// the posted run itself (which the SYNTH table computed), then perturbed — nothing here is a typed statutory figure.
// `bun run payroll:reconcile --self-test` runs the first case by its name, "clean to the cent".

const MYR = currency("MYR");

describe("reconcileParallelRun — the Phase 8 DoD's first clause, made mechanical", () => {
  let db: Db;
  let s: Seed;
  let f: HrReportFixture;
  /** Built ONCE from the posted run, then copied per case — the identity baseline every case perturbs. */
  let baseline: LegacyPayslip[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "reconcile");
    f = await hrReportFixture(db, s);
    baseline = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const bundles = await payslipRows(tx, {
        companyId: s.company,
        payrollDocumentId: f.runDocumentId,
      });
      return bundles.map((b) => {
        const schemes: Record<string, string> = {};
        for (const r of b.rows) {
          if (r["scheme_code"] === null || r["share"] !== "employee") continue;
          const code = String(r["scheme_code"]);
          schemes[code] = Money.of(schemes[code] ?? "0.0000", MYR)
            .add(Money.of(String(r["amount"] ?? "0.0000"), MYR))
            .toString();
        }
        return {
          employeeNumber: b.header.employeeNumber,
          gross: b.header.gross,
          totalDeductions: b.header.totalDeductions,
          net: b.header.net,
          schemes,
        };
      });
    });
    expect(baseline.length).toBe(2);
    expect(Object.keys(baseline[0]!.schemes).length).toBeGreaterThan(0);
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  /** A deep copy, so a case's perturbation never leaks into the next one. */
  const legacyFromDulja = (): LegacyPayslip[] =>
    baseline.map((l) => ({ ...l, schemes: { ...l.schemes } }));

  const run = (
    legacy: readonly LegacyPayslip[],
    payrollDocumentId = f.runDocumentId,
    actor = s.human,
  ): Promise<ReconciliationReport> =>
    withTenant(db.rw, s.tenant, actor, (tx) =>
      reconcileParallelRun(
        tx,
        { companyId: s.company, payrollDocumentId, baseCurrency: MYR },
        legacy,
      ),
    );

  it("reports nothing when the legacy figures match — clean to the cent", async () => {
    const report = await run(legacyFromDulja());
    expect(report.differences).toEqual([]);
    expect(report.cleanToTheCent).toBe(true);
    expect(report.matched).toBe(report.employeesInDulja);
    expect(report.employeesInLegacy).toBe(2);
    expect(report.periodStart).toBe(f.periodStart);
    expect(report.periodEnd).toBe(f.periodEnd);
  });

  it("the CLI's context — the tenant's system principal — reads the same run clean", async () => {
    const report = await run(legacyFromDulja(), f.runDocumentId, s.system);
    expect(report.cleanToTheCent).toBe(true);
    expect(report.employeesInDulja).toBe(2);
  });

  it("compares amounts, not strings: a legacy export at two places matches Dulja's four", async () => {
    const legacy = legacyFromDulja().map((l) => ({
      ...l,
      gross: l.gross.replace(/00$/, ""),
      net: l.net.replace(/00$/, ""),
    }));
    expect(legacy[0]!.net).toMatch(/^\d+\.\d{2}$/);
    expect((await run(legacy)).cleanToTheCent).toBe(true);
  });

  it("names the employee, the field and the signed delta on a net difference", async () => {
    const legacy = legacyFromDulja();
    legacy[0]!.net = Money.of(legacy[0]!.net, MYR).add(Money.of("0.0100", MYR)).toString();
    const report = await run(legacy);
    expect(report.differences).toHaveLength(1);
    const d = report.differences[0]!;
    expect(d.kind).toBe("net");
    expect(d.field).toBe("net");
    expect(d.employeeNumber).toBe(legacy[0]!.employeeNumber);
    expect(d.delta).toBe("-0.0100"); // dulja − legacy, signed, at 4 dp
    expect(report.cleanToTheCent).toBe(false);
  });

  it("reports gross and deductions differences by their own kinds", async () => {
    const legacy = legacyFromDulja();
    legacy[1]!.gross = Money.of(legacy[1]!.gross, MYR).subtract(Money.of("1.0000", MYR)).toString();
    legacy[1]!.totalDeductions = Money.of(legacy[1]!.totalDeductions, MYR)
      .add(Money.of("0.0500", MYR))
      .toString();
    const report = await run(legacy);
    expect(report.differences.map((d) => [d.kind, d.delta])).toEqual([
      ["gross", "1.0000"],
      ["deductions", "-0.0500"],
    ]);
  });

  it("reports an employee present on one side only, in both directions", async () => {
    const extra = [
      ...legacyFromDulja(),
      {
        employeeNumber: "E-9999",
        gross: "1.0000",
        totalDeductions: "0.0000",
        net: "1.0000",
        schemes: {},
      },
    ];
    const one = await run(extra);
    expect(one.differences.map((d) => [d.employeeNumber, d.kind])).toEqual([
      ["E-9999", "missing_in_dulja"],
    ]);
    expect(one.matched).toBe(2);
    const two = await run(legacyFromDulja().slice(1));
    expect(two.differences.map((d) => [d.employeeNumber, d.kind])).toEqual([
      [baseline[0]!.employeeNumber, "missing_in_legacy"],
    ]);
    expect(two.differences[0]!.dulja).toBe(baseline[0]!.net);
  });

  it("reports a scheme the legacy system computed differently and one it did not compute at all", async () => {
    const a = legacyFromDulja();
    const code = Object.keys(a[0]!.schemes)[0]!;
    a[0]!.schemes = { ...a[0]!.schemes, [code]: "0.0000" };
    const ra = await run(a);
    expect(ra.differences.some((d) => d.kind === "scheme" && d.field === code)).toBe(true);
    const b = legacyFromDulja();
    b[0]!.schemes = {};
    const rb = await run(b);
    expect(rb.differences).toEqual([
      expect.objectContaining({ kind: "scheme_absent", field: code, legacy: null }),
    ]);
    const c = legacyFromDulja();
    c[0]!.schemes = { ...c[0]!.schemes, "LEGACY-ONLY": "3.0000" };
    expect((await run(c)).differences).toEqual([
      expect.objectContaining({ kind: "scheme_absent", field: "LEGACY-ONLY", dulja: null }),
    ]);
  });

  it("refuses a run that is not posted rather than reporting every employee missing", async () => {
    await expect(run(legacyFromDulja(), f.draftRunDocumentId)).rejects.toBeInstanceOf(
      ReconcileError,
    );
  });

  it("renderReconciliation is deterministic — the same report renders the same bytes", async () => {
    const legacy = legacyFromDulja();
    legacy[1]!.net = "0.0000";
    const report = await run(legacy);
    const md = renderReconciliation(report);
    expect(md).toBe(renderReconciliation(await run(legacy)));
    expect(md).toContain("| Employee | Field | Legacy | Dulja | Delta |");
    expect(md).toContain(`| ${legacy[1]!.employeeNumber} | net (net) | 0.0000 |`);
    expect(md).toContain("## Accepted differences");
    expect(renderReconciliation(await run(legacyFromDulja()))).toContain("**Clean to the cent.**");
  });

  it("the CLI writes the report it prints: one difference, exit 0, the Markdown on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "payroll-reconcile-"));
    const legacy = legacyFromDulja();
    legacy[0]!.net = "0.0000";
    const codes = [...new Set(legacy.flatMap((l) => Object.keys(l.schemes)))].toSorted();
    const csv = [
      ["employee_number", "gross", "total_deductions", "net", ...codes.map((c) => `${c}_employee`)],
      ...legacy.map((l) => [
        l.employeeNumber,
        l.gross,
        l.totalDeductions,
        l.net,
        ...codes.map((c) => l.schemes[c] ?? ""),
      ]),
    ]
      .map((r) => r.join(","))
      .join("\n");
    writeFileSync(join(dir, "legacy.csv"), csv, "utf8");
    const cli = spawnSync(
      "bun",
      [
        "scripts/payroll-reconcile.ts",
        "--tenant",
        s.tenant,
        "--company",
        s.company,
        "--run",
        f.runDocumentId,
        "--legacy",
        join(dir, "legacy.csv"),
        "--out",
        join(dir, "report.md"),
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env: { ...process.env, DATABASE_URL: db.url("app_rw") },
        encoding: "utf8",
      },
    );
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
    expect(cli.stdout).toBe(`differences: 1 — see ${join(dir, "report.md")}\n`);
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain(
      `| ${legacy[0]!.employeeNumber} | net (net) | 0.0000 | ${baseline[0]!.net} |`,
    );
  }, 60_000);

  it("parseLegacyCsv reads the owner's export: scheme columns by suffix, a blank cell means not computed", () => {
    const rows = parseLegacyCsv(
      "﻿employee_number,gross,total_deductions,net,S1_employee,S2_employee\r\n" +
        "E-1,100.00,10.00,90.00,10.00,\r\n\r\n",
    );
    expect(rows).toEqual([
      {
        employeeNumber: "E-1",
        gross: "100.00",
        totalDeductions: "10.00",
        net: "90.00",
        schemes: { S1: "10.00" },
      },
    ]);
  });

  it("parseLegacyCsv refuses what it cannot compare exactly", () => {
    const head = "employee_number,gross,total_deductions,net";
    for (const bad of [
      head, // no data rows
      "employee_number,gross,net\nE-1,1,1", // a missing column
      `${head}\nE-1,1.00001,0,1`, // five places
      `${head}\nE-1,1,0`, // a short row
      `${head}\nE-1,1,0,1\nE-1,1,0,1`, // the same employee twice
      `${head}\n,1,0,1`, // no employee number
    ]) {
      expect(() => parseLegacyCsv(bad), bad).toThrow(ReconcileError);
    }
  });

  it("no assertion in this file states a statutory figure — hazard 1", () => {
    // Every figure this file compares came out of the posted run, which came out of the SYNTH table. The literals it
    // does carry are deltas, placeholders and CSV-parser inputs, not statutory values.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(EPF|SOCSO|EIS|PCB)\s*[:=]\s*\d/);
    expect(source).not.toMatch(new RegExp(["\\b", "r", "ates?\\b"].join(""), "i"));
  });
});

// scripts/payroll-reconcile.ts — `bun run payroll:reconcile`, the command 8D Task 9's owner gate (⚠️ OD-23) names: it
// compares one POSTED Dulja payroll run against the legacy system's payslip export for the same month and writes the
// Markdown difference report the owner signs (docs/runbooks/payroll-parallel-run.md).
//
// The imports are RELATIVE, for the reason `scripts/reseed-verify.ts` records: `scripts/` is not a workspace and the
// isolated linker gives it no `node_modules`, so `@dulja/db` would not resolve from here. Nothing is imported from
// `tests/`: `--self-test` SPAWNS the vitest case that owns the Testcontainers corpus instead of booting one here.
//
// Exit codes: 0 whether or not differences were found (a difference is a finding, not a failure — the definition of
// done is met by the owner's signature on the explanations, never by a zero); 2 on a configuration or input error,
// the seed CLI's convention (§4.2.13); the vitest exit code when the self-test fails.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currency } from "../packages/domain/src/index";
import {
  createDb,
  parseLegacyCsv,
  ReconcileError,
  reconcileParallelRun,
  renderReconciliation,
  systemContext,
  TenantContextError,
  withTenant,
} from "../packages/db/src/index";

const USAGE = `usage:
  payroll:reconcile --tenant <uuid> --company <uuid> --run <payroll document uuid> --legacy <csv> --out <md> [--currency MYR]
  payroll:reconcile --self-test`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function fail(line: string): number {
  process.stderr.write(`${line}\n`);
  return 2;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--self-test")) {
    // Hazard 5's local equivalent, run where the corpus lives: `hrReportFixture` posts a SYNTH run, the case derives
    // the legacy list from it and must report zero differences — so no real statutory figure enters the repository.
    const r = spawnSync(
      "bun",
      ["run", "test", "test/hr/reconcile.test.ts", "-t", "clean to the cent"],
      { cwd: fileURLToPath(new URL("../packages/db", import.meta.url)), stdio: "inherit" },
    );
    if (r.status === 0) {
      out("differences: 0 — clean to the cent");
      return 0;
    }
    return r.status ?? 2;
  }

  const tenant = flag(argv, "tenant");
  const company = flag(argv, "company");
  const run = flag(argv, "run");
  const legacyPath = flag(argv, "legacy");
  const outPath = flag(argv, "out");
  if (!tenant || !company || !run || !legacyPath || !outPath) return fail(USAGE);
  for (const [name, value] of [
    ["tenant", tenant],
    ["company", company],
    ["run", run],
  ] as const) {
    if (!UUID.test(value)) return fail(`--${name} must be a uuid\n${USAGE}`);
  }
  const code = flag(argv, "currency") ?? "MYR";
  if (!/^[A-Z]{3}$/.test(code)) return fail(`--currency must be a three-letter code`);

  let legacy;
  try {
    legacy = parseLegacyCsv(readFileSync(legacyPath, "utf8"));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // `app_rw`, exactly what the API connects as: the comparison only reads.
  const url = process.env["DATABASE_URL"];
  if (!url) return fail("DATABASE_URL is not set (§3.11)");
  const sql = createDb(url);
  try {
    // The tenant's SYSTEM principal, never the tenant id in the actor slot (hazard 20).
    const ctx = await systemContext(sql, tenant, crypto.randomUUID());
    const report = await withTenant(sql, ctx, (tx) =>
      reconcileParallelRun(
        tx,
        { companyId: company, payrollDocumentId: run, baseCurrency: currency(code) },
        legacy,
      ),
    );
    writeFileSync(outPath, renderReconciliation(report), "utf8");
    out(
      report.cleanToTheCent
        ? "differences: 0 — clean to the cent"
        : `differences: ${report.differences.length} — see ${outPath}`,
    );
    return 0;
  } catch (e) {
    // An unknown tenant (no system principal) or a run that is not a posted run of the company: configuration.
    if (e instanceof ReconcileError || e instanceof TenantContextError) return fail(e.message);
    throw e;
  } finally {
    await sql.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);

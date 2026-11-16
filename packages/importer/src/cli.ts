// contracts §3.2: a package's `src/cli.ts` is the one place it may print; `.oxlintrc.json`'s override grants it.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createHrKeyRing, systemContext, withTenant, type HrKeyRing } from "@dulja/db";
import { FixtureLegacyDriver, readCorpus } from "./drivers/fixture";
import { ReportWriter } from "./artefacts";
import { answerOpenQuestions, type OpenQuestionReport } from "./catalogue/questions";
import { catalogueTemplates, locateTemplates, type TemplateCatalogue } from "./catalogue/templates";
import { connectOdbc, type OdbcOptions } from "./drivers/odbc";
import { moduleOf } from "./legacy/modules";
import type { LegacyDriver } from "./legacy/types";
import { readAccountMap } from "./load/account-map";
import { clearAccountMap, setAccountMap } from "./load/accounts";
import { runLoad, setLoadSource } from "./load/run";
import { assertImportTarget, type ImportTarget } from "./load/target";
// After `./load/run`, which imports the registry: a loader module imported first would build `loaders` with that loader
// still unset (9B T6's note), and the registry imports this one.
import { clearKeyRing, setKeyRing } from "./load/employees";
import { reconcileCutOver, type Comparison } from "./load/reconcile-cut-over";
import { ACCOUNT_MAP_TARGETS, SENSITIVE_TARGETS } from "./load/registry";
import type { LoadContext } from "./load/types";
import { mposDecision, type MposDecisionReport } from "./mpos";
import { profile } from "./profile";
import { createReader, type LegacyReader } from "./reader";
import { reconcile, RECONCILIATION_KINDS, type ReconciliationReport } from "./reconcile";
import { scope, type ScopeReport } from "./scope";
import { snapshot } from "./snapshot";

export interface CliArgs {
  readonly command: string;
  readonly flags: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
}

/**
 * `--key value` becomes a flag; `--key` with no value becomes a switch. No third form exists: a `--key=value` token,
 * a bare word that follows a switch, a key given twice and an empty value are refused here (2026-11-15 review,
 * HRP-05/HRP-06), so `--dry-run=true` can never be read as "no --dry-run" and run a real, one-shot load, and an
 * empty `--fixture "$UNSET"` can never pass for a named source. Throws a `config:` message, which `main` maps to 2.
 * Which keys a command accepts is `checkArgs`'s question.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? "";
    if (!token.startsWith("--") || token.length === 2)
      throw new Error(
        `config: unexpected argument ${JSON.stringify(token)} — every option is --key [value]`,
      );
    const key = token.slice(2);
    if (key.includes("="))
      throw new Error(
        `config: write --${key.slice(0, key.indexOf("="))} as its own word — the --key=value form is not accepted`,
      );
    if (key in flags || switches.has(key)) throw new Error(`config: --${key} is given twice`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) switches.add(key);
    else {
      if (next.trim() === "") throw new Error(`config: --${key} is given an empty value`);
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags, switches };
}

/** The options every command reads its source from (`openDriver`). */
const SOURCE_FLAGS = ["fixture", "dsn", "firebird-version"] as const;
const LOAD_TARGET_FLAGS = ["tenant-id", "company-id", "cut-over-date", "account-map"] as const;
const REPORT_OPTIONS = {
  flags: [...SOURCE_FLAGS, "mpos-dsn", "kind", "tables", "out"],
  switches: ["mpos", "include-mpos"],
} as const;

/**
 * The keys each command accepts (HRP-05). A key outside them, a flag given no value and a switch given one are
 * refused before anything is opened: an unknown option is a typo the operator meant something by, and on `load` the
 * cost of guessing is a one-shot opening posted for real.
 */
const OPTIONS: Readonly<
  Record<string, { readonly flags: readonly string[]; readonly switches: readonly string[] }>
> = {
  scope: REPORT_OPTIONS,
  profile: REPORT_OPTIONS,
  reconcile: REPORT_OPTIONS,
  templates: REPORT_OPTIONS,
  questions: REPORT_OPTIONS,
  snapshot: REPORT_OPTIONS,
  all: REPORT_OPTIONS,
  load: { flags: [...SOURCE_FLAGS, ...LOAD_TARGET_FLAGS, "only"], switches: ["dry-run"] },
  "reconcile-cut-over": { flags: [...SOURCE_FLAGS, ...LOAD_TARGET_FLAGS], switches: [] },
};

/** Answers the refusal text, or null when every option is one the command reads, in the form it reads it. */
export function checkArgs(args: CliArgs): string | null {
  const options = OPTIONS[args.command];
  if (options === undefined) return null; // `main` refuses the command itself
  for (const key of Object.keys(args.flags)) {
    if (options.flags.includes(key)) continue;
    if (options.switches.includes(key))
      return `config: --${key} takes no value (got ${JSON.stringify(args.flags[key])})`;
    return `config: ${args.command} does not accept --${key}`;
  }
  for (const key of args.switches) {
    if (key === "help" || options.switches.includes(key)) continue;
    if (options.flags.includes(key)) return `config: --${key} needs a value`;
    return `config: ${args.command} does not accept --${key}`;
  }
  return null;
}

/**
 * The exit codes the runbook relies on, as `packages/db/src/cli.ts` uses them: 0 success, 2 for a configuration
 * mistake (an unknown command or `--kind`, no source named, a `--fixture` not on disk, `--mpos` without its
 * variable) or a load the framework refused (the message starts with its `ERR_` code), 3 for
 * `ERR_IMPORT_SOURCE_UNREADABLE` (a source that cannot be opened or read as asked, a failed pre-flight included).
 * 9B's `load` adds 1: the load completed and reported skips, which the operator reads in `skips.csv` before going on.
 * 9B's `reconcile-cut-over` adds 4 (9B plan N9): the reconciliation ran and at least one difference is NOT explained
 * (ADR 0086) — a fourth outcome, distinct from a refusal (2) and an unreadable source (3), which the runbook stops on.
 */
const EXIT_SKIPS = 1;
const EXIT_CONFIG = 2;
const EXIT_UNREADABLE = 3;
const EXIT_UNEXPLAINED = 4;

/** The registry's two lists (9B T9 moved them there, so the `admin.import.run` handler reads the same ones). */
const READS_ACCOUNT_MAP = ACCOUNT_MAP_TARGETS;
const SEALS_SENSITIVE = SENSITIVE_TARGETS;

/**
 * The HR key ring the employee load seals under: `HR_FIELD_ENCRYPTION_KEY` and `HR_FIELD_ENCRYPTION_KEY_VERSION`
 * (§3.11), the SAME key and version the tenant's api and worker run with — a field sealed under any other key is
 * unreadable to them. No `DEV_HR_KEY` fallback: the CLI cannot tell a development database from a customer's, and a
 * customer's national ids sealed under the published all-zero key are as good as plain. The version is the worker's
 * rule (`apps/worker/src/hr-keys.ts`, reproduced because §3.1 forbids importing an app): strict digits, default 1;
 * `createHrKeyRing` checks the range and the key's encoding, naming the variable and never its value. Answers the
 * refusal text instead of a ring.
 */
function hrKeyRingFromEnv(): HrKeyRing | string {
  const key = process.env["HR_FIELD_ENCRYPTION_KEY"];
  if (!key)
    return `config: load needs HR_FIELD_ENCRYPTION_KEY (the key the tenant's api and worker run with, and HR_FIELD_ENCRYPTION_KEY_VERSION beside it) unless --only leaves out ${SEALS_SENSITIVE.join(", ")}: an employee's sensitive fields are sealed under it (§4.12.5)`;
  const raw = process.env["HR_FIELD_ENCRYPTION_KEY_VERSION"];
  const text = raw === undefined || raw === "" ? "1" : raw;
  if (!/^[1-9][0-9]{0,2}$/.test(text))
    return "config: HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255";
  try {
    return createHrKeyRing({ current: key, currentVersion: Number(text) });
  } catch (cause) {
    return `config: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

/** Resolved from this module's own URL, never from `process.cwd()`, so `--fixture` works from any directory. */
const CORPUS_ROOT = fileURLToPath(new URL("../test/corpus", import.meta.url));

async function openDriver(args: CliArgs): Promise<LegacyDriver> {
  const fixture = args.flags.fixture;
  if (fixture)
    return new FixtureLegacyDriver(
      readCorpus(join(CORPUS_ROOT, fixture)),
      ["fixture corpus", fixture].join(" "),
    );
  const dsn = args.flags.dsn ?? process.env.LEGACY_ODBC_DSN;
  // Throws rather than calling `process.exit`, so `main()` stays importable from a test. The message carries no
  // ERR_ token, so `main`'s catch maps it to EXIT_CONFIG.
  if (!dsn)
    throw new Error("config: pass --dsn <odbc dsn> (or set LEGACY_ODBC_DSN), or --fixture <name>");
  return connectOdbc(odbcOptions(dsn, args));
}

/**
 * 9B review, finding 1 (contracts §3.11, round 20 C19). A DSN taken from `LEGACY_ODBC_DSN` is the deployment's
 * configured source, bound to one tenant and company by `LEGACY_IMPORT_TARGET`: `load` and `reconcile-cut-over` read it
 * only for that company, so an operator's mistyped `--company-id` cannot load one customer's database into another.
 * An explicit `--dsn` (or `--fixture`) names the source on the same command line as the target and needs no binding.
 * Prints the refusal and answers false; checked before any connection is opened.
 */
function boundForEnvSource(args: CliArgs, target: ImportTarget): boolean {
  // The same test `openDriver` makes (HRP-06): only a source it will actually open counts as named here.
  if (args.flags.dsn || args.flags.fixture) return true;
  if (!process.env.LEGACY_ODBC_DSN) return true; // openDriver's own "pass --dsn" refusal follows
  try {
    assertImportTarget(target);
    return true;
  } catch (cause) {
    console.error(["config:", cause instanceof Error ? cause.message : String(cause)].join(" "));
    return false;
  }
}

function odbcOptions(dsn: string, args: CliArgs): OdbcOptions {
  const version = args.flags["firebird-version"];
  return version === undefined ? { dsn } : { dsn, firebirdVersion: version };
}

/**
 * OD-16 (Part VII #10, ⚠️): the separate `mpos` database is read only when the owner asks — `--mpos-dsn <dsn>`,
 * or `--mpos`, which takes the DSN from `LEGACY_MPOS_DSN` so no password sits on a command line `bun run`
 * echoes. The variable alone reads nothing: the §2.12 default is to start the new POS clean.
 */
function mposDsn(args: CliArgs): string | null {
  const flag = args.flags["mpos-dsn"];
  if (flag) return flag;
  if (!args.switches.has("mpos")) return null;
  const fromEnv = process.env.LEGACY_MPOS_DSN;
  if (!fromEnv)
    throw new Error(
      "config: --mpos reads the POS database's DSN from LEGACY_MPOS_DSN, which is unset (OD-16)",
    );
  return fromEnv;
}

function writeJson(out: string, name: string, value: unknown): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, name);
  writeFileSync(path, [JSON.stringify(value, null, 2), "\n"].join(""), "utf8");
  return path;
}

const COMMANDS: ReadonlySet<string> = new Set([
  "scope",
  "profile",
  "reconcile",
  "templates",
  "questions",
  "snapshot",
  "all",
  "load",
  "reconcile-cut-over",
]);

/** `--kind all` (the default) or one member of §4.13.1's closed union; anything else is a configuration mistake. */
function reconcileKinds(requested: string): readonly ReconciliationReport["kind"][] | null {
  if (requested === "all") return RECONCILIATION_KINDS;
  const one = RECONCILIATION_KINDS.find((k) => k === requested);
  return one === undefined ? null : [one];
}

const USAGE = [
  "usage: bun run legacy <scope|profile|reconcile|templates|questions|snapshot|all|load|reconcile-cut-over>",
  "[--dsn <odbc dsn> | --fixture <name>] [--mpos-dsn <odbc dsn> | --mpos] [--include-mpos]",
  "[--firebird-version <v>]",
  ["[--kind <all|", RECONCILIATION_KINDS.join("|"), ">]"].join(""),
  "[--tables A,B] [--out <dir>]",
  "| load --tenant-id <uuid> --company-id <uuid> --cut-over-date <YYYY-MM-DD> --account-map <path>",
  "[--dry-run] [--only a,b]",
  "| reconcile-cut-over --tenant-id <uuid> --company-id <uuid> --cut-over-date <YYYY-MM-DD> --account-map <path>",
  "(DATABASE_URL names the app_rw database; HR_FIELD_ENCRYPTION_KEY[_VERSION] seal employees)",
].join(" ");

function printScope(report: ScopeReport): void {
  console.log(["engine:", report.engineVersion ?? ""].join(" "));
  console.log(
    [
      "tables:",
      String(report.tables.length),
      "read,",
      String(report.tables.length - report.unexpectedTables.length),
      "in the shipped map,",
      String(report.unexpectedTables.length),
      "unexpected",
    ].join(" "),
  );
  console.log(["rows:", String(report.totalRows)].join(" "));
}

/** OD-16: the POS database's numbers with the question and no answer (contracts hazard 7), on its own connection. */
async function readMpos(dsn: string, args: CliArgs): Promise<MposDecisionReport> {
  const mposDriver = await connectOdbc(odbcOptions(dsn, args));
  try {
    const mposReader = await createReader(mposDriver, args.flags["firebird-version"]);
    const decision = { ...(await mposDecision(mposReader)), source: mposDriver.source };
    const range = decision.ticketDateRange;
    console.log(
      [
        "mpos:",
        decision.present ? "present," : "empty,",
        String(decision.tables.length),
        "tables,",
        String(decision.ticketRows),
        "ticket rows,",
        range ? [range.min ?? "", range.max ?? ""].join("..") : "no range",
      ].join(" "),
    );
    return decision;
  } finally {
    await mposDriver.close();
  }
}

/** Part VII #1: `profile.json` in §4.13.1's shape and `profile.csv` for a person. */
async function writeProfile(
  reader: LegacyReader,
  writer: ReportWriter,
  includeMpos: boolean,
): Promise<void> {
  const report = await profile(reader, { includeMpos });
  writer.json("profile.json", report, report.tables.length);
  writer.csv(
    "profile.csv",
    report.tables.map((t) => ({
      table: t.name,
      module: moduleOf(t.name)?.id ?? "",
      rows: t.rows,
      date_min: t.dateRange?.min ?? "",
      date_max: t.dateRange?.max ?? "",
    })),
  );
  const used = Object.entries(report.modulesInUse)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log(["tables:", String(report.tables.length)].join(" "));
  console.log(["modules in use:", used.join(", ") || "(none)"].join(" "));
}

/** §5.1 #1–#5 and #12: one JSON and one CSV per kind, and a summary line per kind — counts only, never a name. */
async function writeReconcile(
  reader: LegacyReader,
  writer: ReportWriter,
  kinds: readonly ReconciliationReport["kind"][],
): Promise<void> {
  for (const kind of kinds) {
    const report = await reconcile(reader, kind);
    writer.json([kind, "json"].join("."), report, report.rows.length);
    writer.csv([kind, "csv"].join("."), report.rows);
    console.log(
      [
        kind,
        ":",
        String(report.rows.length),
        "findings —",
        Object.entries(report.summary)
          .map(([k, v]) => [k, v].join("="))
          .join(" "),
      ].join(" "),
    );
  }
}

/** §5.1 #9: every definition blob as a hashed file, with `templates.json` and `templates.csv` beside them. */
async function writeTemplates(
  driver: LegacyDriver,
  writer: ReportWriter,
): Promise<TemplateCatalogue> {
  const catalogue = await catalogueTemplates(driver, writer);
  writer.json("templates.json", catalogue, catalogue.entries.length);
  writer.csv(
    "templates.csv",
    catalogue.entries.map((e) => ({
      name: e.name,
      owner: e.owner ?? "",
      group: e.group,
      customisation: e.customisation ? "yes" : "no",
      bytes: e.bytes,
      empty: e.empty ? "yes" : "no",
      near_duplicate_of: e.nearDuplicateOf ?? "",
      sha256: e.sha256,
      file: e.file,
    })),
  );
  console.log(
    [
      "templates:",
      String(catalogue.entries.length),
      "rows,",
      String(catalogue.entries.filter((e) => e.empty).length),
      "empty,",
      String(catalogue.entries.filter((e) => e.customisation).length),
      "customisations; the dossier ships",
      String(catalogue.shippedCountFromDossier),
    ].join(" "),
  );
  return catalogue;
}

/**
 * OD-27: `open-questions.json` and `open-questions.csv`, one CSV row per piece of evidence (one bare row for an
 * answer with none, so no question drops out of the sheet), each with an empty `verdict` column — the owner's.
 */
async function writeQuestions(
  reader: LegacyReader,
  driver: LegacyDriver,
  writer: ReportWriter,
): Promise<OpenQuestionReport> {
  const report = await answerOpenQuestions(reader, driver);
  writer.json("open-questions.json", report, report.answers.length);
  writer.csv(
    "open-questions.csv",
    report.answers.flatMap((a) => {
      const head = {
        id: a.id,
        spec_line: a.specLine,
        status: a.status,
        // Not `finding`: #6's evidence rows carry their own `finding`, which would overwrite the answer's.
        answer_finding: a.finding,
        owner_decision: a.ownerDecision,
        verdict: "",
      };
      return a.evidence.length === 0 ? [head] : a.evidence.map((e) => ({ ...head, ...e }));
    }),
  );
  for (const a of report.answers)
    console.log([a.id, a.status, "—", a.finding, "verdict: owner (OD-27)"].join(" "));
  return report;
}

/** `--tables accounts,VOUCHERS` → `["ACCOUNTS", "VOUCHERS"]`; Firebird catalogue names are upper-case. */
function tableList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
}

/**
 * 9B's `load`: the operator's local path to the same `runLoad` the `admin.import.run` job runs, as the tenant's SYSTEM
 * principal (spec:2179). The source is the one `--dsn`/`--fixture` names, injected through `setLoadSource`; the run id
 * is fresh, so its artefacts land under `artefacts/legacy/<runId>/` beside the job's. `--only` is the resume switch
 * (round 20 C14). Returns 0 for a clean load and 1 for a load with skips.
 */
async function runLoadCommand(args: CliArgs): Promise<number> {
  const tenantId = args.flags["tenant-id"];
  const companyId = args.flags["company-id"];
  const cutOverDate = args.flags["cut-over-date"];
  if (!tenantId || !companyId || !cutOverDate) {
    console.error(
      "config: load needs --tenant-id, --company-id and --cut-over-date (no default; spec:2039)",
    );
    return EXIT_CONFIG;
  }
  if (!boundForEnvSource(args, { tenantId, companyId })) return EXIT_CONFIG;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "config: load writes through DATABASE_URL (app_rw, session mode), which is unset",
    );
    return EXIT_CONFIG;
  }
  const only = args.flags.only
    ?.split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // The OWNER's chart mapping (9B plan N6). Read and validated before any connection is opened; required whenever the
  // run includes a loader that reads it, so a forgotten flag costs nothing rather than failing after units are loaded.
  const mapPath = args.flags["account-map"];
  if (mapPath) setAccountMap(readAccountMap(mapPath));
  else if (only === undefined || only.some((t) => READS_ACCOUNT_MAP.includes(t))) {
    console.error(
      [
        "config: load needs --account-map <path> (the OWNER's mapping from the legacy chart to Dulja's) unless --only leaves out",
        `${READS_ACCOUNT_MAP.slice(0, -1).join(", ")} and ${READS_ACCOUNT_MAP.at(-1)!}`,
      ].join(" "),
    );
    return EXIT_CONFIG;
  }
  // The HR key ring (9B T8), likewise before any connection: required whenever the run includes the employee load.
  if (only === undefined || only.some((t) => SEALS_SENSITIVE.includes(t))) {
    const ring = hrKeyRingFromEnv();
    if (typeof ring === "string") {
      clearAccountMap();
      console.error(ring);
      return EXIT_CONFIG;
    }
    setKeyRing(ring);
  }
  setLoadSource(async () => {
    const driver = await openDriver(args);
    try {
      return {
        driver,
        reader: await createReader(driver, args.flags["firebird-version"]),
        close: () => driver.close(),
      };
    } catch (cause) {
      await driver.close();
      throw cause;
    }
  });
  const conn = createDb(url);
  try {
    const runId = randomUUID();
    const ctx: LoadContext = {
      ...(await systemContext(conn, tenantId, runId)),
      companyId,
      runId,
      cutOverDate,
      dryRun: args.switches.has("dry-run"),
      ...(only === undefined ? {} : { only }),
    };
    const report = await runLoad(conn, ctx);
    console.log(
      JSON.stringify(
        { runId, dryRun: ctx.dryRun, perLoader: report.perLoader, skips: report.skips.length },
        null,
        2,
      ),
    );
    console.log(
      [
        "wrote:",
        String(report.artefacts.artefacts.length),
        "artefacts ->",
        join("artefacts", "legacy", runId),
      ].join(" "),
    );
    return report.skips.length === 0 ? 0 : EXIT_SKIPS;
  } finally {
    clearAccountMap();
    clearKeyRing();
    await conn.end();
  }
}

/**
 * 9B T10's `reconcile-cut-over`: Phase 9's definition of done, computed against the frozen source the load read (ADR
 * 0086). Reads only, as the tenant's SYSTEM principal; needs the same account map the load ran with. Writes
 * `cut-over-reconciliation.json` and `.csv` under `artefacts/legacy/<runId>/` with their sha256 in that directory's
 * `index.json` — a directory of its own, so the load's index is never overwritten — prints a summary and every
 * unexplained row, and returns 0 when nothing is unexplained and 4 otherwise. No pay figure is printed or written: the
 * YTD rows carry none (9B T8).
 */
async function reconcileCutOverCommand(args: CliArgs): Promise<number> {
  const tenantId = args.flags["tenant-id"];
  const companyId = args.flags["company-id"];
  const cutOverDate = args.flags["cut-over-date"];
  if (!tenantId || !companyId || !cutOverDate) {
    console.error(
      "config: reconcile-cut-over needs --tenant-id, --company-id and --cut-over-date (the load's own)",
    );
    return EXIT_CONFIG;
  }
  if (!boundForEnvSource(args, { tenantId, companyId })) return EXIT_CONFIG;
  const mapPath = args.flags["account-map"];
  if (!mapPath) {
    console.error(
      "config: reconcile-cut-over needs --account-map <path>, the same OWNER's mapping the load ran with",
    );
    return EXIT_CONFIG;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "config: reconcile-cut-over reads through DATABASE_URL (app_rw, session mode), which is unset",
    );
    return EXIT_CONFIG;
  }
  setAccountMap(readAccountMap(mapPath));
  let driver: LegacyDriver | undefined;
  const conn = createDb(url);
  try {
    driver = await openDriver(args);
    const reader = await createReader(driver, args.flags["firebird-version"]);
    const runId = randomUUID();
    const ctx: LoadContext = {
      ...(await systemContext(conn, tenantId, runId)),
      companyId,
      runId,
      cutOverDate,
      dryRun: true,
    };
    const result = await withTenant(conn, ctx, (tx) => reconcileCutOver(tx, reader, ctx));
    const out = join("artefacts", "legacy", runId);
    const writer = new ReportWriter(out, {
      source: driver.source,
      engineVersion: reader.firebirdVersion,
    });
    const sections = [
      ["trial_balance", result.trialBalance],
      ["stock_valuation", result.stockValuation],
      ["employee_ytd", result.employeeYtd],
      ["suspense", result.suspense],
    ] as const;
    const flat = sections.flatMap(([section, rows]) =>
      rows.map((r: Comparison) => ({
        section,
        ...r,
        explained: result.unexplained.includes(r) ? "no" : "yes",
      })),
    );
    writer.json("cut-over-reconciliation.json", result, flat.length);
    writer.csv("cut-over-reconciliation.csv", flat);
    writer.finish();
    console.log(
      [
        "cut-over",
        cutOverDate,
        "—",
        String(result.trialBalance.length),
        "trial-balance rows,",
        String(result.stockValuation.length),
        "stock rows,",
        String(result.employeeYtd.length),
        "employees;",
        "3900 =",
        result.suspenseBalance,
        "(debit-positive);",
        String(result.unexplained.length),
        "unexplained",
      ].join(" "),
    );
    for (const r of result.unexplained)
      console.log(["unexplained:", r.key, "—", r.label, "— difference", r.difference].join(" "));
    console.log(["wrote: cut-over-reconciliation.json, .csv ->", out].join(" "));
    return result.ok ? 0 : EXIT_UNEXPLAINED;
  } finally {
    clearAccountMap();
    if (driver) await driver.close();
    await conn.end();
  }
}

/**
 * The one CLI (contracts §3.2). Artefacts are customer data and land under `artefacts/` (git-ignored, plan 9A
 * assumption 14), relative to the directory the command runs in — the repository root for `bun run legacy`.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    console.error(USAGE);
    return EXIT_CONFIG;
  }
  if (args.command === "help" || args.switches.has("help")) {
    console.log(USAGE);
    return 0;
  }
  const refused = checkArgs(args);
  if (refused !== null) {
    console.error(refused);
    console.error(USAGE);
    return EXIT_CONFIG;
  }
  const out = args.flags.out ?? join("artefacts", "legacy", new Date().toISOString().slice(0, 10));
  // `openDriver` is called INSIDE the try, so a bad --fixture name, a missing --dsn or an unreachable DSN
  // becomes an exit code and not an unhandled rejection; `opened` is what the `finally` closes.
  let opened: LegacyDriver | undefined;
  try {
    if (!COMMANDS.has(args.command)) {
      console.error(["config: unknown command", args.command].join(" "));
      console.error(USAGE);
      return EXIT_CONFIG;
    }
    const kinds = reconcileKinds(args.flags.kind ?? "all");
    if (args.command === "reconcile" && kinds === null) {
      console.error(
        [
          "config: unknown --kind",
          args.flags.kind ?? "",
          "— expected all or one of",
          RECONCILIATION_KINDS.join(", "),
        ].join(" "),
      );
      return EXIT_CONFIG;
    }
    // `load` opens its own source inside `runLoad`, which closes it; it shares nothing below.
    if (args.command === "load") return await runLoadCommand(args);
    if (args.command === "reconcile-cut-over") return await reconcileCutOverCommand(args);
    // Checked before any source is opened, so a missing variable costs no connection.
    const mpos = mposDsn(args);
    const driver = await openDriver(args);
    opened = driver;

    if (args.command === "scope") {
      const report = await scope(driver);
      if (report.engineVersion === null) {
        console.error(
          "config: the engine did not answer ENGINE_VERSION; pass --firebird-version <string> (OD-17, ADR 0081)",
        );
        return EXIT_CONFIG;
      }
      printScope(report);
      console.log(["wrote:", writeJson(out, "scope.json", report)].join(" "));
      if (mpos === null) {
        console.log("mpos: not read (OD-16 default: start clean)");
        return 0;
      }
      console.log(
        ["wrote:", writeJson(out, "mpos-decision.json", await readMpos(mpos, args))].join(" "),
      );
      return 0;
    }

    const reader = await createReader(driver, args.flags["firebird-version"]);
    const writer = new ReportWriter(out, {
      source: driver.source,
      engineVersion: reader.firebirdVersion,
    });

    if (args.command === "snapshot") {
      const only = tableList(args.flags.tables);
      const result = await snapshot(driver, writer, only === undefined ? {} : { tables: only });
      const index = writer.finish();
      console.log(
        [
          "snapshot:",
          String(result.tables.length),
          "tables,",
          String(result.tables.reduce((a, t) => a + t.rows, 0)),
          "rows,",
          String(result.pseudonymisedColumns),
          "columns pseudonymised,",
          String(result.omittedColumns),
          "omitted",
        ].join(" "),
      );
      console.log(
        "salt: generated per run and not written — a pseudonym here cannot be reversed (ADR 0083)",
      );
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      return 0;
    }

    if (args.command === "all") {
      // The five report commands in the runbook's order, into one run directory and one index. `snapshot` is
      // deliberately not among them: it produces pseudonymised customer data for staging, a separate decision
      // from "profile and reconcile the source", and spec:2272 puts it in a different environment's path.
      const scopeReport = await scope(driver);
      writer.json("scope.json", scopeReport, scopeReport.tables.length);
      printScope(scopeReport);
      await writeProfile(reader, writer, args.switches.has("include-mpos"));
      await writeReconcile(reader, writer, RECONCILIATION_KINDS);
      const located = await locateTemplates(driver);
      if ("refused" in located) console.log(["templates: skipped —", located.refused].join(" "));
      else await writeTemplates(driver, writer);
      await writeQuestions(reader, driver, writer);
      if (mpos === null) console.log("mpos: not read (OD-16 default: start clean)");
      else {
        const decision = await readMpos(mpos, args);
        writer.json("mpos-decision.json", decision, decision.tables.length);
      }
      const index = writer.finish();
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      console.log(
        "next: the owner reads reconciliation and open-questions, and answers OD-16, OD-25 and OD-27",
      );
      return 0;
    }

    if (args.command === "reconcile" && kinds !== null) await writeReconcile(reader, writer, kinds);
    else if (args.command === "profile") {
      console.log(["engine:", reader.firebirdVersion].join(" "));
      await writeProfile(reader, writer, args.switches.has("include-mpos"));
    } else if (args.command === "templates") {
      // A blob per template: the count, not the list, is what a person can read here.
      await writeTemplates(driver, writer);
      const index = writer.finish();
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      return 0;
    } else await writeQuestions(reader, driver, writer);
    const index = writer.finish();
    console.log(["wrote:", index.artefacts.map((a) => a.name).join(", "), "->", out].join(" "));
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(message);
    return message.startsWith("ERR_IMPORT_SOURCE_UNREADABLE") ? EXIT_UNREADABLE : EXIT_CONFIG;
  } finally {
    if (opened) await opened.close();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

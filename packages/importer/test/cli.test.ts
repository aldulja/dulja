import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtefactIndex } from "../src/artefacts";
import { main, parseArgs } from "../src/cli";
import { accountMap } from "../src/load/accounts";

const out = () => mkdtempSync(join(tmpdir(), "dulja-9a-cli-"));

/** Everything `main` printed, both streams, as one string. */
const printed = (...spies: { mock: { calls: unknown[][] } }[]): string =>
  spies.flatMap((s) => s.mock.calls.map((call) => call.map(String).join(" "))).join("\n");

const ENV_NAMES = [
  "LEGACY_ODBC_DSN",
  "LEGACY_MPOS_DSN",
  "DATABASE_URL",
  "HR_FIELD_ENCRYPTION_KEY",
  "HR_FIELD_ENCRYPTION_KEY_VERSION",
  "LEGACY_IMPORT_TARGET",
] as const;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string>> = {};

beforeEach(() => {
  // The runbook's variables must not leak in from the shell that runs the suite.
  for (const name of ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) saved[name] = value;
    delete process.env[name];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ENV_NAMES) {
    delete process.env[name];
    const value = saved[name];
    if (value !== undefined) process.env[name] = value;
  }
});

describe("parseArgs", () => {
  it("separates flags from switches and defaults the command to help", () => {
    expect(parseArgs([])).toEqual({ command: "help", flags: {}, switches: new Set() });
    expect(parseArgs(["scope", "--fixture", "base", "--include-mpos", "--out", "x"])).toEqual({
      command: "scope",
      flags: { fixture: "base", out: "x" },
      switches: new Set(["include-mpos"]),
    });
  });

  it("treats a flag followed by another flag as a switch, not as a flag with a flag-shaped value", () => {
    expect(parseArgs(["scope", "--include-mpos", "--fixture", "base"]).flags).toEqual({
      fixture: "base",
    });
  });

  it("refuses the --key=value form, a stray word, a key given twice and an empty value (2026-11-15 review, HRP-05/06)", () => {
    expect(() => parseArgs(["load", "--dry-run=true"])).toThrow(
      /^config: write --dry-run as its own word/,
    );
    expect(() => parseArgs(["load", "--only=account"])).toThrow(
      /^config: write --only as its own word/,
    );
    expect(() => parseArgs(["load", "dry-run"])).toThrow(/^config: unexpected argument "dry-run"/);
    expect(() => parseArgs(["load", "--"])).toThrow(/^config: unexpected argument/);
    expect(() => parseArgs(["load", "--only", "a", "--only", "b"])).toThrow(
      /--only is given twice/,
    );
    expect(() => parseArgs(["load", "--fixture", ""])).toThrow(/--fixture is given an empty value/);
    expect(() => parseArgs(["load", "--dsn", "  "])).toThrow(/--dsn is given an empty value/);
  });
});

describe("main — options a command does not read are refused before anything is opened (2026-11-15 review, HRP-05/06)", () => {
  const TENANT = "01930000-0000-7000-8000-000000000001";
  const COMPANY = "01930000-0000-7000-8000-000000000002";
  const target = ["--tenant-id", TENANT, "--company-id", COMPANY, "--cut-over-date", "2026-01-31"];

  it.each([
    [
      ["load", "--fixture", "cut-over", ...target, "--dry-run=true"],
      /^config: write --dry-run as its own word/,
    ],
    [
      ["load", "--fixture", "cut-over", ...target, "--dry-run", "true"],
      /^config: --dry-run takes no value/,
    ],
    [
      ["load", "--fixture", "cut-over", ...target, "--dryrun"],
      /^config: load does not accept --dryrun/,
    ],
    [["load", "--fixture", "cut-over", ...target, "--only"], /^config: --only needs a value/],
    [
      ["load", "--fixture", "cut-over", ...target, "--out", "x"],
      /^config: load does not accept --out/,
    ],
    [
      ["reconcile-cut-over", "--fixture", "cut-over", ...target, "--dry-run"],
      /^config: reconcile-cut-over does not accept --dry-run/,
    ],
    [["scope", "--fixture", "base", "--only", "account"], /^config: scope does not accept --only/],
  ])("returns 2 for %j", async (argv, message) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // A database the run would reach if the option were ignored; it is never opened.
    process.env["DATABASE_URL"] = "postgres://nobody:nothing@127.0.0.1:1/none";
    expect(await main(argv)).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toMatch(message);
  });

  it("an empty --fixture is no named source: LEGACY_IMPORT_TARGET still binds the configured one, which is never opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env["LEGACY_ODBC_DSN"] = "DSN=dulja-test-no-such-source;UID=reader;PWD=s3cret-value";
    process.env["LEGACY_IMPORT_TARGET"] = `${TENANT}:01930000-0000-7000-8000-0000000000ff`;
    process.env["DATABASE_URL"] = "postgres://nobody:nothing@127.0.0.1:1/none";
    for (const command of ["load", "reconcile-cut-over"]) {
      const code = await main([
        command,
        "--fixture",
        "",
        ...target,
        "--account-map",
        "test/fixtures/account-map.json",
      ]);
      expect(code).toBe(2);
    }
    expect(printed(error)).not.toMatch(/ERR_IMPORT_SOURCE_UNREADABLE|native binding|s3cret/);
    expect(printed(error)).toMatch(/--fixture is given an empty value/);
  });
});

describe("main — exit codes are the contract the runbook relies on", () => {
  it("returns 0 for help and prints every command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["help"])).toBe(0);
    const usage = String(log.mock.calls[0]?.[0]);
    for (const command of [
      "scope",
      "profile",
      "reconcile",
      "templates",
      "questions",
      "snapshot",
      "all",
      "load",
      "reconcile-cut-over",
    ]) {
      expect(usage).toContain(command);
    }
    expect(usage).toContain("--cut-over-date");
    expect(usage).toContain("--mpos");
    expect(usage).toContain("--tables");
  });

  it("returns 0 for a full run against the corpus, writes every report, and prints no customer name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = out();
    expect(await main(["all", "--fixture", "base", "--out", dir])).toBe(0);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as ArtefactIndex;
    const names = index.artefacts.map((a) => a.name);
    for (const name of [
      "scope.json",
      "profile.json",
      "profile.csv",
      "aggregate_drift.csv",
      "employee_mapping.csv",
      "templates.json",
      "templates.csv",
      "templates/AccMovement.report",
      "open-questions.json",
      "open-questions.csv",
      "index.json",
    ])
      expect(names).toContain(name);
    // `all` is the report run; the staging snapshot is a separate decision (spec:2272) and never part of it.
    expect(names.some((n) => n.startsWith("snapshot"))).toBe(false);
    expect(names).toHaveLength(24);
    const text = printed(log);
    expect(text).toContain("engine: WI-V2.5.9.27139 Firebird 2.5");
    expect(text).toContain("mpos: not read (OD-16 default: start clean)");
    expect(text).toContain(
      "next: the owner reads reconciliation and open-questions, and answers OD-16, OD-25 and OD-27",
    );
    for (const name of ["Ali Hassan", "Siti Nurhaliza", "Cash"]) expect(text).not.toContain(name);
  });

  it("skips the template catalogue in `all`, saying why, when the source has no REPORTS table", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = out();
    expect(await main(["all", "--fixture", "mpos", "--out", dir])).toBe(0);
    expect(printed(log)).toContain(
      "templates: skipped — REPORTS is not a table of this source; report definitions cannot be extracted",
    );
  });

  it("writes the OD-27 sheet with an empty verdict on every row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = out();
    expect(await main(["questions", "--fixture", "questions", "--out", dir])).toBe(0);
    const [header = "", ...rows] = readFileSync(join(dir, "open-questions.csv"), "utf8")
      .replace(/^﻿/, "")
      .trimEnd()
      .split("\r\n");
    const columns = header.split(",");
    expect(columns.slice(0, 6)).toEqual([
      "id",
      "spec_line",
      "status",
      "answer_finding",
      "owner_decision",
      "verdict",
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(row).toMatch(/,OD-27,,/);
  });

  it("writes the snapshot apart from `all`, and prints its counts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = out();
    expect(
      await main(["snapshot", "--fixture", "base", "--tables", "accounts,VOUCHERS", "--out", dir]),
    ).toBe(0);
    expect(printed(log)).toContain(
      "snapshot: 2 tables, 7 rows, 1 columns pseudonymised, 0 omitted",
    );
    expect(printed(log)).toContain(
      "salt: generated per run and not written — a pseudonym here cannot be reversed (ADR 0083)",
    );
    expect(printed(log)).toContain(["wrote: 5 artefacts ->", dir].join(" "));
  });

  it("returns 2 for an unknown command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["migrate", "--fixture", "base", "--out", out()])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("config: unknown command migrate");
  });

  it("returns 2 for an unknown reconciliation kind and names the six that exist", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await main(["reconcile", "--kind", "employees", "--fixture", "base", "--out", out()]),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("expected all or one of aggregate_drift");
  });

  it("returns 2 for a --fixture name that is not on disk, from either working directory", async () => {
    // The corpus path is resolved from `import.meta.url` and `openDriver` is called inside `main`'s try, so
    // the ENOENT is a return value even though this suite runs with cwd = packages/importer.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["scope", "--fixture", "nosuchcorpus", "--out", out()])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("nosuchcorpus");
  });

  it("returns 2 when no source is named at all", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["profile", "--out", out()])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("LEGACY_ODBC_DSN");
  });

  it("returns 2 for --mpos when LEGACY_MPOS_DSN is unset, before any source is opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["scope", "--fixture", "base", "--mpos", "--out", out()])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "config: --mpos reads the POS database's DSN from LEGACY_MPOS_DSN, which is unset (OD-16)",
    );
  });

  it("reads the POS DSN from LEGACY_MPOS_DSN under --mpos, and never prints its password", async () => {
    // With no native `odbc` binding the connection is refused (3); with one, the DSN names no data source (3).
    process.env.LEGACY_MPOS_DSN = "DSN=dulja-test-no-such-source;UID=reader;PWD=s3cret-value";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["scope", "--fixture", "base", "--mpos", "--out", out()])).toBe(3);
    expect(printed(error)).toMatch(/^ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(printed(log, error)).not.toContain("s3cret-value");
  });

  it("does not read the POS database merely because LEGACY_MPOS_DSN is set (OD-16's default)", async () => {
    process.env.LEGACY_MPOS_DSN = "DSN=dulja-test-no-such-source";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["scope", "--fixture", "base", "--out", out()])).toBe(0);
    expect(printed(log)).toContain("mpos: not read (OD-16 default: start clean)");
  });

  it("returns 3 when the source cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await main(["snapshot", "--fixture", "base", "--tables", "NOSUCHTABLE", "--out", out()]),
    ).toBe(3);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "ERR_IMPORT_SOURCE_UNREADABLE: NOSUCHTABLE is not a table of this source",
    );
  });
});

describe("main load — 9B's operator path to runLoad (its database half is in test/load/run.test.ts)", () => {
  const TENANT = "01930000-0000-7000-8000-000000000001";
  const COMPANY = "01930000-0000-7000-8000-000000000002";

  it("returns 2 when the tenant, the company or the cut-over date is missing — the date has no default", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      await main(["load", "--fixture", "cut-over", "--tenant-id", TENANT, "--company-id", COMPANY]),
    ).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "config: load needs --tenant-id, --company-id and --cut-over-date (no default; spec:2039)",
    );
  });

  it("returns 2 when the DSN comes from LEGACY_ODBC_DSN and LEGACY_IMPORT_TARGET binds it to another company, or to none (9B review, finding 1)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env["LEGACY_ODBC_DSN"] = "DSN=dulja-test-no-such-source;UID=reader;PWD=s3cret-value";
    const args = ["--tenant-id", TENANT, "--company-id", COMPANY, "--cut-over-date", "2026-01-31"];
    expect(await main(["load", ...args])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toMatch(
      /^config: ERR_IMPORT_SOURCE_NOT_BOUND: LEGACY_IMPORT_TARGET is not set;/,
    );
    process.env["LEGACY_IMPORT_TARGET"] = `${TENANT}:01930000-0000-7000-8000-0000000000ff`;
    expect(await main(["load", ...args])).toBe(2);
    expect(await main(["reconcile-cut-over", ...args, "--account-map", "x.json"])).toBe(2);
    for (const call of error.mock.calls.slice(1))
      expect(String(call[0])).toMatch(
        /^config: ERR_IMPORT_SOURCE_NOT_BOUND: the configured legacy source is bound to another tenant or company/,
      );
    expect(printed(error)).not.toMatch(/s3cret|0000000000ff/);
    // Bound to this company, the load goes on to its next check (DATABASE_URL); an explicit --fixture needs no binding.
    process.env["LEGACY_IMPORT_TARGET"] = `${TENANT}:${COMPANY}`;
    expect(await main(["load", ...args])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toBe(
      "config: load writes through DATABASE_URL (app_rw, session mode), which is unset",
    );
    delete process.env["LEGACY_IMPORT_TARGET"];
    expect(await main(["load", "--fixture", "cut-over", ...args])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toBe(
      "config: load writes through DATABASE_URL (app_rw, session mode), which is unset",
    );
  });

  it("returns 2 when DATABASE_URL is unset, before any source or connection is opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const args = ["--tenant-id", TENANT, "--company-id", COMPANY, "--cut-over-date", "2026-01-31"];
    expect(await main(["load", "--fixture", "cut-over", ...args])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "config: load writes through DATABASE_URL (app_rw, session mode), which is unset",
    );
  });

  it("returns 2 without the owner's account map when the run includes the account loader, before any connection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const savedUrl = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/none";
    try {
      const args = [
        "--tenant-id",
        TENANT,
        "--company-id",
        COMPANY,
        "--cut-over-date",
        "2026-01-31",
      ];
      expect(await main(["load", "--fixture", "cut-over", ...args])).toBe(2);
      expect(String(error.mock.calls[0]?.[0])).toBe(
        "config: load needs --account-map <path> (the OWNER's mapping from the legacy chart to Dulja's) unless --only leaves out account, opening_balance and open_item",
      );
      // The trial-balance opening reads the map's treatments too (Task 5), so `--only opening_balance` needs it.
      expect(
        await main(["load", "--fixture", "cut-over", ...args, "--only", "opening_balance"]),
      ).toBe(2);
      expect(String(error.mock.calls[1]?.[0])).toMatch(
        /unless --only leaves out account, opening_balance and open_item$/,
      );
      // So do the open items, which post to the map's ar_control/ap_control (Task 7).
      expect(await main(["load", "--fixture", "cut-over", ...args, "--only", "open_item"])).toBe(2);
      expect(
        await main(["load", "--fixture", "cut-over", ...args, "--account-map", "no/such/map.json"]),
      ).toBe(2);
      expect(String(error.mock.calls[3]?.[0])).toMatch(
        /^ERR_VALIDATION_FAILED: no\/such\/map\.json: the account map could not be read/,
      );
    } finally {
      if (savedUrl === undefined) delete process.env["DATABASE_URL"];
      else process.env["DATABASE_URL"] = savedUrl;
    }
  });

  it("returns 2 without a usable HR_FIELD_ENCRYPTION_KEY when the run includes the employee loader, naming the variable and never its value (9B T8)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The suite's beforeEach/afterEach save, clear and restore every variable named here (ENV_NAMES).
    process.env["DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/none";
    const args = [
      "--fixture",
      "cut-over",
      "--tenant-id",
      TENANT,
      "--company-id",
      COMPANY,
      "--cut-over-date",
      "2026-01-31",
      "--account-map",
      "test/fixtures/account-map.json",
    ];
    expect(await main(["load", ...args])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "config: load needs HR_FIELD_ENCRYPTION_KEY (the key the tenant's api and worker run with, and HR_FIELD_ENCRYPTION_KEY_VERSION beside it) unless --only leaves out employee: an employee's sensitive fields are sealed under it (§4.12.5)",
    );
    // The account map read before the refusal is not left behind for the next run in this process.
    expect(() => accountMap()).toThrow("no account map has been set");

    process.env["HR_FIELD_ENCRYPTION_KEY"] = "not-a-key";
    expect(await main(["load", ...args, "--only", "employee"])).toBe(2);
    expect(String(error.mock.calls[1]?.[0])).toBe(
      "config: HR_FIELD_ENCRYPTION_KEY is not valid base64 (§3.11, 8A amendment A8)",
    );
    expect(String(error.mock.calls[1]?.[0])).not.toContain("not-a-key");

    process.env["HR_FIELD_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    process.env["HR_FIELD_ENCRYPTION_KEY_VERSION"] = "0";
    expect(await main(["load", ...args, "--only", "employee"])).toBe(2);
    expect(String(error.mock.calls[2]?.[0])).toBe(
      "config: HR_FIELD_ENCRYPTION_KEY_VERSION must be an integer between 1 and 255",
    );
  });
});

describe("main reconcile-cut-over — 9B T10's computed definition of done (its database half is in test/load/reconcile-cut-over.test.ts)", () => {
  const TENANT = "01930000-0000-7000-8000-000000000001";
  const COMPANY = "01930000-0000-7000-8000-000000000002";
  const ARGS = ["--tenant-id", TENANT, "--company-id", COMPANY, "--cut-over-date", "2026-01-31"];

  it("returns 2 — never 4 — for a configuration mistake, before any source or connection is opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["reconcile-cut-over", "--fixture", "cut-over", "--tenant-id", TENANT])).toBe(
      2,
    );
    expect(String(error.mock.calls[0]?.[0])).toBe(
      "config: reconcile-cut-over needs --tenant-id, --company-id and --cut-over-date (the load's own)",
    );
    expect(await main(["reconcile-cut-over", "--fixture", "cut-over", ...ARGS])).toBe(2);
    expect(String(error.mock.calls[1]?.[0])).toBe(
      "config: reconcile-cut-over needs --account-map <path>, the same OWNER's mapping the load ran with",
    );
    const withMap = [...ARGS, "--account-map", "test/fixtures/account-map.json"];
    expect(await main(["reconcile-cut-over", "--fixture", "cut-over", ...withMap])).toBe(2);
    expect(String(error.mock.calls[2]?.[0])).toBe(
      "config: reconcile-cut-over reads through DATABASE_URL (app_rw, session mode), which is unset",
    );
    // Nothing was read, so nothing is left behind for the next command in this process.
    expect(() => accountMap()).toThrow("no account map has been set");
  });
});

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appEnvWarning, parseSeedArgs, SeedConfigError } from "../src/seed/config";
import { assertPackShape, readPackFile, PHASE_0_SUB_PACK_DIRECTORIES } from "../src/seed/packs";
import { SUB_PACKS, SeedError } from "../src/seed";

const TENANT = "01927f3a-0000-7000-8000-000000000001";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const base = ["--tenant", TENANT];
const env = {
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb-key",
} as NodeJS.ProcessEnv;

function pack(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "dulja-pack-"));
  for (const d of dirs) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "x.json"), "[]");
  }
  return root;
}

describe("packages/db/src/seed — the CLI seam (spec §3.8 bootstrap; contracts §3.4.8)", () => {
  it("SUB_PACKS is application order, not alphabetical: roles before the rows that reference them", () => {
    expect(SUB_PACKS).toEqual([
      "roles",
      "dimensions",
      "fiscal-periods",
      "chart-of-accounts",
      "document-types",
      "templates",
      "tax",
      "reports",
      "statutory",
    ]);
  });

  it("--tenant is required — the CLI never invents a tenant id", () => {
    expect(() => parseSeedArgs([], env)).toThrow(SeedConfigError);
    expect(() => parseSeedArgs([], env)).toThrow(/--tenant <uuid> is required/);
    expect(() => parseSeedArgs(["--tenant", "not-a-uuid"], env)).toThrow(/--tenant must be a uuid/);
  });

  it("--only accepts a known sub-pack, repeats, and rejects an unknown one by name", () => {
    expect(parseSeedArgs([...base, "--only", "roles"], env).only).toEqual(["roles"]);
    expect(
      parseSeedArgs([...base, "--only", "roles", "--only", "chart-of-accounts"], env).only,
    ).toEqual(["roles", "chart-of-accounts"]);
    // `document-types` is a known sub-pack from 1A onward, `reports` from 7A and `statutory` from 8A, so the
    // unknown-name case picks a name no slice registers.
    expect(parseSeedArgs([...base, "--only", "document-types"], env).only).toEqual([
      "document-types",
    ]);
    expect(parseSeedArgs([...base, "--only", "tax"], env).only).toEqual(["tax"]);
    expect(parseSeedArgs([...base, "--only", "reports"], env).only).toEqual(["reports"]);
    expect(parseSeedArgs([...base, "--only", "statutory"], env).only).toEqual(["statutory"]);
    expect(() => parseSeedArgs([...base, "--only", "payroll"], env)).toThrow(
      /unknown sub-pack 'payroll' — expected one of roles, dimensions, fiscal-periods, chart-of-accounts, document-types, templates, tax, reports, statutory/,
    );
    expect(parseSeedArgs(base, env).only).toBeNull();
  });

  it("the OD-21 values default to fixtures and are overridden by flags", () => {
    const d = parseSeedArgs(base, env);
    expect(d.companyName).toBe("Dulja Test Company Sdn Bhd");
    expect(d.baseCurrency).toBe("MYR");
    expect(d.timezone).toBe("Asia/Kuala_Lumpur");
    expect(d.fiscalYearStartMonth).toBe(1);
    const o = parseSeedArgs(
      [
        ...base,
        "--company-name",
        "Real Sdn Bhd",
        "--owner-email",
        "owner@real.my",
        "--fiscal-year-start",
        "4",
      ],
      env,
    );
    expect(o.companyName).toBe("Real Sdn Bhd");
    expect(o.ownerEmail).toBe("owner@real.my");
    expect(o.fiscalYearStartMonth).toBe(4);
  });

  it("APP_ENV is read like the API reads it: unset is dev, the three names pass, anything else is refused", () => {
    // PR 11 review, round 3: the tax loader keeps a synthetic regime out of a production company, so the
    // seed must know where it runs — and a misspelt APP_ENV must not fall through to the dev behaviour.
    expect(parseSeedArgs(base, env).appEnv).toBe("dev");
    // The real owner and company, which a full seed outside dev requires since DBS-17.
    const stated = [...base, "--owner-email", "owner@real.my", "--company-name", "Real Sdn Bhd"];
    for (const appEnv of ["dev", "staging", "production"] as const) {
      expect(parseSeedArgs(stated, { ...env, APP_ENV: appEnv }).appEnv).toBe(appEnv);
    }
    for (const bad of ["prod", "Production", ""]) {
      expect(() => parseSeedArgs(base, { ...env, APP_ENV: bad })).toThrow(SeedConfigError);
      expect(() => parseSeedArgs(base, { ...env, APP_ENV: bad })).toThrow(
        /APP_ENV must be dev, staging or production/,
      );
    }
  });

  it("an unset APP_ENV is announced: the seed says it ran as dev and loaded synthetic regimes", () => {
    // PR 11 review, round 3, adversarial pass: unset is dev, the seed is an offline CLI that never reads the
    // container's APP_ENV, and a production reseed run without the variable loaded SYNTH-MY-v1 silently.
    // `parseSeedArgs` cannot tell a defaulted dev from a stated one, so the CLI asks the raw environment.
    expect(appEnvWarning({})).toMatch(
      /^APP_ENV is not set — seeding as dev, which loads synthetic tax regimes .*APP_ENV=production/,
    );
    for (const appEnv of ["dev", "staging", "production"]) {
      expect(appEnvWarning({ APP_ENV: appEnv })).toBeUndefined();
    }
  });

  it("the CLI prints that warning when APP_ENV is unset, and not when it is stated", () => {
    // Nothing listens on port 1, so the seed itself fails (exit 1, a seed failure) after the warnings — no
    // database is needed to see what the CLI says before it connects. The Supabase variables are removed, as
    // 4B's re-seed test removes them, so the stub's own warning is printed beside ours either way.
    const cli = (appEnv: string | undefined) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL_MIGRATOR: "postgres://app_migrator:unused@127.0.0.1:1/dulja",
      };
      delete childEnv["APP_ENV"];
      delete childEnv["SUPABASE_URL"];
      delete childEnv["SUPABASE_SERVICE_ROLE_KEY"];
      if (appEnv !== undefined) childEnv["APP_ENV"] = appEnv;
      // `--only roles`: since DBS-17 a full production seed is refused (exit 2) before it warns about
      // anything, without --owner-email, --company-name and the Supabase variables; a re-apply is not.
      return spawnSync("bun", ["run", "seed", "--", "--tenant", TENANT, "--only", "roles"], {
        cwd: PACKAGE_DIR,
        env: childEnv,
        encoding: "utf8",
        timeout: 60_000,
        // As 4B's re-seed test: `bun` is a `.cmd` shim on some Windows machines and only the shell finds it.
        // Every argument is a literal.
        shell: process.platform === "win32",
      });
    };
    const unset = cli(undefined);
    expect(unset.status, unset.stderr).toBe(1);
    expect(unset.stderr).toContain("APP_ENV is not set — seeding as dev");
    const stated = cli("production");
    expect(stated.status, stated.stderr).toBe(1);
    expect(stated.stderr).not.toContain("APP_ENV is not set");
  }, 120_000);

  it("a fiscal-year start outside 1–12 is a configuration error, not a silent modulo", () => {
    expect(() => parseSeedArgs([...base, "--fiscal-year-start", "13"], env)).toThrow(
      /--fiscal-year-start must be 1–12/,
    );
    expect(() => parseSeedArgs([...base, "--fiscal-year-start", "0"], env)).toThrow(
      /--fiscal-year-start must be 1–12/,
    );
  });

  it("assertPackShape accepts exactly the expected sub-packs and names any extra (§2.1 0C card)", () => {
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toEqual([
      "chart-of-accounts",
      "dimensions",
      "fiscal-periods",
      "document-types",
      "templates",
      "tax",
      "reports",
      "statutory",
    ]);
    // A pack holding exactly the required set is legal — both shipped loaders' directories are in it.
    expect(() => assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES))).not.toThrow();
    expect(() => assertPackShape(pack(["chart-of-accounts", "dimensions"]))).toThrow(
      /missing sub-pack: fiscal-periods/,
    );
    // REQUIRED-presence, not merely allowed (§4.2.13): a pack without `templates/` is a shape violation.
    expect(() =>
      assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES.filter((d) => d !== "templates"))),
    ).toThrow(/missing sub-pack: templates/);
    // 7A shipped the `reports` loader and 8A `statutory`, so both directories are required.
    expect(() =>
      assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES.filter((d) => d !== "reports"))),
    ).toThrow(/missing sub-pack: reports/);
    expect(() =>
      assertPackShape(pack(PHASE_0_SUB_PACK_DIRECTORIES.filter((d) => d !== "statutory"))),
    ).toThrow(/missing sub-pack: statutory/);
    expect(() => assertPackShape(pack([...PHASE_0_SUB_PACK_DIRECTORIES, "payroll"]))).toThrow(
      /unexpected sub-pack: payroll — the known sub-packs are /,
    );
  });

  it("readPackFile names the file when the JSON is bad", () => {
    const root = mkdtempSync(join(tmpdir(), "dulja-pack-"));
    mkdirSync(join(root, "chart-of-accounts"), { recursive: true });
    writeFileSync(join(root, "chart-of-accounts", "0c-base.json"), "{ not json");
    expect(() => readPackFile(root, "chart-of-accounts", "0c-base.json")).toThrow(SeedError);
    expect(() => readPackFile(root, "chart-of-accounts", "0c-base.json")).toThrow(
      /chart-of-accounts\/0c-base\.json/,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

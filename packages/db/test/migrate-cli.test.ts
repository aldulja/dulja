import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discover, listApplied } from "../src/migrate";
import { MIGRATIONS_DIR, startDb, type Db } from "./harness";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * DBS-05 (2026-11-15 full review): `db:rollback` with no argument — or `latest`, `v120`, `-1` — became
 * `Number(undefined ?? 0)` or `NaN`, and `version <= NaN` is never true, so the CLI ran every down file in the
 * tree. The rollback CLI now needs an explicit integer target, and outside `dev` a flag naming the environment.
 */
describe("db:rollback refuses an implicit or unparseable target (DBS-05)", () => {
  let db: Db;
  let everything: number[];

  beforeAll(async () => {
    db = await startDb();
    everything = discover(MIGRATIONS_DIR).map((migration) => migration.version);
  });
  afterAll(async () => {
    await db.stop();
  });

  const rollback = (args: readonly string[], appEnv?: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL_MIGRATOR: db.url("app_migrator"),
    };
    delete env["APP_ENV"];
    if (appEnv !== undefined) env["APP_ENV"] = appEnv;
    const run = spawnSync("bun", ["run", "src/cli.ts", "down", ...args], {
      cwd: PACKAGE_DIR,
      env,
      encoding: "utf8",
      timeout: 120_000,
      // As the seed CLI tests: `bun` is a `.cmd` shim on some Windows machines. Every argument is a literal.
      shell: process.platform === "win32",
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };

  it.each([[[]], [["latest"]], [["v120"]], [["-1"]], [["1.5"]], [[""]], [["12", "13"]]])(
    "down %j exits 2 and rolls nothing back",
    async (args) => {
      const run = rollback(args);
      expect(run.status, run.stderr).toBe(2);
      expect(run.stderr).toMatch(/explicit target version/);
      expect(await listApplied(db.migrator)).toEqual(everything);
    },
    120_000,
  );

  it.each([["staging"], ["production"]])(
    "APP_ENV=%s refuses a rollback without --force-<env>, and a flag naming the other environment",
    async (appEnv) => {
      const top = String(everything.at(-1));
      const bare = rollback([top], appEnv);
      expect(bare.status, bare.stderr).toBe(2);
      expect(bare.stderr).toContain(`--force-${appEnv}`);
      const other = appEnv === "staging" ? "production" : "staging";
      const wrong = rollback([top, `--force-${other}`], appEnv);
      expect(wrong.status, wrong.stderr).toBe(2);
      expect(await listApplied(db.migrator)).toEqual(everything);

      // Confirmed, to the newest version: a no-op that proves the flag is accepted.
      const confirmed = rollback([top, `--force-${appEnv}`], appEnv);
      expect(confirmed.status, confirmed.stderr).toBe(0);
      expect(await listApplied(db.migrator)).toEqual(everything);
    },
    240_000,
  );

  it("an unknown APP_ENV is refused, not taken as dev", async () => {
    const run = rollback([String(everything.at(-1))], "prod");
    expect(run.status, run.stderr).toBe(2);
    expect(run.stderr).toMatch(/APP_ENV must be dev, staging or production/);
  }, 120_000);

  it("an explicit integer target in dev rolls back to exactly that version", async () => {
    const target = everything.at(-2)!;
    const run = rollback([String(target)]);
    expect(run.status, run.stderr).toBe(0);
    expect(await listApplied(db.migrator)).toEqual(everything.slice(0, -1));
  }, 120_000);
});

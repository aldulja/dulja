import { verifyProfile, formatVerifyResult } from "./einvoice/verify";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { lintSchema } from "./lint-schema";
import { down, listApplied, parseDownTarget, up } from "./migrate";
import {
  appEnvWarning,
  assertPackShape,
  parseSeedArgs,
  seed,
  seedAuthAdminFor,
  SeedError,
  StubSeedAuthAdmin,
  type SeedAuthAdmin,
  type SeedConfig,
} from "./seed";

if (process.argv[2] === "einvoice-verify") {
  const args = process.argv.slice(3);
  const argument = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const code = argument("--transmitter") ?? argument("--profile") ?? "myinvois";
  const clientId = argument("--client-id");
  const baseUrl = argument("--base-url");
  const result = await verifyProfile(code, {
    ...(clientId === undefined ? {} : { clientId }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  console.log(formatVerifyResult(result));
  process.exit(
    result.profile === "ok" &&
      result.schema === "ok" &&
      result.credentials === "present" &&
      result.reachable === "ok"
      ? 0
      : 1,
  );
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env["DATABASE_URL_MIGRATOR"];

if (!url) {
  console.error(
    "DATABASE_URL_MIGRATOR is required (app_migrator, session mode / port 5432 — never 6543)",
  );
  process.exit(2);
}

if (/:6543\b/.test(url)) {
  console.error("refusing a transaction-mode pooler URL (spec §3.2.1)");
  process.exit(2);
}

const sql = postgres(url, { max: 1 });
const [cmd] = process.argv.slice(2);

try {
  if (cmd === "up") {
    console.log("applied:", await up(sql, migrationsDirectory));
  } else if (cmd === "down") {
    // DBS-05: never `Number(argument ?? 0)` — a missing or unparseable target once rolled back everything.
    let toVersion: number;
    try {
      toVersion = parseDownTarget(process.argv.slice(3), process.env);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
    console.log("rolled back:", await down(sql, migrationsDirectory, toVersion));
  } else if (cmd === "status") {
    console.log("applied:", await listApplied(sql));
  } else if (cmd === "lint") {
    const violations = await lintSchema(sql);
    if (violations.length > 0) {
      console.error(JSON.stringify(violations, null, 2));
      process.exit(1);
    }
    console.log("schema lint: 0 violations");
  } else if (cmd === "seed") {
    // LEGACY-039: an offline CLI run as app_migrator, never an endpoint on a running system (spec:2188). `url` is
    // DATABASE_URL_MIGRATOR, checked above; app_rw could write neither the roles nor the chart.
    // Exit codes (frozen, ADR 0012): 0 success · 1 seed failure · 2 configuration error · 3 pack-shape violation.
    let config: SeedConfig;
    try {
      config = parseSeedArgs(process.argv.slice(3), process.env);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
    try {
      assertPackShape(config.packRoot);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(3);
    }
    // DBS-17: outside dev a full seed refuses the stub (exit 2); in dev the stub is said aloud, as before.
    let authAdmin: SeedAuthAdmin;
    try {
      authAdmin = seedAuthAdminFor(config, process.env);
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
    if (authAdmin instanceof StubSeedAuthAdmin) {
      console.warn(
        "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using the stub auth admin (OWNER GATE OD-21). The owner cannot log in until they are.",
      );
    }
    // PR 11 review, round 3, adversarial pass: unset is dev, and dev seeds the synthetic tax regime. Said, as
    // the stub auth admin is, so a production reseed that left APP_ENV out is visible in its own output.
    const appEnvNotice = appEnvWarning(process.env);
    if (appEnvNotice !== undefined) console.warn(appEnvNotice);
    try {
      console.log(JSON.stringify(await seed(sql, config, authAdmin), null, 2));
    } catch (error) {
      console.error(error instanceof SeedError ? `${error.code}: ${error.message}` : String(error));
      process.exit(1);
    }
  } else {
    console.error(
      "usage: cli.ts up | down <toVersion> [--force-staging|--force-production] | status | lint | seed --tenant <uuid> [--only <sub-pack>]",
    );
    process.exit(2);
  }
} finally {
  await sql.end();
}

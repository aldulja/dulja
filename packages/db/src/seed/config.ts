import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SUB_PACKS, type SubPack } from "./types";

/**
 * `bun run seed --tenant <uuid> [--only <sub-pack>]…` (§3.4.8). The OWNER GATE OD-21 values — owner e-mail, legal
 * name, base currency, fiscal-year start and the service-role key — arrive as flags and environment variables.
 * Their defaults are the fixture values §2.12 assigns until the owner answers, so the whole slice is executable
 * today and one command changes when the real values arrive.
 */
export interface SeedConfig {
  readonly tenantId: string;
  readonly only: readonly SubPack[] | null;
  readonly packRoot: string;
  /** `APP_ENV`, read and validated as `apps/api/src/config.ts` reads it: unset is `dev`, anything but the
   *  three names is a `SeedConfigError`. PR 11 review, round 3: in `production` the `tax` loader skips a
   *  regime whose `source` marks it synthetic, so `SYNTH-MY-v1`'s invented codes never reach a real company. */
  readonly appEnv: "dev" | "staging" | "production";
  readonly tenantName: string;
  readonly ownerEmail: string;
  readonly companyCode: string;
  readonly companyName: string;
  readonly baseCurrency: string;
  readonly timezone: string;
  readonly fiscalYearStartMonth: number;
  readonly fiscalYear: number;
}

/**
 * The seed CLI's configuration failure — `packages/db/src/cli.ts` maps it to exit code **2**. Deliberately **not**
 * spelled `ConfigError`: contracts §4.2.3 registers that name for `apps/api/src/config.ts`, and 8A adds a second
 * config error to this package; carrying the scope in the name keeps one spelling for one thing (hazard 9).
 */
export class SeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedConfigError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ENVS: readonly SeedConfig["appEnv"][] = ["dev", "staging", "production"];

/** What the CLI prints when `APP_ENV` is absent from its environment, or `undefined` when it is present (PR 11
 *  review, round 3, adversarial pass). The seed is an offline CLI run as app_migrator: it never reads the
 *  container's `APP_ENV` (`infra/wrangler.jsonc`), and unset is `dev`, which loads the synthetic tax regime — so
 *  a production reseed that leaves the variable out must not do so silently. Asked of the RAW environment,
 *  because `parseSeedArgs` cannot tell a defaulted `dev` from a stated one; a value that is present but not one
 *  of the three names is `parseSeedArgs`' refusal, not this warning. */
export function appEnvWarning(env: NodeJS.ProcessEnv): string | undefined {
  return env["APP_ENV"] === undefined
    ? "APP_ENV is not set — seeding as dev, which loads synthetic tax regimes (SYNTH-MY-v1) into the company. " +
        "A production seed must run with APP_ENV=production (docs/runbooks/deploy.md)."
    : undefined;
}

function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        tenant: { type: "string" },
        only: { type: "string", multiple: true },
        pack: { type: "string" },
        "tenant-name": { type: "string" },
        "owner-email": { type: "string" },
        "company-code": { type: "string" },
        "company-name": { type: "string" },
        currency: { type: "string" },
        timezone: { type: "string" },
        "fiscal-year-start": { type: "string" },
        "fiscal-year": { type: "string" },
      },
    }).values;
  } catch (error) {
    throw new SeedConfigError((error as Error).message);
  }
}

export function parseSeedArgs(argv: readonly string[], env: NodeJS.ProcessEnv): SeedConfig {
  const v = parse(argv);

  const tenantId = v.tenant ?? env["SEED_TENANT_ID"];
  if (!tenantId)
    throw new SeedConfigError(
      "--tenant <uuid> is required — the CLI never invents a tenant id (mint one with `select uuidv7()`)",
    );
  if (!UUID.test(tenantId))
    throw new SeedConfigError(`--tenant must be a uuid, got ${JSON.stringify(tenantId)}`);

  // `??`, not `||`, exactly as the API: an APP_ENV set to the empty string is a misconfiguration, not dev.
  const appEnv = env["APP_ENV"] ?? "dev";
  if (!APP_ENVS.includes(appEnv as SeedConfig["appEnv"]))
    throw new SeedConfigError(
      `APP_ENV must be dev, staging or production, got ${JSON.stringify(appEnv)}`,
    );

  let only: readonly SubPack[] | null = null;
  if (v.only && v.only.length > 0) {
    for (const name of v.only) {
      if (!(SUB_PACKS as readonly string[]).includes(name))
        throw new SeedConfigError(
          `unknown sub-pack '${name}' — expected one of ${SUB_PACKS.join(", ")}`,
        );
    }
    only = v.only as SubPack[];
  }

  const startMonth = Number(v["fiscal-year-start"] ?? "1");
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12)
    throw new SeedConfigError(
      `--fiscal-year-start must be 1–12, got ${JSON.stringify(v["fiscal-year-start"] ?? "1")}`,
    );
  const fiscalYear = Number(v["fiscal-year"] ?? String(new Date().getUTCFullYear()));
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2200)
    throw new SeedConfigError(
      `--fiscal-year must be a four-digit year, got ${JSON.stringify(v["fiscal-year"])}`,
    );

  // DBS-17 (2026-11-15 full review): outside dev a full seed creates the real owner and the real company, so the
  // OD-21 fixture defaults below are refused rather than written — a production run that left the flags out
  // created a `owner@dulja.invalid` admin and "Dulja Test Company Sdn Bhd" and exited 0. `--only` re-applies
  // sub-packs to a seeded tenant and writes neither (`seed` refuses `--only` on an unseeded tenant outside dev).
  if (appEnv !== "dev" && only === null) {
    if (v["owner-email"] === undefined)
      throw new SeedConfigError(
        `APP_ENV=${appEnv} needs --owner-email — the owner's real address (OWNER GATE OD-21), never the fixture default`,
      );
    if (/\.invalid$/i.test(v["owner-email"]))
      throw new SeedConfigError(
        `APP_ENV=${appEnv} refuses --owner-email ${JSON.stringify(v["owner-email"])}: .invalid is a reserved test domain`,
      );
    if (v["company-name"] === undefined)
      throw new SeedConfigError(
        `APP_ENV=${appEnv} needs --company-name — the company's legal name (OWNER GATE OD-21), never the fixture default`,
      );
  }

  return {
    tenantId,
    only,
    // fileURLToPath, not URL.pathname: the latter yields "/C:/Users/…" on Windows. src/seed/ → seed/my.
    packRoot: v.pack ?? fileURLToPath(new URL("../../seed/my", import.meta.url)),
    appEnv: appEnv as SeedConfig["appEnv"],
    // OWNER GATE OD-21 — every default below is a fixture value (§2.12) replaced by one flag.
    tenantName: v["tenant-name"] ?? "Dulja",
    ownerEmail: v["owner-email"] ?? "owner@dulja.invalid",
    companyCode: v["company-code"] ?? "HQ",
    companyName: v["company-name"] ?? "Dulja Test Company Sdn Bhd",
    baseCurrency: (v.currency ?? "MYR").toUpperCase(),
    timezone: v.timezone ?? "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: startMonth,
    fiscalYear,
  };
}

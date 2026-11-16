import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const SCANNED_CONFIGS: readonly string[] = [
  "infra/wrangler.jsonc",
  ".github/workflows/deploy-staging.yml",
  ".github/workflows/ci.yml",
];

export interface PostureCheck {
  readonly name: "rls-forced" | "bypassrls-probe" | "app_auth-login" | "pooler-url";
  readonly ok: boolean;
  readonly detail: string;
}

const poolerPattern = /:6543\b/;
const noRlsByDesign = new Set(["permission"]);

async function rlsForced(admin: Sql): Promise<PostureCheck> {
  const all = await admin<
    { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
  >`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app' and c.relkind in ('r', 'p')
     order by c.relname`;
  const rows = all.filter((row) => !noRlsByDesign.has(row.relname));
  const bad = rows.find((row) => !row.relrowsecurity || !row.relforcerowsecurity);
  return bad
    ? { name: "rls-forced", ok: false, detail: `app.${bad.relname} is not RLS-enabled and forced` }
    : { name: "rls-forced", ok: true, detail: `${rows.length} tables in schema app, all forced` };
}

async function bypassProbe(rw: Sql, admin: Sql): Promise<PostureCheck> {
  const [attribute] = await admin<{ bypass: boolean }[]>`
    select rolbypassrls as bypass from pg_roles where rolname = 'app_rw'`;
  if (attribute?.bypass !== false)
    return { name: "bypassrls-probe", ok: false, detail: "app_rw has rolbypassrls=true" };
  try {
    await rw`set role postgres`;
    return { name: "bypassrls-probe", ok: false, detail: "app_rw could `set role postgres`" };
  } catch {
    return {
      name: "bypassrls-probe",
      ok: true,
      detail: "app_rw rolbypassrls=false and set role refused",
    };
  }
}

async function authRole(admin: Sql): Promise<PostureCheck> {
  const [role] = await admin<{ canlogin: boolean; bypass: boolean }[]>`
    select rolcanlogin as canlogin, rolbypassrls as bypass
      from pg_roles where rolname = 'app_auth'`;
  if (!role)
    return {
      name: "app_auth-login",
      ok: false,
      detail: "role app_auth does not exist — run provision/roles.sql",
    };
  const ok = !role.canlogin && !role.bypass;
  return {
    name: "app_auth-login",
    ok,
    detail: ok
      ? "app_auth rolcanlogin=false, rolbypassrls=false"
      : `app_auth rolcanlogin=${role.canlogin}, rolbypassrls=${role.bypass}`,
  };
}

function poolerAbsent(files: readonly string[]): PostureCheck {
  const missing = files.filter((file) => !existsSync(file));
  if (missing.length)
    return {
      name: "pooler-url",
      ok: false,
      detail: `config file(s) not found: ${missing.join(", ")}`,
    };
  const hits = files.filter((file) => poolerPattern.test(readFileSync(file, "utf8")));
  return hits.length
    ? {
        name: "pooler-url",
        ok: false,
        detail: `transaction-mode pooler URL in ${hits.join(", ")}`,
      }
    : {
        name: "pooler-url",
        ok: true,
        detail: `${files.length} config files scanned, no :6543`,
      };
}

export async function verifySupabase(options: {
  rwUrl: string;
  adminUrl: string;
  configFiles: readonly string[];
}): Promise<readonly PostureCheck[]> {
  if (poolerPattern.test(options.rwUrl))
    throw new Error("the app_rw URL is a transaction-mode pooler URL (:6543)");
  const quiet = { onnotice: () => {} } as const;
  const rw = postgres(options.rwUrl, { max: 1, ...quiet });
  const admin = postgres(options.adminUrl, { max: 1, ...quiet });
  try {
    return [
      await rlsForced(admin),
      await bypassProbe(rw, admin),
      await authRole(admin),
      poolerAbsent(options.configFiles),
    ];
  } finally {
    await Promise.all([rw.end(), admin.end()]);
  }
}

const words: Record<PostureCheck["name"], readonly [string, string]> = {
  "rls-forced": ["ok", "FAILED"],
  "bypassrls-probe": ["refused", "GRANTED"],
  "app_auth-login": ["refused", "PERMITTED"],
  "pooler-url": ["absent", "PRESENT"],
};

export function formatPosture(checks: readonly PostureCheck[]): string {
  return checks.map((check) => `${check.name}: ${words[check.name][check.ok ? 0 : 1]}`).join("\n");
}

if (import.meta.main) {
  const rwUrl = process.env["DATABASE_URL"];
  const adminUrl = process.env["DATABASE_URL_MIGRATOR"];
  if (!rwUrl || !adminUrl) {
    process.stderr.write("DATABASE_URL and DATABASE_URL_MIGRATOR are required\n");
    process.exit(2);
  }
  const files = SCANNED_CONFIGS.map((file) => join(REPO_ROOT, file)).filter(existsSync);
  if (!files.length) {
    process.stderr.write("no configured files exist; refusing a false pooler-url pass\n");
    process.exit(1);
  }
  const checks = await verifySupabase({ rwUrl, adminUrl, configFiles: files });
  process.stdout.write(`${formatPosture(checks)}\n`);
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

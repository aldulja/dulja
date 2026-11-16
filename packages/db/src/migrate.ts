import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Sql } from "postgres";

export interface Migration {
  version: number;
  name: string;
  upPath: string;
  downPath: string;
}

const upFile = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const downFile = /^(\d{4})\.down\.sql$/;

/**
 * Every `.sql` file in the directory is an up file (`NNNN_<verb>_<noun>.sql`) or a down file (`NNNN.down.sql`)
 * with its up beside it; anything else is refused, never skipped (DBS-15, 2026-11-15 full review): a skipped
 * file is never applied, `status` omits it and the up → down → up test, built on this function, cannot see it.
 * A file that is not SQL (a README) is not a migration and is ignored.
 */
export function discover(directory: string): Migration[] {
  const migrations: Migration[] = [];
  const downs: string[] = [];

  for (const file of readdirSync(directory)) {
    const downMatch = downFile.exec(file);
    if (downMatch) {
      downs.push(downMatch[1]!);
      continue;
    }
    const match = upFile.exec(file);
    if (!match) {
      if (/\.sql$/i.test(file)) {
        throw new Error(
          `migration file ${file} matches neither NNNN_<verb>_<noun>.sql (lower-case snake_case) nor NNNN.down.sql — it would never be applied (spec §3.9)`,
        );
      }
      continue;
    }

    const downPath = join(directory, `${match[1]}.down.sql`);
    if (!existsSync(downPath)) {
      throw new Error(
        `migration ${file} has no ${match[1]}.down.sql — every migration ships a down (spec §3.9)`,
      );
    }

    migrations.push({
      version: Number(match[1]),
      name: match[2]!,
      upPath: join(directory, file),
      downPath,
    });
  }

  for (const version of downs) {
    if (!migrations.some((migration) => migration.version === Number(version))) {
      throw new Error(
        `migration ${version}.down.sql has no ${version}_<verb>_<noun>.sql — a down without its up is a misnamed or orphaned file (spec §3.9)`,
      );
    }
  }

  return migrations.toSorted((left, right) => left.version - right.version);
}

const APP_ENVS: readonly string[] = ["dev", "staging", "production"];

/**
 * The rollback CLI's arguments (DBS-05, 2026-11-15 full review). `down` once took `Number(argument ?? 0)`: no
 * argument meant 0 and `latest`, `v120` or `-1` meant NaN, and `version <= NaN` is never true — either way every
 * down file ran. So the target is required and must be an integer ≥ 0 (0 still undoes everything, but only when
 * said), and outside `dev` the run needs `--force-staging` or `--force-production`, naming the environment it
 * reads from `APP_ENV`. Unset `APP_ENV` is `dev`, as the seed and the API read it. Throws on any refusal; the CLI
 * maps that to exit 2. `down()` itself is unchanged.
 */
export function parseDownTarget(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  let values: { "force-staging"?: boolean; "force-production"?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "force-staging": { type: "boolean" },
        "force-production": { type: "boolean" },
      },
    }));
  } catch (error) {
    // `-1` lands here too: parseArgs reads it as an unknown short option.
    throw new Error(
      `db:rollback needs one explicit target version, an integer ≥ 0, and no other argument than --force-<env> — ${(error as Error).message}`,
      { cause: error },
    );
  }
  const [target] = positionals;
  if (positionals.length !== 1 || target === undefined || !/^\d+$/.test(target)) {
    throw new Error(
      `db:rollback needs one explicit target version, an integer ≥ 0 (the last version to keep; 0 undoes every migration) — got ${JSON.stringify(positionals)}`,
    );
  }

  const appEnv = env["APP_ENV"] ?? "dev";
  if (!APP_ENVS.includes(appEnv)) {
    throw new Error(`APP_ENV must be dev, staging or production, got ${JSON.stringify(appEnv)}`);
  }
  const flags = (["staging", "production"] as const).filter((name) => values[`force-${name}`]);
  const expected = appEnv === "dev" ? [] : [appEnv];
  if (flags.join() !== expected.join()) {
    throw new Error(
      appEnv === "dev"
        ? `--force-${flags[0]} was given but APP_ENV is dev — a confirmation flag must name the environment the run is in`
        : `refusing to roll back with APP_ENV=${appEnv}: a down migration drops tables and their data. ` +
            `Pass --force-${appEnv} to confirm this environment, and no other confirmation flag.`,
    );
  }

  return Number(target);
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql`create schema if not exists app_meta`;
  await sql`create table if not exists app_meta.schema_migration (
    version int primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;
}

export async function listApplied(sql: Sql): Promise<number[]> {
  await ensureLedger(sql);
  const rows = await sql<{ version: number }[]>`
    select version from app_meta.schema_migration order by version
  `;
  return rows.map((row) => row.version);
}

export async function up(sql: Sql, directory: string): Promise<number[]> {
  const applied = new Set(await listApplied(sql));
  const ran: number[] = [];

  for (const migration of discover(directory)) {
    if (applied.has(migration.version)) {
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe(readFileSync(migration.upPath, "utf8"));
      await transaction`
        insert into app_meta.schema_migration (version, name)
        values (${migration.version}, ${migration.name})
      `;
    });
    ran.push(migration.version);
  }

  return ran;
}

export async function down(sql: Sql, directory: string, toVersion = 0): Promise<number[]> {
  const migrations = new Map(
    discover(directory).map((migration) => [migration.version, migration]),
  );
  const applied = await listApplied(sql);
  const ran: number[] = [];

  for (const version of applied.toReversed()) {
    if (version <= toVersion) {
      break;
    }

    const migration = migrations.get(version);
    if (!migration) {
      throw new Error(`applied migration ${version} has no file in ${directory}`);
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe(readFileSync(migration.downPath, "utf8"));
      await transaction`delete from app_meta.schema_migration where version = ${version}`;
    });
    ran.push(version);
  }

  return ran;
}

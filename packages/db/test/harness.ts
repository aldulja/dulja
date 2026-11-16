import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { up } from "../src/migrate";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");
export const ROLES_SQL = join(here, "..", "provision", "roles.sql");

export type Role = "app_migrator" | "app_rw";
const passwords: Record<Role, string> = {
  app_migrator: "migrator-test",
  app_rw: "rw-test",
};

export interface Db {
  container: StartedPostgreSqlContainer;
  admin: Sql;
  migrator: Sql;
  rw: Sql;
  url(role: Role): string;
  stop(): Promise<void>;
}

export interface StartOptions {
  migrate?: boolean;
}

const quiet = { onnotice: () => {} } as const;

export async function startDb(options: StartOptions = {}): Promise<Db> {
  const container = await new PostgreSqlContainer("postgres:18").start();
  const admin = postgres(container.getConnectionUri(), { max: 2, ...quiet });

  await admin.unsafe(readFileSync(ROLES_SQL, "utf8"));
  await admin.unsafe(`alter role app_migrator password '${passwords.app_migrator}'`);
  await admin.unsafe(`alter role app_rw password '${passwords.app_rw}'`);

  const url = (role: Role): string =>
    `postgres://${role}:${passwords[role]}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
  const migrator = postgres(url("app_migrator"), { max: 4, ...quiet });
  const rw = postgres(url("app_rw"), { max: 4, ...quiet });

  if (options.migrate !== false) {
    await up(migrator, MIGRATIONS_DIR);
  }

  return {
    container,
    admin,
    migrator,
    rw,
    url,
    async stop() {
      await Promise.all([admin.end(), migrator.end(), rw.end()]);
      await container.stop();
    },
  };
}

export async function withTenant<T>(
  sql: Sql,
  tenantId: string,
  actorId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_id', ${actorId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

export async function uuidv7(sql: Sql): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select uuidv7()::text as id`;
  return row!.id;
}

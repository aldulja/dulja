import { PgBoss } from "pg-boss";
import { queuePolicy } from "../src/jobs/enqueue";
import type { Db } from "./harness";

/**
 * The test-side twin of the deploy step `bun run --cwd apps/worker jobs:install` (contracts §4.2.6): pg-boss's own
 * tables are installed **as app_migrator**, exactly once, because app_rw may not create objects. Runtime code always
 * constructs pg-boss with `migrate: false` on DATABASE_URL (app_rw). Each queue gets the policy the deploy step
 * gives it (`queuePolicy` — `stately` for `STATELY_JOBS`), so a suite exercises the dedupe production has.
 */
export async function installBoss(db: Db, queues: readonly string[] = []): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: db.url("app_migrator"),
    schema: "pgboss",
    migrate: true,
    max: 2,
  });
  await boss.start();
  for (const name of queues) await boss.createQueue(name, { policy: queuePolicy(name) });
  return boss;
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: false });
}

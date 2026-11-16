import { PgBoss } from "pg-boss";

/**
 * The worker's pg-boss. `onError` receives its `error` events: pg-boss re-emits pool and client errors on
 * itself, and an EventEmitter `error` with no listener throws — so an idle connection dropped by a database
 * restart was an uncaught exception that killed the worker (code review 2026-09-29, the same defect as the
 * API's enqueue client).
 */
export function createBoss(connectionString: string, onError: (error: unknown) => void): PgBoss {
  const boss = new PgBoss({ connectionString, schema: "pgboss", migrate: false, max: 4 });
  boss.on("error", onError);
  return boss;
}

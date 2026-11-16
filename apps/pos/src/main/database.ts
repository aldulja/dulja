import Database from "better-sqlite3";
import schema from "./schema.sql";

/** Version 2 adds pending customers and version 3 the `cash_event` table and outbox kind (⚠️ OD-10), each
 *  without replacing any unsent local data. */
export const LOCAL_SCHEMA_VERSION = 3;
const READABLE_VERSIONS = new Set(["1", "2", String(LOCAL_SCHEMA_VERSION)]);

/**
 * SQLite cannot alter a CHECK, so a file whose `outbox` predates the `cash_event` kind gets the table rebuilt
 * under the current definition with every row copied — unsent tickets included. Runs before `schema.sql`, in
 * the same transaction, so a failure leaves the file as it was. The `outbox_refused` view and the two indexes
 * are dropped first: a rename would carry the indexes' names to the old table (so `schema.sql`'s
 * `create … if not exists` would skip them) and would rewrite the view to read the old table.
 */
function upgradeOutboxKinds(sqlite: Database.Database): boolean {
  const table = sqlite
    .prepare<[], { sql: string }>(
      "select sql from sqlite_master where type = 'table' and name = 'outbox'",
    )
    .get();
  if (!table || table.sql.includes("'cash_event'")) return false;
  sqlite.exec(`drop view if exists outbox_refused;
    drop index if exists outbox_ref_idx;
    drop index if exists outbox_pending_idx;
    alter table outbox rename to outbox_before_v3;`);
  return true;
}

export class StoreCorruptError extends Error {
  readonly code = "ERR_TILL_STORE_CORRUPT" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "StoreCorruptError";
  }
}

export interface PosDatabase {
  readonly raw: Database.Database;
  /** Synchronous transactions nest as savepoints. Async callbacks are refused. */
  tx<T>(fn: () => T): T;
  close(): void;
}

export function openPosDatabase(file: string): PosDatabase {
  let raw: Database.Database | undefined;
  try {
    raw = new Database(file);
    const check = raw.pragma("integrity_check") as { integrity_check: string }[];
    if (check.length !== 1 || check[0]?.integrity_check !== "ok") {
      throw new StoreCorruptError("The local till database failed its integrity check.");
    }
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = FULL");
    raw.pragma("foreign_keys = ON");
    const sqlite = raw;
    sqlite.transaction(() => {
      const hasMeta = sqlite
        .prepare("select 1 from sqlite_master where type = 'table' and name = 'meta'")
        .get();
      const version = hasMeta
        ? sqlite
            .prepare<[], { value: string }>("select value from meta where key = 'schema_version'")
            .get()?.value
        : undefined;
      if (hasMeta && (version === undefined || !READABLE_VERSIONS.has(version))) {
        throw new StoreCorruptError(
          "The local till schema version is unsupported; preserve this file for recovery.",
        );
      }
      const rebuilt = upgradeOutboxKinds(sqlite);
      sqlite.exec(schema);
      if (rebuilt)
        sqlite.exec(`insert into outbox (id, kind, ref, payload, attempts, last_error, acked_at, created_at)
                       select id, kind, ref, payload, attempts, last_error, acked_at, created_at
                         from outbox_before_v3 order by rowid;
                     drop table outbox_before_v3;`);
      sqlite
        .prepare(
          "insert into meta (key, value) values ('schema_version', ?) on conflict (key) do update set value = excluded.value",
        )
        .run(String(LOCAL_SCHEMA_VERSION));
    })();
    const transact = sqlite.transaction(<T>(fn: () => T): T => {
      const result = fn();
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result
      ) {
        throw new TypeError("POS transactions require synchronous callbacks.");
      }
      return result;
    });
    return {
      raw: sqlite,
      tx<T>(fn: () => T): T {
        return transact(fn) as T;
      },
      close(): void {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    if (raw?.open) raw.close();
    if (error instanceof StoreCorruptError) throw error;
    throw new StoreCorruptError(
      `The local till database could not be opened: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
  }
}

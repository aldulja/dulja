import postgres, { type Sql } from "postgres";

export interface DbOptions {
  max?: number;
  /** postgres.js's own statement hook (ADR 0013) — never a monkey-patch, and never handed parameter values. */
  debug?: (connection: number, query: string) => void;
}

function redact(url: string): string {
  return url.replace(/(\/\/[^:@/]*):[^@/]*@/, "$1:***@");
}

export class PoolerUrlError extends Error {
  readonly code = "ERR_DB_POOLER_URL" as const;
  constructor(url: string) {
    super(
      `ERR_DB_POOLER_URL: ${redact(url)} names port 6543; use a session or direct connection on 5432.`,
    );
    this.name = "PoolerUrlError";
  }
}

/** Creates the small, session-mode database pool used by every production process. */
export function createDb(url: string, opts: DbOptions = {}): Sql {
  if (url.includes(":6543")) throw new PoolerUrlError(url);
  const debug = opts.debug;
  return postgres(url, {
    max: opts.max ?? 4,
    onnotice: () => {},
    ...(debug ? { debug: (connection: number, query: string) => debug(connection, query) } : {}),
  });
}

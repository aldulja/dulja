import type { LegacyPredicate } from "./predicate";

/**
 * A value read out of the legacy database. There is deliberately **no `number` member**: spec:99 forbids a
 * float holding money "anywhere, including in TypeScript", and an ODBC driver hands NUMERIC(18,4) back as a
 * JavaScript number unless the query casts it. Every scaled-numeric and floating column is cast to varchar in
 * the renderer (`drivers/sql.ts`), so amounts arrive as exact decimal text and are computed with `Decimal`.
 */
export type LegacyScalar = string | boolean | null;
export type LegacyRow = Readonly<Record<string, LegacyScalar>>;

/** How a column's declared Firebird type is classified, from RDB$FIELDS (`drivers/odbc.ts`). */
export type LegacyColumnKind =
  | "text"
  | "decimal"
  | "float"
  | "integer"
  | "date"
  | "timestamp"
  | "time"
  | "blob"
  | "other";

export interface LegacyColumn {
  /** Upper-case, trimmed — Firebird pads RDB$FIELD_NAME to CHAR(63). */
  readonly name: string;
  readonly kind: LegacyColumnKind;
  /** Digits after the point for `decimal`; 0 otherwise. */
  readonly scale: number;
  readonly nullable: boolean;
}

/**
 * A real constraint, as the engine declares it — not as the schema dump's naming convention implies. Part VII
 * #6 (spec:2470) exists because five Part I findings rest on the convention: LEGACY-024, 049, 051, 066 and 074.
 */
export interface LegacyConstraint {
  readonly table: string;
  readonly name: string;
  readonly kind: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "other";
  readonly columns: readonly string[];
  readonly referencedTable: string | null;
}

/** A read, described structurally. The driver — not the caller — turns this into text (ADR 0082). */
export interface SelectSpec {
  readonly table: string;
  /** Empty means every column the catalogue declares. */
  readonly columns: readonly string[];
  readonly where?: LegacyPredicate;
  readonly orderBy?: readonly string[];
}

/**
 * The one seam that knows a database exists. Two implementations ship in 9A: `OdbcLegacyDriver` (live, ADR
 * 0081) and `FixtureLegacyDriver` (the corpus, and the local equivalent for OD-17). Everything above this
 * interface is a pure function of rows and is unit-tested with no database at all.
 */
export interface LegacyDriver {
  readonly kind: "odbc" | "fixture";
  /** A redacted description of the connection, printed in every artefact header. Never a password. */
  readonly source: string;
  engineVersion(): Promise<string | null>;
  tables(): Promise<string[]>;
  columns(table: string): Promise<LegacyColumn[]>;
  keyColumns(table: string): Promise<string[]>;
  constraints(table: string): Promise<LegacyConstraint[]>;
  count(table: string, where?: LegacyPredicate): Promise<number>;
  minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
  cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]>;
  close(): Promise<void>;
}

/**
 * The one message shape this package raises. The code is contracts §4.2.4's, allocated to "Firebird reader
 * (9A)". A plain `Error` carrying the token, not an `AppError`: this package has no HTTP surface and may not
 * import `@dulja/contracts`' error class (§4.13.1). The CLI maps the token to exit code 3.
 */
export function unreadable(detail: string): Error {
  return new Error(["ERR_IMPORT_SOURCE_UNREADABLE:", detail].join(" "));
}

const ABSENT = Symbol("dulja.importer.absentFromCatalogue");

/**
 * The same refusal, raised by a catalogue-membership gate: the table or column asked for is not one this source
 * declares. Marked, so a probe that asks "is this column here?" (`hasColumns`) can tell "no" apart from a source that
 * could not be read at all — a dropped connection is never "column absent" (2026-11-15 review, HRP-22).
 */
export function absentFromCatalogue(detail: string): Error {
  return Object.assign(unreadable(detail), { [ABSENT]: true });
}

export function isAbsentFromCatalogue(cause: unknown): boolean {
  return cause instanceof Error && (cause as Error & { [ABSENT]?: true })[ABSENT] === true;
}

import type { LegacyPredicate } from "../legacy/predicate";
import {
  absentFromCatalogue,
  unreadable,
  type LegacyColumn,
  type LegacyColumnKind,
  type LegacyConstraint,
  type LegacyDriver,
  type LegacyRow,
  type LegacyScalar,
  type SelectSpec,
} from "../legacy/types";
import { renderCount, renderMinMax, renderSelect } from "./sql";

export interface OdbcOptions {
  readonly dsn: string;
  /** Supplied by the owner when the engine cannot be asked (Firebird before 2.1). ADR 0081 records it. */
  readonly firebirdVersion?: string;
}

/** The two methods of an `odbc` connection this driver uses — the seam a test scripts instead of a database. */
export interface OdbcConnection {
  query(text: string, params?: readonly LegacyScalar[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "UID",
  "USER",
  "USERNAME",
  "USER ID",
  "PWD",
  "PASSWORD",
]);

/**
 * Strips every credential from a DSN so it can appear in an artefact header and a log line (spec:2063). The DSN is
 * read as ODBC writes it — `key=value` attributes separated by `;`, a value in `{…}` free to hold `;` and `=` — and a
 * credential key's WHOLE value is replaced (2026-11-15 review, HRP-07: a regex stopping at the first `;` printed the
 * tail of a braced password holding a `;`). An unclosed `{` runs to the end of the string, so a malformed value is dropped whole.
 */
export function redactDsn(dsn: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < dsn.length) {
    // One attribute: up to the next `;` that is not inside braces.
    let j = i;
    let braced = false;
    while (j < dsn.length && (braced || dsn[j] !== ";")) {
      if (dsn[j] === "{") braced = true;
      else if (dsn[j] === "}") braced = false;
      j += 1;
    }
    const attribute = dsn.slice(i, j);
    const eq = attribute.indexOf("=");
    const key = eq < 0 ? "" : attribute.slice(0, eq);
    out.push(CREDENTIAL_KEYS.has(key.trim().toUpperCase()) ? [key, "***"].join("=") : attribute);
    if (j < dsn.length) out.push(";");
    i = j + 1;
  }
  return out.join("");
}

/**
 * Firebird's RDB$FIELD_TYPE codes, mapped to the classification the renderer casts on. The numbers are the
 * engine's own and are stable across every version in the field; the scale test is what separates an integer
 * from a scaled decimal, because Firebird stores NUMERIC(18,4) as a BIGINT with RDB$FIELD_SCALE = -4.
 */
function classify(
  fieldType: number,
  scale: number,
  subType: number,
): { kind: LegacyColumnKind; scale: number } {
  if (scale < 0) return { kind: "decimal", scale: -scale };
  switch (fieldType) {
    case 7:
    case 8:
    case 16:
      return { kind: subType === 1 || subType === 2 ? "decimal" : "integer", scale: 0 };
    case 10:
    case 27:
      return { kind: "float", scale: 0 };
    case 12:
      return { kind: "date", scale: 0 };
    case 13:
      return { kind: "time", scale: 0 };
    case 35:
      return { kind: "timestamp", scale: 0 };
    case 14:
    case 37:
      return { kind: "text", scale: 0 };
    case 261:
      return { kind: "blob", scale: 0 };
    default:
      return { kind: "other", scale: 0 };
  }
}

const KNOWN_CONSTRAINT_KINDS: readonly LegacyConstraint["kind"][] = [
  "PRIMARY KEY",
  "FOREIGN KEY",
  "UNIQUE",
  "CHECK",
];

/**
 * The live driver. Which extraction method ADR 0081 records — reading the production database directly,
 * restoring a `gbak` backup into a throwaway instance first, or attaching a copied `.fdb` — changes the
 * runbook and not this class: all three terminate at one SQL connection (Part VII #5).
 *
 * Every catalogue statement below is one unbroken template literal with no interpolation and its one value
 * bound: spec:100 forbids building SQL by concatenation with no exception for a `+` whose operands happen to be
 * literals, so none of them may be split across a join.
 */
export class OdbcLegacyDriver implements LegacyDriver {
  readonly kind = "odbc" as const;
  readonly source: string;
  private readonly conn: OdbcConnection;
  private readonly declaredVersion: string | undefined;
  private readonly catalogue = new Map<string, LegacyColumn[]>();
  private readonly keys = new Map<string, string[]>();

  constructor(conn: OdbcConnection, dsn: string, declaredVersion?: string) {
    this.conn = conn;
    this.source = redactDsn(dsn);
    this.declaredVersion = declaredVersion;
  }

  /** Firebird 2.1 and later answer this; earlier engines raise, and the owner's `--firebird-version` stands in. */
  async engineVersion(): Promise<string | null> {
    if (this.declaredVersion) return this.declaredVersion;
    try {
      const rows = await this.conn.query(
        `select cast(rdb$get_context('SYSTEM', 'ENGINE_VERSION') as varchar(40)) as "V" from rdb$database`,
      );
      const value = rows[0]?.V;
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    } catch {
      return null;
    }
  }

  async tables(): Promise<string[]> {
    const rows = await this.conn.query(
      `select trim(rdb$relation_name) as "T" from rdb$relations where coalesce(rdb$system_flag, 0) = 0 and rdb$view_blr is null order by 1`,
    );
    return rows.map((r) => String(r.T));
  }

  async columns(table: string): Promise<LegacyColumn[]> {
    const cached = this.catalogue.get(table);
    if (cached) return cached;
    const rows = await this.conn.query(
      `select trim(rf.rdb$field_name) as "N", f.rdb$field_type as "T", coalesce(f.rdb$field_scale, 0) as "S", coalesce(f.rdb$field_sub_type, 0) as "U", coalesce(rf.rdb$null_flag, 0) as "NN" from rdb$relation_fields rf join rdb$fields f on f.rdb$field_name = rf.rdb$field_source where rf.rdb$relation_name = ? order by rf.rdb$field_position`,
      [table],
    );
    if (rows.length === 0)
      throw absentFromCatalogue(["table", table, "declares no columns"].join(" "));
    const columns = rows.map((r) => {
      const { kind, scale } = classify(Number(r.T), Number(r.S), Number(r.U));
      return { name: String(r.N), kind, scale, nullable: Number(r.NN) === 0 };
    });
    this.catalogue.set(table, columns);
    return columns;
  }

  /** The primary key's columns in position order; an empty array for the 42 tables that have none (SAH-074). */
  async keyColumns(table: string): Promise<string[]> {
    const cached = this.keys.get(table);
    if (cached) return cached;
    const rows = await this.conn.query(
      `select trim(s.rdb$field_name) as "N" from rdb$relation_constraints c join rdb$index_segments s on s.rdb$index_name = c.rdb$index_name where c.rdb$relation_name = ? and c.rdb$constraint_type = 'PRIMARY KEY' order by s.rdb$field_position`,
      [table],
    );
    const names = rows.map((r) => String(r.N));
    this.keys.set(table, names);
    return names;
  }

  /**
   * Every constraint the engine declares on the table, with its index segments in position order and, for a
   * FOREIGN KEY, the table its unique constraint belongs to (Part VII #6 — "confirm against
   * RDB$RELATION_CONSTRAINTS and RDB$INDICES"). A CHECK carries no index, so no columns; Firebird's `NOT NULL`
   * rows are reported as `other` — nullability is already `LegacyColumn.nullable`.
   */
  async constraints(table: string): Promise<LegacyConstraint[]> {
    const rows = await this.conn.query(
      `select trim(c.rdb$constraint_name) as "CN", trim(c.rdb$constraint_type) as "CT", trim(s.rdb$field_name) as "FN", trim(coalesce(r2.rdb$relation_name, '')) as "RT" from rdb$relation_constraints c left join rdb$index_segments s on s.rdb$index_name = c.rdb$index_name left join rdb$ref_constraints rc on rc.rdb$constraint_name = c.rdb$constraint_name left join rdb$relation_constraints r2 on r2.rdb$constraint_name = rc.rdb$const_name_uq where c.rdb$relation_name = ? order by c.rdb$constraint_name, s.rdb$field_position`,
      [table],
    );
    const grouped = new Map<string, { kind: string; columns: string[]; referenced: string }>();
    for (const row of rows) {
      const name = String(row.CN ?? "");
      const existing = grouped.get(name) ?? {
        kind: String(row.CT ?? ""),
        columns: [],
        referenced: String(row.RT ?? ""),
      };
      const column = row.FN === null || row.FN === undefined ? "" : String(row.FN);
      if (column.length > 0) existing.columns.push(column);
      grouped.set(name, existing);
    }
    return [...grouped].map(([name, g]) => ({
      table,
      name,
      kind: KNOWN_CONSTRAINT_KINDS.find((k) => k === g.kind) ?? "other",
      columns: g.columns,
      referencedTable: g.referenced.length > 0 ? g.referenced : null,
    }));
  }

  async count(table: string, where?: LegacyPredicate): Promise<number> {
    const statement = renderCount(table, await this.columns(table), where);
    const rows = await this.conn.query(statement.text, statement.params);
    const n = Number.parseInt(String(rows[0]?.N ?? ""), 10);
    if (!Number.isSafeInteger(n))
      throw unreadable(["count(*) on", table, "did not return an integer"].join(" "));
    return n;
  }

  async minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    const statement = renderMinMax(table, column, await this.columns(table));
    const rows = await this.conn.query(statement.text, statement.params);
    return { min: text(rows[0]?.MIN_V), max: text(rows[0]?.MAX_V) };
  }

  /**
   * Reads the whole result set and yields it in slices rather than streaming: 9A's reads are bounded by the
   * scoping run's own row counts, and the batching *interface* is what later work needs. 9B, which reads every
   * row of `BillItems`, replaces this one method body with the `odbc` cursor API and changes nothing above it.
   */
  async *cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]> {
    if (!Number.isSafeInteger(batch) || batch < 1)
      throw unreadable(["batch size", String(batch), "is not a positive integer"].join(" "));
    const columns = await this.columns(spec.table);
    const orderBy = spec.orderBy ?? (await this.keyColumns(spec.table));
    const statement = renderSelect({ ...spec, orderBy }, columns);
    const rows = await this.conn.query(statement.text, statement.params);
    for (let i = 0; i < rows.length; i += batch) {
      yield rows.slice(i, i + batch).map((row) => coerce(row, spec.table));
    }
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).trim();
}

/**
 * Every value the renderer cast to varchar must arrive as a string. If a `number` or a `Date` reaches here the
 * cast was lost, and a monetary figure is one float-rounding away from being wrong — refuse rather than continue
 * (spec:99; SAH-012). A blob (`CAST_WIDTH.blob` is null, so it is not cast) arrives as bytes and crosses the seam
 * as **base64**: a text decode would corrupt every byte above 0x7F, which for a serialised report object is most
 * of them (plan 9A correction C2, applied where the code is first written).
 */
function coerce(row: Record<string, unknown>, table: string): LegacyRow {
  const out: Record<string, LegacyScalar> = {};
  for (const [key, value] of Object.entries(row)) {
    const where = [table, key].join(".");
    if (typeof value === "number" || typeof value === "bigint")
      throw unreadable(
        [where, "arrived as a JavaScript number; the varchar cast was lost"].join(" "),
      );
    if (value instanceof Date)
      throw unreadable([where, "arrived as a Date; the varchar cast was lost"].join(" "));
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === "boolean") out[key] = value;
    else if (value instanceof ArrayBuffer) out[key] = Buffer.from(value).toString("base64");
    else if (ArrayBuffer.isView(value))
      out[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
    else out[key] = String(value).trim();
  }
  return out;
}

/**
 * The `odbc` package is a native module. It is imported here and nowhere else, and lazily, so every test in
 * this package runs on a machine with no ODBC driver manager installed (assumption 4). Its install script is
 * not trusted in the repository; the machine that runs the extraction builds it once (`bun pm trust odbc`).
 */
export async function connectOdbc(opts: OdbcOptions): Promise<OdbcLegacyDriver> {
  let connect: (dsn: string) => Promise<unknown>;
  try {
    const loaded = await import("odbc");
    connect = ("default" in loaded ? loaded.default : loaded).connect;
  } catch (cause) {
    throw unreadable(
      [
        "the odbc native binding is not available (build it with `bun pm trust odbc`):",
        cause instanceof Error ? cause.message : String(cause),
      ].join(" "),
    );
  }
  try {
    const conn = (await connect(opts.dsn)) as OdbcConnection;
    return new OdbcLegacyDriver(conn, opts.dsn, opts.firebirdVersion);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw unreadable(["cannot open", [redactDsn(opts.dsn), ":"].join(""), reason].join(" "));
  }
}

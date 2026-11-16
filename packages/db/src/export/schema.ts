import type { Sql } from "postgres";
import { NEVER_EXPORTED, type ExportTable } from "./tables";

export interface ExportSchemaColumn {
  name: string;
  /** `information_schema.columns.data_type` — the column's type in the database, before the wire shaping
   *  the dialect below describes (a `numeric` travels as a fixed-decimal string, a `jsonb` as JSON text). */
  type: string;
  nullable: boolean;
  /** The declared scale of a `numeric` column (4 for money, 6 for quantities, 8 for rates); null otherwise. */
  scale: number | null;
}

export interface ExportSchemaTable {
  name: string;
  /** `company`: bounded to the exported company; `tenant`: every row of the tenant (ADR 0069). */
  scope: "company" | "tenant";
  gate: string | null;
  columns: ExportSchemaColumn[];
  /** Every live column the export leaves out, so the choice is visible rather than silent. */
  omitted: string[];
}

/** spec:2186's "a documented schema", as a build-checked artefact. Written into the archive as schema.json. */
export interface ExportSchemaDocument {
  formatVersion: 1;
  generatedAt: string;
  company: { id: string };
  encoding: "utf-8";
  csvDialect: { delimiter: ","; quote: '"'; newline: "\n"; header: true };
  moneyScale: 4;
  quantityScale: 6;
  rateScale: 8;
  timestamps: "RFC 3339 UTC";
  dates: "YYYY-MM-DD";
  binary: "lower-case hex";
  json: "JSON text";
  /** `tables/<table>.json` is newline-delimited JSON: one object per row, keys in column order (7C T8). */
  tableJson: "newline-delimited, one object per row";
  tables: ExportSchemaTable[];
}

interface LiveColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  // `information_schema.cardinal_number` is a domain, which the driver may hand over as text.
  numeric_scale: number | string | null;
}

/**
 * Documents each table from `information_schema`, so the schema cannot drift from the database: a column the
 * registry names that the database lacks throws, and every column the database has is either documented or
 * listed as `omitted`. A `NEVER_EXPORTED` column (or a whole pinned table) reaching the export throws — the
 * last line of ADR 0069's side-channel defence.
 */
export async function exportSchemaDocument(
  tx: Sql,
  input: { companyId: string; tables: readonly ExportTable[]; generatedAt: string },
): Promise<ExportSchemaDocument> {
  const names = input.tables.map((table) => table.name);
  const live = await tx<LiveColumn[]>`
    select table_name, column_name, data_type, is_nullable, numeric_scale
      from information_schema.columns
     where table_schema = 'app' and table_name = any(${names}::text[])
     order by table_name, ordinal_position`;
  const byTable = new Map<string, LiveColumn[]>();
  for (const row of live) {
    const bucket = byTable.get(row.table_name) ?? [];
    bucket.push(row);
    byTable.set(row.table_name, bucket);
  }

  const tables: ExportSchemaTable[] = input.tables.map((table) => {
    const pinned = NEVER_EXPORTED[table.name] ?? [];
    if (pinned.includes("*"))
      throw new Error(`export schema: app.${table.name} is pinned whole in NEVER_EXPORTED`);
    const rows = byTable.get(table.name) ?? [];
    if (rows.length === 0) throw new Error(`export schema: app.${table.name} does not exist`);
    const exported = new Set(table.columns);
    return {
      name: table.name,
      scope: table.scope,
      gate: table.gate,
      columns: table.columns.map((name) => {
        // A pinned column that somehow reached `columns` is a build failure, not a warning.
        if (pinned.includes(name))
          throw new Error(
            `export schema: app.${table.name}.${name} is in NEVER_EXPORTED but is being exported`,
          );
        const row = rows.find((candidate) => candidate.column_name === name);
        // A column the registry names that the database does not have is a defect: the export would emit a
        // header for a column no query returns.
        if (!row) throw new Error(`export schema: app.${table.name} has no column '${name}'`);
        return {
          name,
          type: row.data_type,
          nullable: row.is_nullable === "YES",
          scale:
            row.data_type === "numeric" && row.numeric_scale !== null
              ? Number(row.numeric_scale)
              : null,
        };
      }),
      omitted: rows.map((row) => row.column_name).filter((name) => !exported.has(name)),
    };
  });

  return {
    formatVersion: 1,
    generatedAt: input.generatedAt,
    company: { id: input.companyId },
    encoding: "utf-8",
    csvDialect: { delimiter: ",", quote: '"', newline: "\n", header: true },
    moneyScale: 4,
    quantityScale: 6,
    rateScale: 8,
    timestamps: "RFC 3339 UTC",
    dates: "YYYY-MM-DD",
    binary: "lower-case hex",
    json: "JSON text",
    tableJson: "newline-delimited, one object per row",
    tables,
  };
}

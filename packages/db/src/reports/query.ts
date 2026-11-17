import type { Sql } from "postgres";
import { REPORT_FILTER_OPS, type ReportFilterOp } from "@dulja/domain";
import { ReportError } from "./errors";
import type { SqlFragment } from "./sql-fragment";

export type DatasetColumnKind =
  | "text"
  | "uuid"
  | "date"
  | "timestamp"
  | "numeric"
  | "integer"
  | "boolean";

export interface DatasetColumn {
  /** What a ReportDefinition's filters / columns / groups / sort name. */
  readonly field: string;
  readonly kind: DatasetColumnKind;
  /** The literal qualified column, authored in `datasets/*.ts`. A definition supplies a `field`, never this. */
  readonly ref: (tx: Sql) => SqlFragment;
  /**
   * The read code a definition must be gated on to reference this column at all — in its columns, groups,
   * totals, sort or filters (Phase 7 second review, finding 5). A cost figure is a separate read (3B,
   * spec:2159/2160's "Costs"), so a dataset admitted under a broader code may still not print it under that
   * code: `assertDatasetGate` refuses the definition. Absent: the dataset's own gate suffices.
   */
  readonly requires?: string;
  /** Default true. */
  readonly filterable?: boolean;
  /** Default true. */
  readonly sortable?: boolean;
  /**
   * A `date` column that is an instant's calendar date in the company's timezone — `ref` is
   * `(<instant> at time zone <tz>)::date`, which no btree on the instant can seek. With this set, `eq`, `ne`,
   * `lt`, `lte`, `gt` and `gte` compile to bounds on the INSTANT instead (contracts round 15, A17 as executed):
   * a local date `d` begins at its first instant in `tz` (`localDayStart`) and ends where `d + 1` begins, so
   * `ref >= d` is `instant >= start(d)` and `ref <= d` is `instant < start(d + 1)` — the same rows, and a
   * `(company_id, <instant>)` index serves them. `timezone` is a scalar subquery over the run's company; it is
   * READ ONCE before the statement (`localTimezoneFor`) and the bound carries the zone as a bound VALUE, never
   * the subquery: under RLS PostgreSQL (18.7) will not use a qual holding a SubPlan as an index condition on the
   * row-secured table, so an inline subquery leaves the instant in `Filter` and the seek is lost. `in` and
   * `like` keep `ref`. Both fragments are literal, authored in `datasets/*.ts`.
   */
  readonly localDateOf?: {
    readonly instant: (tx: Sql) => SqlFragment;
    readonly timezone: (tx: Sql, companyId: string) => SqlFragment;
  };
}

export interface DatasetFilter {
  readonly field: string;
  readonly op: ReportFilterOp;
  readonly value: string | readonly string[];
}

export interface DatasetSortKey {
  readonly field: string;
  readonly dir: "asc" | "desc";
}

export interface DatasetParams {
  readonly companyId: string;
  /**
   * A literal row bound the run's GATE carries (`datasetRowBound`, second review, finding 4): when a dataset is
   * read under a module's code rather than its full read code, only that module's rows. Authored in
   * `datasets.ts` over the dataset's own aliases; never from a definition.
   */
  readonly rowBound?: (tx: Sql) => SqlFragment;
  readonly filters: readonly DatasetFilter[];
  readonly sort: readonly DatasetSortKey[];
  /** Clamped to MAX_DATASET_ROWS. */
  readonly limit: number;
  readonly offset: number;
}

export type DatasetRow = Readonly<Record<string, string | number | boolean | null>>;

export interface Dataset {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  run(tx: Sql, params: DatasetParams): Promise<DatasetRow[]>;
}

export interface DatasetSpec {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  readonly select: (tx: Sql) => SqlFragment;
  readonly from: (tx: Sql) => SqlFragment;
  /** null for a tenant-scoped source with no company key — `audit_log` is the only such member. */
  readonly company: ((tx: Sql, companyId: string) => SqlFragment) | null;
  readonly defaultOrder: (tx: Sql) => SqlFragment;
}

/** A definition cannot ask for unbounded rows; §4.9's report-generation SLO depends on a ceiling existing. */
export const MAX_DATASET_ROWS = 100_000;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const INTEGER = /^-?\d{1,18}$/;

/**
 * Shape-check a bound value BEFORE it reaches Postgres. Without this a malformed uuid raises SQLSTATE 22P02,
 * which `fromDatabaseError` maps to `ERR_INTERNAL` (§4.2.4) — a 500 for a caller's typo. LEGACY-084's fix is a
 * message naming the specific offending entity, which is what this produces.
 */
function assertValue(kind: DatasetColumnKind, value: string, field: string): void {
  const ok =
    kind === "uuid"
      ? UUID.test(value)
      : kind === "date"
        ? DATE.test(value)
        : kind === "timestamp"
          ? TIMESTAMP.test(value)
          : kind === "numeric"
            ? NUMERIC.test(value)
            : kind === "integer"
              ? INTEGER.test(value)
              : kind === "boolean"
                ? value === "true" || value === "false"
                : true;
  if (!ok) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `value '${value}' is not a ${kind} (field '${field}')`,
    );
  }
}

/** `like` is a PREFIX match, never a pattern: the two LIKE metacharacters and the escape are neutralised. */
function likePrefix(value: string): string {
  return `${value.replace(/([\\%_])/g, "\\$1")}%`;
}

/** One bound scalar, cast per kind. Every cast below is literal text in this file. */
function scalar(tx: Sql, kind: DatasetColumnKind, value: string): SqlFragment {
  switch (kind) {
    case "uuid":
      return tx`${value}::uuid`;
    case "date":
      return tx`${value}::date`;
    case "timestamp":
      return tx`${value}::timestamptz`;
    case "numeric":
      return tx`${value}::numeric`;
    case "integer":
      return tx`${value}::int8`;
    case "boolean":
      // `::text::boolean`, never a bare `::boolean`: postgres.js serialises a parameter the server types as
      // boolean with `x === true ? 't' : 'f'`, so the STRING "true" bound as `$1::boolean` arrived as false and
      // every `eq "true"` filter silently returned the false set (found by 7C Task 1; contracts round 15,
      // A16 item 12). Typed text, the string reaches Postgres as written and the cast is Postgres's own.
      return tx`${value}::text::boolean`;
    case "text":
      return tx`${value}::text`;
  }
}

/** One bound array, cast per kind — postgres.js binds a JS array as an array parameter. */
function anyOf(
  tx: Sql,
  ref: SqlFragment,
  kind: DatasetColumnKind,
  values: readonly string[],
): SqlFragment {
  const bound = [...values];
  switch (kind) {
    case "uuid":
      return tx`${ref} = any(${bound}::uuid[])`;
    case "date":
      return tx`${ref} = any(${bound}::date[])`;
    case "timestamp":
      return tx`${ref} = any(${bound}::timestamptz[])`;
    case "numeric":
      return tx`${ref} = any(${bound}::numeric[])`;
    case "integer":
      return tx`${ref} = any(${bound}::int8[])`;
    case "boolean":
      // `::text[]::boolean[]` for the reason `scalar`'s boolean branch gives.
      return tx`${ref} = any(${bound}::text[]::boolean[])`;
    case "text":
      return tx`${ref} = any(${bound}::text[])`;
  }
}

function columnOf(
  id: string,
  columns: readonly DatasetColumn[],
  field: string,
  purpose: "filter" | "sort",
): DatasetColumn {
  const column = columns.find((c) => c.field === field);
  if (column === undefined) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `${purpose} field '${field}' is not a column of dataset '${id}'`,
    );
  }
  if (purpose === "filter" && column.filterable === false) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `filter field '${field}' is not filterable on dataset '${id}'`,
    );
  }
  if (purpose === "sort" && column.sortable === false) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `sort field '${field}' is not sortable on dataset '${id}'`,
    );
  }
  return column;
}

/**
 * The first instant whose date in `tz` is `day` (a bound date expression). Plain `day::timestamp at time zone
 * tz` is that instant except where a DST change REPEATS local midnight (America/Havana's fall-back, 01:00 →
 * 00:00): Postgres reads an ambiguous local time as standard time, the LATER of the two instants, so the first
 * hour of the day would land before its own start. The local 23:00 an hour earlier is unambiguous there, and
 * one real hour after it is the first midnight; `least` of the two is the day's start in every zone (they agree
 * wherever midnight is not repeated, and a midnight a spring-forward skips resolves to the change itself,
 * Postgres's rule for a nonexistent local time).
 */
function localDayStart(tx: Sql, day: SqlFragment, tz: SqlFragment): SqlFragment {
  return tx`least(${day}::timestamp at time zone ${tz},
                  ((${day}::timestamp - interval '1 hour') at time zone ${tz}) + interval '1 hour')`;
}

/**
 * A comparison of a `localDateOf` column against one local date, as bounds on its instant: `start` is the first
 * instant of the date in the company's timezone and `next` the first instant of the day after. Every branch is
 * literal; the date and the zone are bound parameters (the zone read by `localTimezoneFor`).
 */
function localDateBound(
  tx: Sql,
  local: NonNullable<DatasetColumn["localDateOf"]>,
  timezone: string,
  op: Exclude<ReportFilterOp, "in" | "like">,
  value: string,
): SqlFragment {
  const instant = local.instant(tx);
  const tz = tx`${timezone}::text`;
  const start = localDayStart(tx, tx`(${value}::date)`, tz);
  const next = localDayStart(tx, tx`(${value}::date + 1)`, tz);
  switch (op) {
    case "eq":
      return tx`(${instant} >= ${start} and ${instant} < ${next})`;
    case "ne":
      return tx`(${instant} < ${start} or ${instant} >= ${next})`;
    case "lt":
      return tx`${instant} < ${start}`;
    case "lte":
      return tx`${instant} < ${next}`;
    case "gt":
      return tx`${instant} >= ${next}`;
    case "gte":
      return tx`${instant} >= ${start}`;
  }
}

/**
 * The run's company timezone, read once when a filter compiles to `localDateOf` bounds (any operator but `in` and
 * `like` on such a column), or `undefined` when none does. It runs on the run's own transaction, so RLS bounds the
 * read exactly as it bounds the statement; a company the caller cannot see reads no zone and the column falls
 * back to its unseekable `ref`, which then selects nothing either. The zone is handed to `datasetWhere` as a
 * value so the bound is a constant the planner can seek on (see `DatasetColumn.localDateOf`).
 */
export async function localTimezoneFor(
  tx: Sql,
  columns: readonly DatasetColumn[],
  filters: readonly DatasetFilter[],
  companyId: string,
): Promise<{ readonly timezone: string } | undefined> {
  const local = filters
    .filter((f) => f.op !== "in" && f.op !== "like")
    .map((f) => columns.find((c) => c.field === f.field)?.localDateOf)
    .find((l) => l !== undefined);
  if (local === undefined) return undefined;
  const [row] = await tx<{ tz: string | null }[]>`select ${local.timezone(tx, companyId)} as tz`;
  return row?.tz == null ? undefined : { timezone: row.tz };
}

/**
 * The `and …` tail of a dataset's WHERE clause, compiled from the dataset's OWN declared columns. A filter's
 * `field` selects a pre-authored fragment; its `value` is always a bound parameter; its `op` picks one of the
 * literal branches below. `id` is the dataset's id and appears in every message this raises. `local.timezone` is
 * the run's company timezone as `localTimezoneFor` read it, which a `localDateOf` column's bounds need; without
 * it such a column is compared through its `ref` (the same rows, unseekable).
 */
export function datasetWhere(
  tx: Sql,
  columns: readonly DatasetColumn[],
  filters: readonly DatasetFilter[],
  id = "unknown",
  local?: { readonly timezone: string },
): SqlFragment {
  let clause = tx``;
  for (const f of filters) {
    if (!REPORT_FILTER_OPS.includes(f.op)) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `filter operator '${String(f.op)}' is not one of ${REPORT_FILTER_OPS.join(", ")}`,
      );
    }
    const column = columnOf(id, columns, f.field, "filter");
    const ref = column.ref(tx);
    let predicate: SqlFragment;
    if (f.op === "in") {
      const values: readonly string[] =
        typeof f.value === "string" ? f.value.split(",") : [...f.value];
      if (values.length === 0) {
        throw new ReportError(
          "ERR_VALIDATION_FAILED",
          `filter field '${f.field}' with op 'in' has no values`,
        );
      }
      for (const v of values) assertValue(column.kind, v, column.field);
      predicate = anyOf(tx, ref, column.kind, values);
    } else if (typeof f.value !== "string") {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `filter field '${f.field}' with op '${f.op}' takes one value, not a list`,
      );
    } else if (f.op === "like") {
      predicate = tx`${ref}::text like ${likePrefix(f.value)}`;
    } else if (column.localDateOf !== undefined && local !== undefined) {
      assertValue(column.kind, f.value, column.field);
      predicate = localDateBound(tx, column.localDateOf, local.timezone, f.op, f.value);
    } else {
      assertValue(column.kind, f.value, column.field);
      const bound = scalar(tx, column.kind, f.value);
      predicate =
        f.op === "eq"
          ? tx`${ref} = ${bound}`
          : f.op === "ne"
            ? tx`${ref} <> ${bound}`
            : f.op === "lt"
              ? tx`${ref} < ${bound}`
              : f.op === "lte"
                ? tx`${ref} <= ${bound}`
                : f.op === "gt"
                  ? tx`${ref} > ${bound}`
                  : tx`${ref} >= ${bound}`;
    }
    clause = tx`${clause} and ${predicate}`;
  }
  return clause;
}

/** The ORDER BY list: the dataset's own sortable columns in the caller's order, or the dataset's default. */
export function datasetOrderBy(
  tx: Sql,
  columns: readonly DatasetColumn[],
  sort: readonly DatasetSortKey[],
  fallback: (tx: Sql) => SqlFragment,
  id = "unknown",
): SqlFragment {
  if (sort.length === 0) return fallback(tx);
  let clause = tx``;
  sort.forEach((key, i) => {
    const ref = columnOf(id, columns, key.field, "sort").ref(tx);
    // `asc` / `desc` are literal branches, so no direction token ever comes from data.
    const ordered = key.dir === "desc" ? tx`${ref} desc` : tx`${ref} asc`;
    clause = i === 0 ? ordered : tx`${clause}, ${ordered}`;
  });
  return clause;
}

/**
 * The one query shape every dataset shares. `select`, `from`, `company` and `defaultOrder` are literal
 * fragments authored in `datasets/*.ts`; `where`, `order by`, `limit` and `offset` are compiled from the
 * dataset's own declared columns. The statement runs on `tx` — a transaction from `withTenant`, so RLS is
 * already the outer gate (spec:2053) and the company predicate is the narrower, explicit one.
 */
export function defineDataset(spec: DatasetSpec): Dataset {
  return {
    id: spec.id,
    columns: spec.columns,
    async run(tx, params) {
      const limit = Math.min(Math.max(Math.trunc(params.limit), 1), MAX_DATASET_ROWS);
      const offset = Math.max(Math.trunc(params.offset), 0);
      if (spec.company !== null) assertValue("uuid", params.companyId, "companyId");
      const company = spec.company === null ? tx`true` : spec.company(tx, params.companyId);
      const local =
        spec.company === null
          ? undefined
          : await localTimezoneFor(tx, spec.columns, params.filters, params.companyId);
      const where = datasetWhere(tx, spec.columns, params.filters, spec.id, local);
      const order = datasetOrderBy(tx, spec.columns, params.sort, spec.defaultOrder, spec.id);
      const bound = params.rowBound === undefined ? tx`` : tx`and (${params.rowBound(tx)})`;
      const rows = await tx<DatasetRow[]>`
        select ${spec.select(tx)}
          from ${spec.from(tx)}
         where ${company} ${where} ${bound}
         order by ${order}
         limit ${limit} offset ${offset}`;
      return [...rows];
    },
  };
}

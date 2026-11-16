import type { LegacyPredicate } from "../legacy/predicate";
import {
  absentFromCatalogue,
  unreadable,
  type LegacyColumn,
  type LegacyColumnKind,
  type LegacyScalar,
  type SelectSpec,
} from "../legacy/types";

export interface RenderedStatement {
  readonly text: string;
  readonly params: readonly LegacyScalar[];
}

/**
 * How wide the `varchar` a column is cast to must be. `null` means "already text, or a blob; do not cast".
 *
 * Everything numeric and everything temporal is cast so the value reaches TypeScript as exact decimal text:
 * spec:99 forbids a float holding money "anywhere, including in TypeScript", and an ODBC driver returns
 * NUMERIC(18,4) as a JavaScript number and DATE as a Date in the process's local zone unless the query says
 * otherwise. 40 characters covers Firebird's widest NUMERIC(18,4) with sign and point; 24 covers
 * `YYYY-MM-DD HH:MM:SS.mmmm`; 20 covers a 64-bit integer with sign.
 */
export const CAST_WIDTH: Readonly<Record<LegacyColumnKind, number | null>> = {
  text: null,
  decimal: 40,
  float: 40,
  integer: 20,
  date: 24,
  timestamp: 24,
  time: 24,
  blob: null,
  other: 40,
};

const IDENT = /^[A-Z_$][A-Z0-9_$]{0,62}$/;

/**
 * Quote an identifier for Firebird dialect 3, having first proved it is one of a known set. Two gates, not one:
 * the shape test rejects anything that is not a bare identifier, and the membership test rejects a
 * well-formed name that is not a real column or table here. Neither is decoration — the second is what makes
 * a caller-supplied `LegacyPredicate.column` safe (ADR 0082).
 */
export function quoteIdent(name: string, allowed: ReadonlySet<string>): string {
  const upper = name.trim().toUpperCase();
  if (!IDENT.test(upper))
    throw unreadable(["identifier", name, "is not a bare Firebird identifier"].join(" "));
  if (!allowed.has(upper))
    throw absentFromCatalogue(
      ["identifier", name, "is not a declared column or table of this source"].join(" "),
    );
  return ['"', upper, '"'].join("");
}

/**
 * Statement text is assembled by pushing tokens into an array and joining them, never by interpolating an
 * identifier into a template literal beside a SQL keyword: `no-sql-concat` (0B, contracts §3.7.5) flags any
 * untagged template whose body carries both an interpolation and a keyword, and spec:100 forbids `+` outright.
 * The shape is deliberate as well as mechanical — a keyword and an identifier never meet in one expression,
 * so there is no place for a caller's string to become syntax.
 */
function projection(
  spec: SelectSpec,
  columns: readonly LegacyColumn[],
  names: ReadonlySet<string>,
): string {
  const wanted = spec.columns.length > 0 ? spec.columns : columns.map((c) => c.name);
  return wanted
    .map((requested) => {
      const quoted = quoteIdent(requested, names);
      const column = columns.find((c) => c.name === requested.trim().toUpperCase());
      if (!column)
        throw absentFromCatalogue(
          ["identifier", requested, "is not a declared column of", spec.table].join(" "),
        );
      const width = CAST_WIDTH[column.kind];
      const value =
        width === null ? quoted : ["cast(", quoted, " as varchar(", String(width), "))"].join("");
      return [value, "as", quoted].join(" ");
    })
    .join(", ");
}

const OPERATOR: Readonly<Record<"eq" | "ne" | "lt" | "lte" | "gt" | "gte", string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function condition(
  predicate: LegacyPredicate,
  names: ReadonlySet<string>,
  params: LegacyScalar[],
): string {
  if ("operands" in predicate) {
    if (predicate.operands.length === 0)
      throw unreadable(["an empty", predicate.op, "predicate has no meaning"].join(" "));
    const joiner = [" ", predicate.op, " "].join("");
    return ["(", predicate.operands.map((p) => condition(p, names, params)).join(joiner), ")"].join(
      "",
    );
  }
  const column = quoteIdent(predicate.column, names);
  switch (predicate.op) {
    case "is_null":
      return [column, "is null"].join(" ");
    case "is_not_null":
      return [column, "is not null"].join(" ");
    case "between":
      params.push(predicate.from, predicate.to);
      return [column, "between ? and ?"].join(" ");
    case "in": {
      if (predicate.values.length === 0)
        throw unreadable(["an empty in-list on", predicate.column, "has no meaning"].join(" "));
      for (const value of predicate.values) params.push(value);
      // The one token that carries its own leading space: `join("")` puts nothing between the quoted column
      // and the list, so the space lives inside the literal.
      return [column, " in (", predicate.values.map(() => "?").join(", "), ")"].join("");
    }
    default:
      params.push(predicate.value);
      return [column, OPERATOR[predicate.op], "?"].join(" ");
  }
}

function namesOf(columns: readonly LegacyColumn[], table: string): ReadonlySet<string> {
  return new Set([...columns.map((c) => c.name), table.trim().toUpperCase()]);
}

export function renderSelect(
  spec: SelectSpec,
  columns: readonly LegacyColumn[],
): RenderedStatement {
  const names = namesOf(columns, spec.table);
  const params: LegacyScalar[] = [];
  const parts = ["select", projection(spec, columns, names), "from", quoteIdent(spec.table, names)];
  if (spec.where) parts.push("where", condition(spec.where, names, params));
  if (spec.orderBy && spec.orderBy.length > 0)
    parts.push("order by", spec.orderBy.map((c) => quoteIdent(c, names)).join(", "));
  return { text: parts.join(" "), params };
}

export function renderCount(
  table: string,
  columns: readonly LegacyColumn[],
  where?: LegacyPredicate,
): RenderedStatement {
  const names = namesOf(columns, table);
  const params: LegacyScalar[] = [];
  const parts = [
    "select",
    'cast(count(*) as varchar(20)) as "N"',
    "from",
    quoteIdent(table, names),
  ];
  if (where) parts.push("where", condition(where, names, params));
  return { text: parts.join(" "), params };
}

export function renderMinMax(
  table: string,
  column: string,
  columns: readonly LegacyColumn[],
): RenderedStatement {
  const names = namesOf(columns, table);
  const quoted = quoteIdent(column, names);
  // min/max run on the NATIVE column and only the result is cast, so the ordering is the source's own and not
  // the lexicographic ordering of its text form. `dateRange` (§4.13.1) returns strings either way.
  const aggregate = [
    ["cast(min(", quoted, ') as varchar(24)) as "MIN_V"'].join(""),
    ["cast(max(", quoted, ') as varchar(24)) as "MAX_V"'].join(""),
  ].join(", ");
  return { text: ["select", aggregate, "from", quoteIdent(table, names)].join(" "), params: [] };
}

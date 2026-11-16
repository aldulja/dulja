import { D, type Decimal } from "../money/decimal";
import { MONEY_SCALE, QUANTITY_SCALE, round } from "../money/rounding";
import {
  NUMERIC_COLUMN_FORMATS,
  type ReportColumnFormat,
  type ReportFormat,
  type ReportLang,
  type ReportOrientation,
  type ReportPaper,
} from "./codes";
import type { Column, Group, ReportDefinition } from "./definition";
import type { ReportFormatters } from "./format";

/** One row a dataset returned. Amounts arrive as the decimal STRINGS postgres.js reads `numeric` as. */
export type ReportSourceRow = Readonly<Record<string, string | number | boolean | null>>;

export interface RenderedColumn {
  field: string;
  label: string;
  format: ReportColumnFormat;
  align: "start" | "end";
  width: number | null;
}
export interface RenderedCell {
  field: string;
  text: string;
  raw: string | number | boolean | null;
}
export interface RenderedRow {
  kind: "data" | "subtotal" | "total";
  /** 0 for a data row and for the grand total; 1-based group depth for a subtotal. */
  level: number;
  /** The group value a subtotal belongs to, e.g. "asset"; null on a data row and on the grand total. */
  label: string | null;
  cells: readonly RenderedCell[];
}
export interface RenderedReport {
  code: string;
  title: string;
  dir: "ltr" | "rtl";
  lang: ReportLang;
  format: ReportFormat;
  header: string;
  footer: string;
  paper: ReportPaper;
  orientation: ReportOrientation;
  /** LOGICAL order — never reversed for rtl; `dir` alone carries direction (spec:2253). */
  columns: readonly RenderedColumn[];
  rows: readonly RenderedRow[];
  /** Data rows only. */
  rowCount: number;
  /** The caller's clock, so a test can pin it. */
  generatedAt: string;
}
export interface RenderOptions {
  format: ReportFormat;
  lang: ReportLang;
  formatters: ReportFormatters;
  /** The run's parameter values, for `{name}` substitution in the header and footer. */
  parameters?: Readonly<Record<string, string>>;
  /** RFC 3339 UTC. Defaults to `new Date().toISOString()`; a test passes a fixed value. */
  generatedAt?: string;
}

type Raw = string | number | boolean | null;

/** The scale each column format aggregates at. Money is `numeric(19,4)`, quantity `numeric(19,6)`. */
const SCALE: Readonly<Record<ReportColumnFormat, number>> = {
  money: MONEY_SCALE,
  quantity: QUANTITY_SCALE,
  percent: QUANTITY_SCALE,
  integer: 0,
  text: 0,
  date: 0,
};

/**
 * Substitutes `{name}` from `values`, which `renderReport` fills with the run's parameters plus the four
 * built-ins `code`, `title`, `generatedAt` and `rowCount`. ONE pass over the template: `{{` and `}}` are
 * literal braces, and an unknown name renders as the empty string, because a decorative header must never
 * fail a render whose numbers are fine. Only the map's own keys count, so `{constructor}` is unknown too.
 */
export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    /\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (match, name: string | undefined) => {
      if (match === "{{") return "{";
      if (match === "}}") return "}";
      return name !== undefined && Object.hasOwn(values, name) ? (values[name] ?? "") : "";
    },
  );
}

function labelOf(column: Column, lang: ReportLang): string {
  return lang === "ar" ? column.labelAr : column.labelEn;
}

/** Formats the stored string; never re-computes it (spec:2041). */
function cellText(
  value: Raw,
  format: ReportColumnFormat,
  currency: string,
  f: ReportFormatters,
): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  const raw = String(value);
  switch (format) {
    case "money":
      return f.money({ amount: raw, currency });
    case "quantity":
      return f.quantity(raw);
    case "percent":
      return f.percent(raw);
    case "integer":
      return f.number(raw, { maximumFractionDigits: 0 });
    case "date":
      return f.date(raw);
    case "text":
      return raw;
  }
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** Raw-value comparison: locale-free, so sorting and grouping never depend on the reader's language. A
 *  numeric string compares numerically, in `Decimal`; anything else compares code unit by code unit. */
function compareRaw(a: Raw, b: Raw): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
  const x = String(a);
  const y = String(b);
  if (NUMERIC.test(x) && NUMERIC.test(y)) return new D(x).comparedTo(new D(y));
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The partition key of one group value. A null and the text "null" must not share a group, so a null is
 *  marked with a code point no dataset value carries, spelled as an escape so this file stays plain text. */
const GROUP_KEY_NULL = "\u0000";
const groupKey = (value: Raw | undefined): string =>
  value === null || value === undefined ? GROUP_KEY_NULL : `${typeof value}:${String(value)}`;

interface Aggregate {
  sum: Decimal;
  count: number;
}

/** A `count` counts non-null values of any kind and never parses them, so a count over a text column
 *  (a code, a name) is legal; only `sum` and `avg` read the values as numbers. */
function aggregateOf(
  rows: readonly ReportSourceRow[],
  field: string,
  fn: "sum" | "count" | "avg",
): Aggregate {
  let sum = new D(0);
  let count = 0;
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    count += 1;
    if (fn === "count" || typeof value === "boolean") continue;
    sum = sum.plus(new D(String(value)));
  }
  return { sum, count };
}

/** `sum` is exact; `count` is an integer; `avg` divides and rounds HALF_EVEN at the column's scale — a
 *  stated mode, because §4.2.1 forbids implicit rounding anywhere money is involved. */
function aggregateValue(
  fn: "sum" | "count" | "avg",
  agg: Aggregate,
  format: ReportColumnFormat,
): string | number {
  if (fn === "count") return agg.count;
  const scale = SCALE[format];
  if (fn === "sum") return agg.sum.toFixed(scale);
  if (agg.count === 0) return new D(0).toFixed(scale);
  return round(agg.sum.div(agg.count), scale, "HALF_EVEN").toFixed(scale);
}

interface Context {
  readonly definition: ReportDefinition;
  readonly currency: string;
  readonly f: ReportFormatters;
  readonly lang: ReportLang;
}

function aggregateRow(
  kind: "subtotal" | "total",
  level: number,
  label: string | null,
  rows: readonly ReportSourceRow[],
  ctx: Context,
): RenderedRow {
  const byField = new Map(ctx.definition.totals.map((t) => [t.field, t.fn]));
  const cells = ctx.definition.columns.map((column): RenderedCell => {
    const fn = byField.get(column.field);
    if (fn === undefined) return { field: column.field, text: "", raw: null };
    const raw = aggregateValue(fn, aggregateOf(rows, column.field, fn), column.format);
    const format = fn === "count" ? "integer" : column.format;
    return { field: column.field, text: cellText(raw, format, ctx.currency, ctx.f), raw };
  });
  // The label rides in the first column, which is where a reader looks for it in both directions — unless
  // that column carries an aggregate of its own, which is never overwritten.
  const first = cells[0];
  if (first !== undefined && !byField.has(first.field)) {
    const value = label ?? "";
    const text =
      kind === "total"
        ? ctx.lang === "ar"
          ? "الإجمالي"
          : "Total"
        : ctx.lang === "ar"
          ? `مجموع ${value}`
          : `Subtotal ${value}`;
    cells[0] = { field: first.field, text, raw: text };
  }
  return { kind, level, label, cells };
}

function dataRow(row: ReportSourceRow, ctx: Context): RenderedRow {
  return {
    kind: "data",
    level: 0,
    label: null,
    cells: ctx.definition.columns.map((column) => {
      const raw = row[column.field] ?? null;
      return { field: column.field, text: cellText(raw, column.format, ctx.currency, ctx.f), raw };
    }),
  };
}

/**
 * Emits one group level: a stable partition of `rows` on the raw value of `groups[depth]`, in
 * first-appearance order after the sort; each bucket's inner levels (or its data rows), then — when the group
 * is marked `subtotal` — that bucket's subtotal at level `depth + 1`. Recursing per level is what makes an
 * outer subtotal cover every inner bucket it contains, so with nested subtotals the inner one comes first.
 */
function emitLevel(
  rows: readonly ReportSourceRow[],
  groups: readonly Group[],
  depth: number,
  ctx: Context,
  out: RenderedRow[],
): void {
  const group = groups[depth];
  if (group === undefined) {
    for (const row of rows) out.push(dataRow(row, ctx));
    return;
  }
  const buckets = new Map<string, ReportSourceRow[]>();
  for (const row of rows) {
    const key = groupKey(row[group.field]);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }
  for (const bucket of buckets.values()) {
    emitLevel(bucket, groups, depth + 1, ctx, out);
    if (group.subtotal && ctx.definition.totals.length > 0) {
      const value = bucket[0]?.[group.field];
      const label = value === null || value === undefined ? "" : String(value);
      out.push(aggregateRow("subtotal", depth + 1, label, bucket, ctx));
    }
  }
}

/**
 * The pure layout of §4.11.2: dataset rows in, a `RenderedReport` out — sorted, grouped, subtotalled,
 * totalled, formatted and direction-aware. It reads the strings a dataset returned and formats them; it
 * never re-computes a stored amount (spec:2041). Column order stays logical in both directions.
 */
export function renderReport(
  definition: ReportDefinition,
  rows: readonly ReportSourceRow[],
  opts: RenderOptions,
): RenderedReport {
  const { lang, formatters: f } = opts;
  const currency = definition.columns.some((c) => c.format === "money")
    ? String(rows.find((r) => typeof r["currency"] === "string")?.["currency"] ?? "")
    : "";
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const ctx: Context = { definition, currency, f, lang };

  // 1. sort — every key is a field of the dataset's rows (assertDefinitionFields proved it; a key need not be
  //    a displayed column), compared on the raw value; `toSorted` is stable, so equal keys keep the dataset's
  //    own order
  const ordered = rows.toSorted((a, b) => {
    for (const key of definition.sort) {
      const c = compareRaw(a[key.field] ?? null, b[key.field] ?? null);
      if (c !== 0) return key.dir === "desc" ? -c : c;
    }
    return 0;
  });

  // 2. group, subtotal and emit; 3. one grand total
  const out: RenderedRow[] = [];
  emitLevel(ordered, definition.groups, 0, ctx, out);
  if (definition.totals.length > 0 && ordered.length > 0) {
    out.push(aggregateRow("total", 0, null, ordered, ctx));
  }

  const title = lang === "ar" ? definition.nameAr : definition.nameEn;
  const values: Record<string, string> = {
    ...opts.parameters,
    code: definition.code,
    title,
    generatedAt,
    rowCount: String(ordered.length),
  };

  return {
    code: definition.code,
    title,
    dir: lang === "ar" ? "rtl" : "ltr",
    lang,
    format: opts.format,
    header: interpolate(definition.layout.header, values),
    footer: interpolate(definition.layout.footer, values),
    paper: definition.layout.paper,
    orientation: definition.layout.orientation,
    columns: definition.columns.map((column) => ({
      field: column.field,
      label: labelOf(column, lang),
      format: column.format,
      align: column.align,
      width: column.width ?? null,
    })),
    rows: out,
    rowCount: ordered.length,
    generatedAt,
  };
}

const CSV_NEEDS_QUOTE = /[",\r\n]/;
const csvField = (value: string): string =>
  CSV_NEEDS_QUOTE.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** OWASP "CSV Injection": the leading characters a spreadsheet reads as the start of a formula. */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A cell a spreadsheet would evaluate is prefixed with `'`, which Excel and its kin read as "this is text".
 * Only a numeric column's plain decimal literal is exempt — a negative amount is the figure itself, never a
 * formula, and spec:2041 forbids touching it. A text cell, a header label (a cloned definition's labels are
 * user-entered) and anything in a numeric column that is not a plain literal are all neutralised.
 */
function csvSafe(value: string, format: ReportColumnFormat | null): string {
  if (!CSV_FORMULA_LEAD.test(value)) return value;
  if (format !== null && NUMERIC_COLUMN_FORMATS.includes(format) && NUMERIC.test(value)) {
    return value;
  }
  return `'${value}`;
}

/** U+FEFF, spelled as an escape so no source file carries an invisible character. */
const BOM = "﻿";

/**
 * RFC 4180: CRLF endings, `"` doubled inside a quoted field. A CSV carries the RAW decimal string, never a
 * locale-formatted one — it is machine-read, and spec:1246's "diffable" applies to output too; a subtotal or
 * total row's label cell is its raw value too. The BOM is opt-in: Excel needs it to sniff UTF-8 Arabic, and a
 * strict parser must not be handed one uninvited. Because this file is meant to open in a spreadsheet, a cell
 * that would start a formula is neutralised (`csvSafe`); 7C's tenant export is the machine-readable path and
 * writes its own raw CSV (ADR 0069).
 */
export function renderCsv(report: RenderedReport, opts: { bom?: boolean } = {}): string {
  const lines: string[] = [report.columns.map((c) => csvField(csvSafe(c.label, null))).join(",")];
  for (const row of report.rows) {
    lines.push(
      row.cells
        .map((cell, i) =>
          csvField(
            cell.raw === null ? "" : csvSafe(String(cell.raw), report.columns[i]?.format ?? null),
          ),
        )
        .join(","),
    );
  }
  return `${opts.bom === true ? BOM : ""}${lines.join("\r\n")}\r\n`;
}

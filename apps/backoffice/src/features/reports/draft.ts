/**
 * The designer's working copy of a report definition (7A T15) and its way back to the wire.
 *
 * What a user may change is the owner-authorized default for OD-24 item 4 (2026-11-06): everything §4.11.1's
 * format carries that is presentation — the two titles; each column's labels, order, visibility, width, format and
 * alignment; the sort; the groups and their subtotals; the totals; the page's orientation, paper, header and
 * footer. The dataset, its filters, the parameters, the permission, the module, the code and the tie-out are never
 * edited here: they decide WHAT a report reads and who may read it, and a definition never carries SQL (test 27).
 * Every untouched member of the stored definition is sent back exactly as it came.
 */

export const COLUMN_FORMATS = ["text", "money", "quantity", "date", "integer", "percent"] as const;
export const ALIGNS = ["start", "end"] as const;
export const TOTAL_FNS = ["sum", "count", "avg"] as const;
export const SORT_DIRS = ["asc", "desc"] as const;
export const ORIENTATIONS = ["portrait", "landscape"] as const;
export const PAPERS = ["A4", "A5", "receipt"] as const;

export interface DraftColumn {
  field: string;
  labelEn: string;
  labelAr: string;
  format: (typeof COLUMN_FORMATS)[number];
  align: (typeof ALIGNS)[number];
  /** As typed; empty means "no width", which the renderers size themselves. */
  width: string;
  /** A hidden column is left out of the saved definition; it stays here so it can be shown again. */
  shown: boolean;
}

export interface Draft {
  nameEn: string;
  nameAr: string;
  columns: DraftColumn[];
  groups: { field: string; subtotal: boolean }[];
  totals: { field: string; fn: (typeof TOTAL_FNS)[number] }[];
  sort: { field: string; dir: (typeof SORT_DIRS)[number] }[];
  layout: {
    orientation: (typeof ORIENTATIONS)[number];
    paper: (typeof PAPERS)[number];
    header: string;
    footer: string;
  };
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

function column(raw: Json, shown: boolean): DraftColumn {
  return {
    field: text(raw["field"]),
    labelEn: text(raw["labelEn"]),
    labelAr: text(raw["labelAr"]),
    format: oneOf(COLUMN_FORMATS, raw["format"], "text"),
    align: oneOf(ALIGNS, raw["align"], "start"),
    width: typeof raw["width"] === "number" ? String(raw["width"]) : "",
    shown,
  };
}

/**
 * The working copy. `source` is the definition this one was cloned from, when there is one: its columns that this
 * copy has dropped come back as hidden rows, so a column hidden and saved can be shown again later.
 */
export function toDraft(definition: Json, source?: Json): Draft {
  const columns = list(definition["columns"]).map((raw) => column(raw, true));
  const present = new Set(columns.map((c) => c.field));
  for (const raw of list(source?.["columns"]))
    if (!present.has(text(raw["field"]))) {
      columns.push(column(raw, false));
      present.add(text(raw["field"]));
    }
  const layout = record(definition["layout"]);
  return {
    nameEn: text(definition["nameEn"]),
    nameAr: text(definition["nameAr"]),
    columns,
    groups: list(definition["groups"]).map((g) => ({
      field: text(g["field"]),
      subtotal: g["subtotal"] === true,
    })),
    totals: list(definition["totals"]).map((g) => ({
      field: text(g["field"]),
      fn: oneOf(TOTAL_FNS, g["fn"], "sum"),
    })),
    sort: list(definition["sort"]).map((g) => ({
      field: text(g["field"]),
      dir: oneOf(SORT_DIRS, g["dir"], "asc"),
    })),
    layout: {
      orientation: oneOf(ORIENTATIONS, layout["orientation"], "portrait"),
      paper: oneOf(PAPERS, layout["paper"], "A4"),
      header: text(layout["header"]),
      footer: text(layout["footer"]),
    },
  };
}

/**
 * The definition a save sends: the stored one with the designer's members replaced. `columnIndex[i]` is the
 * draft row the saved column `i` came from, so an error the API reports at `/columns/i/…` lands on that row.
 */
export function fromDraft(
  definition: Json,
  draft: Draft,
): { definition: Json; columnIndex: number[] } {
  const columnIndex: number[] = [];
  const columns: Json[] = [];
  draft.columns.forEach((c, index) => {
    if (!c.shown) return;
    columnIndex.push(index);
    const width = c.width.trim();
    columns.push({
      field: c.field,
      labelEn: c.labelEn,
      labelAr: c.labelAr,
      format: c.format,
      align: c.align,
      // Digits become the integer §4.11.1 wants; anything else is sent as typed, so the API names the fault.
      ...(width === "" ? {} : { width: /^\d+$/.test(width) ? Number.parseInt(width, 10) : width }),
    });
  });
  return {
    definition: {
      ...definition,
      nameEn: draft.nameEn,
      nameAr: draft.nameAr,
      columns,
      groups: draft.groups.map((g) => ({ field: g.field, subtotal: g.subtotal })),
      totals: draft.totals.map((g) => ({ field: g.field, fn: g.fn })),
      sort: draft.sort.map((g) => ({ field: g.field, dir: g.dir })),
      layout: { ...record(definition["layout"]), ...draft.layout },
    },
    columnIndex,
  };
}

/**
 * The API's `errors[]` re-keyed onto the draft: `/columns/{saved}/…` becomes `/columns/{draft row}/…`. Every
 * other pointer is kept as it is; the screen shows each beside its field, and lists any it has no field for.
 */
export function draftErrors(
  errors: ReadonlyMap<string, string>,
  columnIndex: readonly number[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, message] of errors) {
    const match = /^\/columns\/(\d+)(\/.*)?$/.exec(path);
    const row = match ? columnIndex[Number.parseInt(match[1]!, 10)] : undefined;
    out.set(match && row !== undefined ? `/columns/${row}${match[2] ?? ""}` : path, message);
  }
  return out;
}

/** Moves one entry of a list by `delta`, clamped to the list. */
export function move<T>(items: readonly T[], index: number, delta: number): T[] {
  const to = Math.min(Math.max(index + delta, 0), items.length - 1);
  if (to === index) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

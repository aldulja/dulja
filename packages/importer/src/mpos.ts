import { moduleOf } from "./legacy/modules";
import type { LegacyReader } from "./reader";

/**
 * The two shipped POS databases. `mpos` is "a deliberately separate schema" (analysis §4.3), so they are a second
 * connection (`--mpos-dsn`), never a second table list on the first.
 */
export const MPOS_MODULE_IDS = ["mposstandard", "mpossystem"] as const;

/** Membership in the shipped map decides — never the `pos` prefix, which a customisation may also carry. */
export function isMposTable(table: string): boolean {
  const module = moduleOf(table);
  return module !== undefined && (MPOS_MODULE_IDS as readonly string[]).includes(module.id);
}

export interface MposDecisionReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly present: boolean;
  readonly tables: readonly {
    table: string;
    rows: number;
    dateRange: { min: string | null; max: string | null } | null;
  }[];
  readonly ticketRows: number;
  readonly ticketDateRange: { min: string | null; max: string | null } | null;
  /** Part VII #10, verbatim. */
  readonly question: string;
  /** Always null. Contracts hazard 7: a plan needing a decision writes the input and stops. */
  readonly answer: null;
}

const QUESTION = [
  "Must historical POS data migrate? The POS application itself is being rebuilt. The open question is whether",
  "past tickets in the old mpos schema need to come across, or whether the new POS starts clean at cut-over",
  "with only the catalogue. Starting clean is far cheaper; confirm it is acceptable. (spec:2474, Part VII #10, OD-16)",
].join(" ");

/**
 * OD-16's input: the depth and volume of the legacy till history, with the question restated and no
 * recommendation attached. `source` is left empty — §4.13.1's reader carries none — and the CLI, which holds the
 * driver, fills it with one spread.
 */
export async function mposDecision(reader: LegacyReader): Promise<MposDecisionReport> {
  const names = (await reader.tables()).filter(isMposTable).toSorted();
  const tables: {
    table: string;
    rows: number;
    dateRange: { min: string | null; max: string | null } | null;
  }[] = [];
  for (const table of names) {
    const rows = await reader.count(table);
    let dateRange: { min: string | null; max: string | null } | null = null;
    if (rows > 0) {
      try {
        dateRange = await reader.dateRange(table, "DATE");
      } catch {
        // No DATE column on this table: its range is unknown, not empty.
        dateRange = null;
      }
    }
    tables.push({ table, rows, dateRange });
  }
  const tickets = tables.find((t) => t.table === "POSTICKETS");
  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: "",
    present: tables.some((t) => t.rows > 0),
    tables,
    ticketRows: tickets?.rows ?? 0,
    ticketDateRange: tickets?.dateRange ?? null,
    question: QUESTION,
    answer: null,
  };
}

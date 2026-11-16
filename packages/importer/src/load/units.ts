import type { Sql } from "postgres";
import { createUnit } from "@dulja/db";
import type { LegacyRow } from "../legacy/types";
import { placeByCode } from "./master";
import { optionalText, requireText } from "./scalar";
import type { LoadContext, Loader, SourceColumn } from "./types";

interface UnitTarget {
  legacyKey: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}

/** Every column is a hypothesis until OD-17 reads the live catalogue (9B Task 14). The prefixed spelling is the
 *  dossier's (analysis §3.1: "a per-table `Prefix` is prepended to every physical column name"). */
const COLUMNS: readonly SourceColumn[] = [
  {
    name: "UNTID",
    required: true,
    confidence: "hypothesis",
    note: "the unit's own key; Units carries the prefix UNT (dossier §3.1: a per-table Prefix is prepended to every physical column name)",
  },
  {
    name: "UNTNAME",
    required: true,
    confidence: "hypothesis",
    note: "the unit's display name, which becomes both code and name_en",
  },
  {
    name: "UNTNOTE",
    required: false,
    confidence: "hypothesis",
    note: "free text; carried to name_ar when present, because the legacy schema names no second name column",
  },
];

/**
 * 9B plan N14 — one stable code from a free-text legacy name, shared by the unit, warehouse and item loaders so the
 * three never disagree: upper case, every run of characters outside `A-Z0-9` becomes one `-`, no leading or trailing
 * `-`, at most 32 characters. `Piece` → `PIECE`, `Main store` → `MAIN-STORE`. A name with no ASCII letter or digit (an
 * Arabic-only name) gives `""`, which every caller reports as a skip. The name itself is kept verbatim in `name_en`.
 */
export function codeFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** `UNITS` → `app.unit_of_measure`, through 3A's `createUnit`. Source key: the bare `UNTID`. */
export const unitLoader: Loader<LegacyRow, UnitTarget> = {
  sourceTable: "UNITS",
  targetTable: "unit_of_measure",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "UNTID", "UNITS"),

  map(row) {
    const legacyKey = requireText(row, "UNTID", "UNITS");
    const nameEn = requireText(row, "UNTNAME", `UNITS/${legacyKey}`);
    const code = codeFromName(nameEn);
    if (code === "")
      return {
        skip: `unit ${legacyKey} has a name with no letter or digit in A-Z0-9; it cannot produce a code`,
      };
    return { legacyKey, code, nameEn, nameAr: optionalText(row, "UNTNOTE") };
  },

  async load(tx: Sql, ctx: LoadContext, rows: UnitTarget[]) {
    return placeByCode(tx, ctx, "unit_of_measure", rows, {
      async find(_row, code) {
        const [found] = await tx<{ id: string }[]>`
          select id from app.unit_of_measure where company_id = ${ctx.companyId} and code = ${code}`;
        return found?.id ?? null;
      },
      async create(row, code) {
        const made = await createUnit(tx, {
          companyId: ctx.companyId,
          code,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
        });
        return made.id;
      },
    });
  },
};

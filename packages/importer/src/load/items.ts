import type { Sql } from "postgres";
import { createItem, ItemAccountUnresolvedError } from "@dulja/db";
import type { LegacyRow } from "../legacy/types";
import { placeByCode } from "./master";
import { flagOf, optionalText, requireText } from "./scalar";
import { codeFromName } from "./units";
import {
  LoadError,
  type LoadContext,
  type Loader,
  type RefResolver,
  type SourceColumn,
} from "./types";

interface ItemTarget {
  legacyKey: string;
  /** `MATCODE` verbatim — `item.legacy_ref` (0101: "the source system's material code"), null when the row has none. */
  legacyCode: string | null;
  code: string;
  nameEn: string;
  nameAr: string | null;
  kind: "product" | "service";
  trackLots: boolean;
  baseUnitId: string;
}

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "MATID",
    required: true,
    confidence: "hypothesis",
    note: "the material's own key (Materials, prefix MAT)",
  },
  {
    name: "MATCODE",
    required: false,
    confidence: "hypothesis",
    note: "the customer's own item code → item.code (normalised) and item.legacy_ref (verbatim); the name when absent",
  },
  { name: "MATNAME", required: true, confidence: "hypothesis", note: "display name → name_en" },
  {
    name: "MATNAMEAR",
    required: false,
    confidence: "hypothesis",
    note: "Arabic display name → name_ar; Materials has ~70 columns and a second name is likely one of them",
  },
  {
    name: "MATUNIT",
    required: true,
    confidence: "hypothesis",
    note: "the base unit's Units key; resolved through import_batch to unit_of_measure",
  },
  {
    name: "MATISSERVICE",
    required: false,
    confidence: "hypothesis",
    note: "flag → item.kind service | product; absent or NULL means a product",
  },
  {
    name: "MATISBATCH",
    required: false,
    confidence: "hypothesis",
    note: "flag (the dossier's IsBatched) → track_lots; absent or NULL means true, Dulja's own default",
  },
];

/**
 * `MATERIALS` → `app.item`, through 3A's `createItem`, which resolves the four §4.6.1 account defaults
 * (`4000`/`1300`/`5000`/`5900`; a service gets `4000` and `5900` only) and refuses a missing one by name (hazard 33).
 * Source key: the bare `MATID` — what Task 6's `refs.byLegacyRef("item", …)` passes. A service never tracks lots.
 */
export const itemLoader: Loader<LegacyRow, ItemTarget> = {
  sourceTable: "MATERIALS",
  targetTable: "item",
  dependsOn: ["unit_of_measure"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "MATID", "MATERIALS"),

  async map(row, refs: RefResolver) {
    const legacyKey = requireText(row, "MATID", "MATERIALS");
    const site = `MATERIALS/${legacyKey}`;
    const nameEn = requireText(row, "MATNAME", site);
    const legacyCode = optionalText(row, "MATCODE");
    const code = codeFromName(legacyCode ?? nameEn);
    if (code === "") return { skip: `material ${legacyKey} produces no usable item code` };
    const unitKey = requireText(row, "MATUNIT", site);
    const baseUnitId = await refs.byLegacyRef("unit_of_measure", unitKey);
    if (!baseUnitId)
      return {
        skip: `material ${legacyKey} references unit ${unitKey}, which has no imported unit_of_measure; the item is an orphan (LEGACY-073)`,
      };
    const kind = flagOf(row, "MATISSERVICE", site) === true ? "service" : "product";
    return {
      legacyKey,
      legacyCode,
      code,
      nameEn,
      nameAr: optionalText(row, "MATNAMEAR"),
      kind,
      trackLots: kind === "product" && (flagOf(row, "MATISBATCH", site) ?? true),
      baseUnitId,
    };
  },

  async load(tx: Sql, ctx: LoadContext, rows: ItemTarget[]) {
    return placeByCode(tx, ctx, "item", rows, {
      async find(_row, code) {
        const [found] = await tx<{ id: string }[]>`
          select id from app.item where company_id = ${ctx.companyId} and code = ${code}`;
        return found?.id ?? null;
      },
      async mismatch(row, existingId) {
        const [held] = await tx<
          { base_unit_id: string; unit_code: string; kind: string; track_lots: boolean }[]
        >`
          select i.base_unit_id, u.code as unit_code, i.kind, i.track_lots
            from app.item i join app.unit_of_measure u on u.id = i.base_unit_id
           where i.id = ${existingId}`;
        if (!held) return null;
        if (held.base_unit_id !== row.baseUnitId) {
          const [wanted] = await tx<{ code: string }[]>`
            select code from app.unit_of_measure where id = ${row.baseUnitId}`;
          return `its base unit is ${held.unit_code} and the legacy material's is ${wanted?.code ?? row.baseUnitId} (every opening quantity would be booked in the wrong unit)`;
        }
        if (held.kind !== row.kind)
          return `it is a ${held.kind} and the legacy material is a ${row.kind}`;
        if (held.track_lots !== row.trackLots)
          return `it ${held.track_lots ? "tracks" : "does not track"} lots and the legacy material ${row.trackLots ? "does" : "does not"}`;
        return null;
      },
      async create(row, code) {
        try {
          const made = await createItem(tx, ctx, {
            companyId: ctx.companyId,
            code,
            nameEn: row.nameEn,
            nameAr: row.nameAr,
            kind: row.kind,
            baseUnitId: row.baseUnitId,
            trackLots: row.trackLots,
            legacyRef: row.legacyCode,
          });
          return made.id;
        } catch (cause) {
          // A chart without 0C's defaults is run configuration, not a row's fault: refuse the run, naming the code.
          if (cause instanceof ItemAccountUnresolvedError)
            throw new LoadError("ERR_VALIDATION_FAILED", cause.message);
          throw cause;
        }
      },
    });
  },
};

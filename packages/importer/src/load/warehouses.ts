import type { Sql } from "postgres";
import { createWarehouse } from "@dulja/db";
import type { LegacyRow } from "../legacy/types";
import { openingBranchId } from "./document";
import { placeByCode } from "./master";
import { optionalText, requireText } from "./scalar";
import { codeFromName } from "./units";
import { type LoadContext, type Loader, type SourceColumn } from "./types";

interface WarehouseTarget {
  legacyKey: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
}

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "WARID",
    required: true,
    confidence: "hypothesis",
    note: "the warehouse's own key (Warehouses, prefix WAR)",
  },
  {
    name: "WARNAME",
    required: true,
    confidence: "hypothesis",
    note: "display name → code and name_en",
  },
  { name: "WARNOTE", required: false, confidence: "hypothesis", note: "free text → name_ar" },
];

/**
 * `WAREHOUSES` → `app.warehouse` (kind `stock`), through 3A's `createWarehouse`. Source key: the bare `WARID`.
 *
 * Every imported warehouse lands in the company's HEAD-OFFICE BRANCH, because the legacy schema has no branch concept
 * that maps onto Dulja's BRANCH dimension (dossier §0.4: `Site` is a replication partition, `Job` a project), and
 * inventing a branch per warehouse would put stock behind a `branch_isolation` policy nobody can see through
 * (§4.5.6 Form A″). `branch_id` is immutable on a warehouse (`updateWarehouse`, SAH-045), so re-homing a warehouse after
 * cut-over is an archive and a new warehouse with a transfer — the cut-over runbook (Task 10) must say so.
 */
export const warehouseLoader: Loader<LegacyRow, WarehouseTarget> = {
  sourceTable: "WAREHOUSES",
  targetTable: "warehouse",
  dependsOn: [],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "WARID", "WAREHOUSES"),

  map(row) {
    const legacyKey = requireText(row, "WARID", "WAREHOUSES");
    const nameEn = requireText(row, "WARNAME", `WAREHOUSES/${legacyKey}`);
    const code = codeFromName(nameEn);
    if (code === "")
      return {
        skip: `warehouse ${legacyKey} has a name with no letter or digit in A-Z0-9; it cannot produce a code`,
      };
    return { legacyKey, code, nameEn, nameAr: optionalText(row, "WARNOTE") };
  },

  async load(tx: Sql, ctx: LoadContext, rows: WarehouseTarget[]) {
    const hq = await openingBranchId(
      tx,
      ctx.companyId,
      "every imported warehouse lands in the head office",
    );
    return placeByCode(tx, ctx, "warehouse", rows, {
      async find(_row, code) {
        const [found] = await tx<{ id: string }[]>`
          select id from app.warehouse where company_id = ${ctx.companyId} and code = ${code}`;
        return found?.id ?? null;
      },
      async mismatch(_row, existingId) {
        const [held] = await tx<{ kind: string; branch_id: string }[]>`
          select kind, branch_id from app.warehouse where id = ${existingId}`;
        if (!held) return null;
        if (held.kind !== "stock") return `it is a ${held.kind} warehouse, not a stock warehouse`;
        if (held.branch_id !== hq)
          return "it belongs to a branch other than the head office, where every imported warehouse lands";
        return null;
      },
      async create(row, code) {
        const made = await createWarehouse(tx, {
          companyId: ctx.companyId,
          code,
          nameEn: row.nameEn,
          nameAr: row.nameAr,
          kind: "stock",
          branchId: hq,
        });
        return made.id;
      },
    });
  },
};

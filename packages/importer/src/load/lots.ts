import type { Sql } from "postgres";
import { createLot, SENTINEL_LOT_CODE } from "@dulja/db";
import type { LegacyRow } from "../legacy/types";
import { placeByCode } from "./master";
import { optionalDateOf, requireText } from "./scalar";
import type { LoadContext, Loader, RefResolver, SourceColumn } from "./types";

interface LotTarget {
  legacyKey: string;
  itemId: string;
  code: string;
  expiresOn: string | null;
  manufacturedOn: string | null;
}

const COLUMNS: readonly SourceColumn[] = [
  {
    name: "BATID",
    required: true,
    confidence: "hypothesis",
    note: "the batch's own key (MatBatches, prefix BAT)",
  },
  {
    name: "BATMAT",
    required: true,
    confidence: "hypothesis",
    note: "the Materials key this batch belongs to",
  },
  {
    name: "BATCODE",
    required: true,
    confidence: "hypothesis",
    note: "the batch number the warehouse reads off the carton → lot.code and lot.legacy_ref",
  },
  {
    name: "BATEXPIRY",
    required: false,
    confidence: "hypothesis",
    note: "expiry date → lot.expires_on; the whole reason spec:1054's expiry write-off exists",
  },
  {
    name: "BATMFG",
    required: false,
    confidence: "hypothesis",
    note: "manufacture date → lot.manufactured_on",
  },
];

/**
 * `MATBATCHES` → `app.lot`, through 3A's `createLot`. Source key: the bare `BATID` — what Task 6's
 * `refs.byLegacyRef("lot", …)` passes. `lot.code` is `BATCODE` as printed (no `codeFromName`: a batch number is read
 * off a carton and must match it), and `lot.legacy_ref` carries the same string (0101: "the source system's batch
 * code"). A batch whose material was not imported is an orphan and is REPORTED (SAH-073), never given a null item.
 */
export const lotLoader: Loader<LegacyRow, LotTarget> = {
  sourceTable: "MATBATCHES",
  targetTable: "lot",
  dependsOn: ["item"],
  sourceColumns: COLUMNS,
  sourceKey: (row) => requireText(row, "BATID", "MATBATCHES"),

  async map(row, refs: RefResolver) {
    const legacyKey = requireText(row, "BATID", "MATBATCHES");
    const site = `MATBATCHES/${legacyKey}`;
    const materialKey = requireText(row, "BATMAT", site);
    const code = requireText(row, "BATCODE", site);
    // ADR 0034: every item already owns a lot coded NONE, the sentinel `applyMovements` resolves an unlotted line to.
    // Adopting it would merge a real batch into "no batch" and lose its expiry from FEFO.
    if (code.toUpperCase() === SENTINEL_LOT_CODE)
      return {
        skip: `batch ${legacyKey} is coded ${SENTINEL_LOT_CODE}, the code Dulja reserves for every item's sentinel lot (ADR 0034); rename the batch in the source`,
      };
    const itemId = await refs.byLegacyRef("item", materialKey);
    if (!itemId)
      return {
        skip: `material ${materialKey} has no imported item; the batch is an orphan (SAH-073)`,
      };
    const expiresOn = optionalDateOf(row, "BATEXPIRY", site);
    const manufacturedOn = optionalDateOf(row, "BATMFG", site);
    // `lot_expiry_after_manufacture_check` (0029) would refuse the whole page; the row is reported instead.
    if (expiresOn !== null && manufacturedOn !== null && expiresOn < manufacturedOn)
      return {
        skip: `batch ${legacyKey} expires on ${expiresOn}, before it was made on ${manufacturedOn}; correct one date in the source`,
      };
    return { legacyKey, itemId, code, expiresOn, manufacturedOn };
  },

  async load(tx: Sql, ctx: LoadContext, rows: LotTarget[]) {
    return placeByCode(tx, ctx, "lot", rows, {
      async find(row, code) {
        const [found] = await tx<{ id: string }[]>`
          select id from app.lot where item_id = ${row.itemId} and code = ${code}`;
        return found?.id ?? null;
      },
      async create(row, code) {
        const made = await createLot(tx, {
          companyId: ctx.companyId,
          itemId: row.itemId,
          code,
          expiresOn: row.expiresOn,
          manufacturedOn: row.manufacturedOn,
          legacyRef: row.code,
        });
        return made.id;
      },
    });
  },
};

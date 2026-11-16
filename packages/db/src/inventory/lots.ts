import type { Sql } from "postgres";
import { Quantity } from "@dulja/domain";

/** ADR 0034. The ONE spelling of the sentinel code; no plan re-types the literal. */
export const SENTINEL_LOT_CODE = "NONE";

export interface LotRow {
  id: string;
  companyId: string;
  itemId: string;
  code: string;
  expiresOn: string | null;
  manufacturedOn: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** The two `date` columns are selected `::text`: postgres.js parses a bare `date` into a JavaScript `Date`
 *  at UTC midnight, which is neither the `string` this row type promises nor the `YYYY-MM-DD` the contract's
 *  `DateSchema` requires (`expiry.ts` casts `expires_on::text` for the same reason). */
interface DbLot {
  id: string;
  company_id: string;
  item_id: string;
  code: string;
  expires_on: string | null;
  manufactured_on: string | null;
  archived_at: string | null;
  created_at: string;
}

const toLot = (r: DbLot): LotRow => ({
  id: r.id,
  companyId: r.company_id,
  itemId: r.item_id,
  code: r.code,
  expiresOn: r.expires_on,
  manufacturedOn: r.manufactured_on,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
});

export async function createLot(
  tx: Sql,
  input: {
    companyId: string;
    itemId: string;
    code: string;
    expiresOn?: string | null;
    manufacturedOn?: string | null;
    /** 9B — the source system's own batch code (0101, §5.1 #8), set once by the cut-over importer. */
    legacyRef?: string | null;
  },
): Promise<LotRow> {
  const [row] = await tx<DbLot[]>`
    insert into app.lot (tenant_id, company_id, item_id, code, expires_on, manufactured_on, legacy_ref)
    values (app.current_tenant(), ${input.companyId}, ${input.itemId}, ${input.code},
            ${input.expiresOn ?? null}, ${input.manufacturedOn ?? null}, ${input.legacyRef ?? null})
    returning id, company_id, item_id, code, expires_on::text as expires_on,
              manufactured_on::text as manufactured_on, archived_at, created_at`;
  return toLot(row!);
}

export async function listLots(
  tx: Sql,
  params: {
    companyId: string;
    itemId?: string;
    expiringBefore?: string;
    includeArchived?: boolean;
    cursor?: { code: string } | null;
    limit: number;
  },
): Promise<LotRow[]> {
  const rows = await tx<DbLot[]>`
    select id, company_id, item_id, code, expires_on::text as expires_on,
           manufactured_on::text as manufactured_on, archived_at, created_at
      from app.lot
     where company_id = ${params.companyId}
       and (${params.itemId ?? null}::uuid is null or item_id = ${params.itemId ?? null})
       and (${params.expiringBefore ?? null}::date is null
            or (expires_on is not null and expires_on <= ${params.expiringBefore ?? null}))
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
  return rows.map(toLot);
}

/**
 * The sentinel `app.lot` row every item is created with (ADR 0034). `applyMovements` resolves a null
 * `document_line.lot_id` to it, because `inventory_movement.lot_id` and `stock_on_hand.lot_id` are
 * both NOT NULL (§4.7.3). Throws rather than returning null: the row is created by trigger with the
 * item, so its absence means the trigger was dropped, which is a schema fault, not a data one.
 */
export async function sentinelLotId(tx: Sql, itemId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    select id from app.lot where item_id = ${itemId} and code = ${SENTINEL_LOT_CODE}`;
  if (!row) {
    throw new Error(
      `item ${itemId} has no '${SENTINEL_LOT_CODE}' sentinel lot: app.item_sentinel_lot() is missing ` +
        `from the schema (migration 0029, ADR 0034)`,
    );
  }
  return row.id;
}

export interface FefoPick {
  lotId: string;
  quantity: Quantity;
}

/**
 * First-expired-first-out picking — the 3A card's function, wrapped. This is the ONE caller-facing entry to
 * `app.pick_lots_fefo` (migration 0031): the ordering, the partial-pick behaviour and the sentinel's
 * last-place position all live in the SQL, so a screen, 3D's DELIVERY_ORDER and 6B's till cannot disagree
 * about which batch goes first (ADR 0036).
 *
 * Picking happens at DRAFTING time, over the synchronous projection. It is never called inside a posting
 * transaction, where the projection has not yet been MERGEd — `assert_stock_available` is the control there.
 */
export async function pickLotsFefo(
  tx: Sql,
  params: { itemId: string; warehouseId: string; quantity: Quantity },
): Promise<FefoPick[]> {
  const rows = await tx<{ lot_id: string; quantity: string }[]>`
    select lot_id, quantity::text as quantity
      from app.pick_lots_fefo(${params.itemId}, ${params.warehouseId},
                              ${params.quantity.toString()}::numeric)`;
  return rows.map((r) => ({ lotId: r.lot_id, quantity: Quantity.of(r.quantity) }));
}

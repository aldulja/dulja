import type { Sql } from "postgres";

export interface StockOnHandRow {
  companyId: string;
  itemId: string;
  itemCode: string;
  itemNameEn: string;
  warehouseId: string;
  warehouseCode: string;
  lotId: string;
  lotCode: string;
  expiresOn: string | null;
  quantity: string;
  updatedAt: string;
}

// The column list is written out in full rather than held in a constant and spliced with `tx.unsafe`, for
// the reason `prices.ts` and `promotions.ts` give: hazard 21 gives the driver's `unsafe` helper exactly
// three homes and none of them is in this slice.

/**
 * Reads the SYNCHRONOUS projection (D14, §4.7.3) and never re-aggregates `inventory_movement` — exactly as
 * 1B's `trialBalance` reads `account_balance` and never re-aggregates `ledger_entry`. A read that quietly
 * recomputed would hide the drift the nightly integrity job exists to find (test 2).
 *
 * The keyset is `(item.code, warehouse.code, lot.code)` — the three natural keys, so a page boundary is
 * stable across inserts and reads the way a human reads a stock sheet, rather than by uuid.
 */
export async function listStockOnHand(
  tx: Sql,
  params: {
    companyId: string;
    itemId?: string;
    warehouseId?: string;
    lotId?: string;
    nonZeroOnly?: boolean;
    cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null;
    limit: number;
  },
): Promise<StockOnHandRow[]> {
  return tx<StockOnHandRow[]>`
    select h.company_id       as "companyId",
           h.item_id          as "itemId",
           i.code             as "itemCode",
           i.name_en          as "itemNameEn",
           h.warehouse_id     as "warehouseId",
           w.code             as "warehouseCode",
           h.lot_id           as "lotId",
           l.code             as "lotCode",
           l.expires_on::text as "expiresOn",
           h.quantity::text   as "quantity",
           h.updated_at::text as "updatedAt"
      from app.stock_on_hand h
      join app.item i      on i.tenant_id = h.tenant_id and i.id = h.item_id
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
      join app.lot l       on l.tenant_id = h.tenant_id and l.id = h.lot_id
     where h.company_id = ${params.companyId}
       and (${params.itemId ?? null}::uuid is null or h.item_id = ${params.itemId ?? null})
       and (${params.warehouseId ?? null}::uuid is null
            or h.warehouse_id = ${params.warehouseId ?? null})
       and (${params.lotId ?? null}::uuid is null or h.lot_id = ${params.lotId ?? null})
       and (not ${params.nonZeroOnly ?? false} or h.quantity <> 0)
       and (${params.cursor?.itemCode ?? null}::text is null
            or (i.code, w.code, l.code) > (${params.cursor?.itemCode ?? null},
                                           ${params.cursor?.warehouseCode ?? null},
                                           ${params.cursor?.lotCode ?? null}))
     order by i.code, w.code, l.code
     limit ${params.limit}`;
}

import type { Sql } from "postgres";

export interface StockOnHandReportParams {
  companyId: string;
  itemId?: string | null;
  warehouseId?: string | null;
  /**
   * Include `warehouse.kind = 'in_transit'` rows. Default false — the Phase 3 definition-of-done clause is
   * that in-transit stock is in NEITHER warehouse's on-hand, so the default answer to "what is on my
   * shelves" excludes it. `true` is what a company-total or a transfer-chasing view asks for.
   */
  includeInTransit?: boolean;
  cursor?: { itemCode: string; warehouseCode: string; lotCode: string } | null;
  limit: number;
}

export interface StockOnHandReportRow {
  itemId: string;
  itemCode: string;
  itemNameEn: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseKind: "stock" | "in_transit";
  lotId: string;
  lotCode: string;
  lotExpiresOn: string | null;
  /** A 6-dp STRING; a `number` here would be a `no-number-money` violation (contracts §3.7.5). */
  quantity: string;
}

/**
 * The `inventory.stock_on_hand` dataset query (contracts §4.16.1, §4.16.3). It reads the SYNCHRONOUS
 * projection `app.stock_on_hand` and never re-aggregates the movement table — 1B's rule for `trialBalance`,
 * applied to the inventory projection: a report that quietly recomputed would hide exactly the drift the
 * integrity job (acceptance test 2) exists to find.
 *
 * In-transit rows are excluded by default because the definition-of-done clause is that goods in transit
 * are in neither warehouse's on-hand; `stockOnHandTotals` below is how the company figure that DOES include
 * them is asked for. `warehouseKind` is on every row so the distinction is visible in the output rather
 * than implied by a parameter.
 *
 * Every name in this module carries `Report`. 3A already exports `StockOnHandRow` from
 * `src/inventory/stock.ts` through the same flat barrel, and one name may leave that barrel through exactly
 * one module (TS2308). The two reads are not a duplication: 3A's `listStockOnHand` is a master-data list
 * endpoint over every key, this is the report code of §4.16.1 with the in-transit corridor rule and the
 * warehouse kind on each row. Both read this projection and neither re-derives it, which is the property
 * SAH-009 names. Retiring either is a §4.16.3 amendment and 7B's call.
 *
 * Keyset pagination on (item.code, warehouse.code, lot.code) — three text columns, all three in the
 * ORDER BY, so the page boundary is total.
 */
export async function stockOnHand(
  tx: Sql,
  params: StockOnHandReportParams,
): Promise<StockOnHandReportRow[]> {
  const includeInTransit = params.includeInTransit ?? false;
  const itemId = params.itemId ?? null;
  const warehouseId = params.warehouseId ?? null;
  const cursorItem = params.cursor?.itemCode ?? null;
  const cursorWarehouse = params.cursor?.warehouseCode ?? "";
  const cursorLot = params.cursor?.lotCode ?? "";

  const rows = await tx<
    {
      item_id: string;
      item_code: string;
      item_name_en: string;
      warehouse_id: string;
      warehouse_code: string;
      warehouse_kind: string;
      lot_id: string;
      lot_code: string;
      lot_expires_on: string | null;
      quantity: string;
    }[]
  >`
    select h.item_id::text      as item_id,
           i.code               as item_code,
           i.name_en            as item_name_en,
           h.warehouse_id::text as warehouse_id,
           w.code               as warehouse_code,
           w.kind               as warehouse_kind,
           h.lot_id::text       as lot_id,
           l.code               as lot_code,
           l.expires_on::text   as lot_expires_on,
           h.quantity::text     as quantity
      from app.stock_on_hand h
      join app.item      i on i.tenant_id = h.tenant_id and i.id = h.item_id
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
      join app.lot       l on l.tenant_id = h.tenant_id and l.id = h.lot_id
     where h.company_id = ${params.companyId}
       and h.quantity <> 0
       and (${includeInTransit}::boolean or w.kind = 'stock')
       and (${itemId}::uuid is null      or h.item_id      = ${itemId}::uuid)
       and (${warehouseId}::uuid is null or h.warehouse_id = ${warehouseId}::uuid)
       and (${cursorItem}::text is null
            or (i.code, w.code, l.code) > (${cursorItem}::text,
                                           ${cursorWarehouse}::text,
                                           ${cursorLot}::text))
     order by i.code, w.code, l.code
     limit ${params.limit}`;

  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    itemNameEn: row.item_name_en,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseKind: row.warehouse_kind === "in_transit" ? "in_transit" : "stock",
    lotId: row.lot_id,
    lotCode: row.lot_code,
    lotExpiresOn: row.lot_expires_on,
    quantity: row.quantity,
  }));
}

/**
 * The two company totals the definition-of-done clause's second half needs, in ONE query so no caller can
 * read the shelves and the total at two different instants and report a total that never existed.
 */
export async function stockOnHandTotals(
  tx: Sql,
  params: { companyId: string; itemId: string },
): Promise<{ onShelves: string; inTransit: string; total: string }> {
  const [row] = await tx<{ on_shelves: string; in_transit: string; total: string }[]>`
    select coalesce(sum(h.quantity) filter (where w.kind = 'stock'), 0)::numeric(19,6)::text
             as on_shelves,
           coalesce(sum(h.quantity) filter (where w.kind = 'in_transit'), 0)::numeric(19,6)::text
             as in_transit,
           coalesce(sum(h.quantity), 0)::numeric(19,6)::text
             as total
      from app.stock_on_hand h
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
     where h.company_id = ${params.companyId} and h.item_id = ${params.itemId}`;
  // The `::numeric(19,6)` cast before `::text` is why an item with no in-transit row answers "0.000000"
  // rather than "0": `coalesce(sum(...), 0)` on an empty group yields the integer literal, and a caller
  // comparing quantity strings must not have to know which of the two shapes it got.
  // `coalesce` makes every column non-null, and an aggregate with no GROUP BY always returns exactly one
  // row, so the only way `row` is undefined is a driver-level failure.
  if (!row) throw new Error("stockOnHandTotals returned no row");
  return { onShelves: row.on_shelves, inTransit: row.in_transit, total: row.total };
}

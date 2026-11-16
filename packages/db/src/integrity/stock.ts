import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "./types";

interface CompareRow {
  company_id: string;
  item_id: string;
  warehouse_id: string;
  lot_id: string;
  missing_in_projection: boolean;
  missing_in_rebuild: boolean;
  r_quantity: string | null;
  b_quantity: string | null;
}

/**
 * Contracts §4.7.3's rebuild, executed: group `app.inventory_movement` on the projection's full key, full-outer-
 * join it against `app.stock_on_hand`, and report every row missing on either side or whose quantity differs.
 * Movements are append-only and signed — a reversal ADDS negative rows rather than editing anything — so the
 * projection is a pure sum and the comparison is exact.
 *
 * Runs inside `withTenant`, so both sides are already one tenant's rows (§4.2.2). Reads only: `select` and
 * `join` on a protected table are not DML, so `posting-only-tables` (§3.7.5) is satisfied without an
 * allow-list entry, exactly as it is for 1B's `integrity/projections.ts`.
 *
 * One statement, no DDL, and re-entrant by construction. The plan's text materialised the rebuild in a
 * `create temporary table … on commit drop`; 1B's `checkAccountBalanceProjection` had the same draft and
 * replaced it with a CTE, because AGENTS.md forbids issuing DDL from application code outright. Mirroring the
 * shipped sibling is the point — a second way of comparing a projection would be a second answer to "did it
 * drift?" — so this check is the same CTE, the same full outer join and the same mismatch shape.
 */
export async function checkStockOnHandProjection(tx: Sql): Promise<ProjectionMismatch[]> {
  const rows = await tx<CompareRow[]>`
    with rebuilt as (
      select m.company_id, m.item_id, m.warehouse_id, m.lot_id, sum(m.quantity) as quantity
        from app.inventory_movement m
       group by m.company_id, m.item_id, m.warehouse_id, m.lot_id
    )
    select coalesce(r.company_id, h.company_id)::text     as company_id,
           coalesce(r.item_id, h.item_id)::text           as item_id,
           coalesce(r.warehouse_id, h.warehouse_id)::text as warehouse_id,
           coalesce(r.lot_id, h.lot_id)::text             as lot_id,
           (h.company_id is null)                         as missing_in_projection,
           (r.company_id is null)                         as missing_in_rebuild,
           r.quantity::text as r_quantity,
           h.quantity::text as b_quantity
      from rebuilt r
      full outer join app.stock_on_hand h
        on  h.company_id   = r.company_id
        and h.item_id      = r.item_id
        and h.warehouse_id = r.warehouse_id
        and h.lot_id       = r.lot_id
     where r.company_id is null
        or h.company_id is null
        or h.quantity <> r.quantity
     order by 1, 2, 3, 4`;

  return rows.map((row) => {
    const key = {
      company_id: row.company_id,
      item_id: row.item_id,
      warehouse_id: row.warehouse_id,
      lot_id: row.lot_id,
    };
    if (row.missing_in_projection) {
      return {
        projection: "stock_on_hand",
        key,
        side: "missing_in_projection" as const,
        detail: `the movements sum to ${row.r_quantity} and stock_on_hand has no row`,
      };
    }
    if (row.missing_in_rebuild) {
      return {
        projection: "stock_on_hand",
        key,
        side: "missing_in_rebuild" as const,
        detail: `stock_on_hand has ${row.b_quantity} and the movements have none`,
      };
    }
    return {
      projection: "stock_on_hand",
      key,
      side: "amount_differs" as const,
      detail: `quantity ${row.b_quantity} <> ${row.r_quantity}`,
    };
  });
}

/** The ProjectionCheck this slice contributes to 1B's registry (§4.16.3); registered in ./index.ts. */
export const STOCK_ON_HAND_CHECK: ProjectionCheck = {
  name: "stock_on_hand",
  run: checkStockOnHandProjection,
};

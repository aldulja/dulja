import type { Sql } from "postgres";
import type { ProjectionMismatch } from "../integrity";

export interface ValuationParams {
  companyId: string;
  /** Inclusive, and on `effective_date` — never `posted_at` (spec:2039). */
  asOf: string;
  itemId?: string | null;
  warehouseId?: string | null;
  cursor?: { itemCode: string; warehouseCode: string } | null;
  limit: number;
}

export interface ValuationRow {
  itemId: string;
  itemCode: string;
  itemNameEn: string;
  warehouseId: string;
  warehouseCode: string;
  /** Fixed-scale STRINGS throughout; a JSON number here would be a `no-number-money` violation (§3.7.5). */
  quantity: string;
  value: string;
  unitCost: string;
}

/**
 * THE valuation read (spec:1228). Every consumer — this slice's route, 3D's `inventory.valuation` report,
 * 4B's `item_profitability`, 7B's re-expression and Task 11's `stock_valuation` rebuild — calls this
 * function. None re-derives it, which is the whole answer to LEGACY-009.
 *
 * As-of, in two clauses:
 *   1. a layer counts only if ITS OWN movement's `effective_date <= asOf` — a receipt dated after the
 *      question has not happened yet; and
 *   2. its residue subtracts only consumptions whose CONSUMING movement's `effective_date <= asOf` — the
 *      consumption's date, not the layer's. `cost_layer.qty_remaining` is the CURRENT residue and is
 *      deliberately not read here: it would answer "today" to a question about a past date.
 *
 * Value is the per-layer `round(value x qty_remaining / qty_in, 4)` summed, never `average x quantity`. The two
 * differ by a rounding residue at the fourth place, and the per-layer form is what `app.stock_valuation`
 * stores, so a report and the stored snapshot cannot drift a cent apart.
 */
export async function valuationAsOf(tx: Sql, params: ValuationParams): Promise<ValuationRow[]> {
  return tx<ValuationRow[]>`
    with layer_asof as (
      select l.id, l.tenant_id, l.item_id, l.warehouse_id, l.value, l.qty_in,
             l.qty_in - coalesce((
               select sum(c.quantity)
                 from app.cost_consumption c
                 join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
                where c.tenant_id = l.tenant_id and c.layer_id = l.id
                  and c.invalidated_at is null
                  and cm.effective_date <= ${params.asOf}::date), 0) as qty_remaining
        from app.cost_layer l
        join app.inventory_movement m on m.tenant_id = l.tenant_id and m.id = l.movement_id
       where l.company_id = ${params.companyId}
         and l.invalidated_at is null
         and m.effective_date <= ${params.asOf}::date
         and (${params.itemId ?? null}::uuid is null
              or l.item_id = ${params.itemId ?? null}::uuid)
         and (${params.warehouseId ?? null}::uuid is null
              or l.warehouse_id = ${params.warehouseId ?? null}::uuid)
    )
    select i.id::text as "itemId", i.code as "itemCode", i.name_en as "itemNameEn",
           w.id::text as "warehouseId", w.code as "warehouseCode",
           sum(la.qty_remaining)::text as "quantity",
           sum(round(la.value * la.qty_remaining / la.qty_in, 4))::text as "value",
           case when sum(la.qty_remaining) = 0 then '0.0000'
                else round(sum(round(la.value * la.qty_remaining / la.qty_in, 4))
                           / sum(la.qty_remaining), 4)::text
           end as "unitCost"
      from layer_asof la
      join app.item      i on i.tenant_id = la.tenant_id and i.id = la.item_id
      join app.warehouse w on w.tenant_id = la.tenant_id and w.id = la.warehouse_id
     group by i.id, i.code, i.name_en, w.id, w.code
    having sum(la.qty_remaining) <> 0
       and (${params.cursor?.itemCode ?? null}::text is null
            or (i.code, w.code) > (${params.cursor?.itemCode ?? null}::text,
                                   ${params.cursor?.warehouseCode ?? ""}::text))
     order by i.code, w.code
     limit ${params.limit}`;
}

export interface OpenLayersParams {
  companyId: string;
  itemId: string;
  asOf: string;
  warehouseId?: string | null;
  cursor?: { effectiveAt: string; sequence: string } | null;
  limit: number;
}

export interface CostLayerRow {
  layerId: string;
  movementId: string;
  documentId: string;
  documentTypeCode: string;
  number: string | null;
  warehouseId: string;
  warehouseCode: string;
  lotId: string;
  lotCode: string;
  lotExpiresOn: string | null;
  qtyIn: string;
  qtyRemaining: string;
  unitCost: string;
  value: string;
  effectiveAt: string;
  sequence: string;
}

/**
 * The open layers of one item, oldest first on the §4.3.5 chronological key. These are the raw rows 7B's
 * `inventory.stock_ageing` report reads, and the rows an accountant opens when they want to know why a
 * valuation says what it says.
 *
 * The residue is recomputed as-of exactly as `valuationAsOf` computes it, for the same reason.
 */
export async function openLayersOf(tx: Sql, params: OpenLayersParams): Promise<CostLayerRow[]> {
  return tx<CostLayerRow[]>`
    select l.id::text as "layerId", l.movement_id::text as "movementId",
           m.document_id::text as "documentId", dt.code as "documentTypeCode",
           d.number::text as "number",
           l.warehouse_id::text as "warehouseId", w.code as "warehouseCode",
           l.lot_id::text as "lotId", lot.code as "lotCode", lot.expires_on::text as "lotExpiresOn",
           l.qty_in::text as "qtyIn",
           (l.qty_in - coalesce((
              select sum(c.quantity) from app.cost_consumption c
                join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
               where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null
                 and cm.effective_date <= ${params.asOf}::date), 0))::text as "qtyRemaining",
           l.unit_cost::text as "unitCost",
           round((l.qty_in - coalesce((
              select sum(c.quantity) from app.cost_consumption c
                join app.inventory_movement cm on cm.tenant_id = c.tenant_id and cm.id = c.movement_id
               where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null
                 and cm.effective_date <= ${params.asOf}::date), 0)) * l.value / l.qty_in, 4)::text as "value",
           l.effective_at::text as "effectiveAt", l.sequence::text as "sequence"
      from app.cost_layer l
      join app.inventory_movement m  on m.tenant_id   = l.tenant_id and m.id   = l.movement_id
      join app.document          d   on d.tenant_id   = m.tenant_id and d.id   = m.document_id
      join app.document_type     dt  on dt.tenant_id  = d.tenant_id and dt.id  = d.document_type_id
      join app.warehouse         w   on w.tenant_id   = l.tenant_id and w.id   = l.warehouse_id
      join app.lot               lot on lot.tenant_id = l.tenant_id and lot.id = l.lot_id
     where l.company_id = ${params.companyId}
       and l.item_id = ${params.itemId}
       and l.invalidated_at is null
       and m.effective_date <= ${params.asOf}::date
       and (${params.warehouseId ?? null}::uuid is null
            or l.warehouse_id = ${params.warehouseId ?? null}::uuid)
       and (${params.cursor?.effectiveAt ?? null}::date is null
            or (l.effective_at, l.sequence) > (${params.cursor?.effectiveAt ?? null}::date,
                                               ${params.cursor?.sequence ?? "0"}::bigint))
     order by l.effective_at, l.sequence, m.line_no, m.movement_no
     limit ${params.limit}`;
}

/** The rebuild pages rather than reading a whole company at once — a tenant with 50 000 (item, warehouse)
 *  pairs is ordinary, and one 50 000-row result set inside a nightly job is not. */
export const VALUATION_PAGE = 1000;

export interface StockValuationRebuildResult {
  asOf: string;
  rowsWritten: number;
  mismatches: ProjectionMismatch[];
  /** Pairs skipped because an authorised negative-stock shortfall is still open (ADR 0038 note 7). */
  excluded: { itemId: string; warehouseId: string }[];
}

interface DriftRow {
  item_id: string;
  warehouse_id: string;
  layer_qty: string;
  movement_qty: string;
  layer_missing: boolean;
  movement_missing: boolean;
  shortfall_open: boolean;
}

/**
 * Rebuilds `app.stock_valuation` for one company at one date, **from `valuationAsOf`** — not from a second
 * query that happens to compute the same thing. Two derivations of one figure is LEGACY-009, and this function
 * exists to be the one place a stored snapshot and a live report cannot diverge.
 *
 * Compares the QUANTITY half to `sum(inventory_movement.quantity)` as at the date; a difference is a
 * `ProjectionMismatch` the caller records as an incident. The VALUE half is deliberately not compared
 * against movements — an issue's movement value is its post-time value and is immutable, so after a recost
 * the two legitimately differ by the adjustments already posted (ADR 0039). The value's invariant lives on
 * the layer and is `COST_LAYER_CHECK`.
 *
 * One company per transaction (spec:1368); the caller supplies the transaction, as every function in this
 * package does. `app.stock_valuation` is an ASYNCHRONOUS projection, so `posting-only-tables` (§3.7.5) does
 * not carry it and the MERGE below is legal where it sits.
 */
export async function rebuildStockValuation(
  tx: Sql,
  input: { companyId: string; asOf: string },
): Promise<StockValuationRebuildResult> {
  const rows: ValuationRow[] = [];
  let cursor: { itemCode: string; warehouseCode: string } | null = null;
  for (;;) {
    const page = await valuationAsOf(tx, {
      companyId: input.companyId,
      asOf: input.asOf,
      cursor,
      limit: VALUATION_PAGE,
    });
    rows.push(...page);
    if (page.length < VALUATION_PAGE) break;
    const last = page[page.length - 1]!;
    cursor = { itemCode: last.itemCode, warehouseCode: last.warehouseCode };
  }

  for (const r of rows) {
    await tx`
      merge into app.stock_valuation v
      using (select ${input.companyId}::uuid as company_id, ${r.itemId}::uuid as item_id,
                    ${r.warehouseId}::uuid as warehouse_id, ${input.asOf}::date as as_of,
                    ${r.quantity}::numeric(19,6) as quantity, ${r.value}::numeric(19,4) as value) s
         on v.company_id = s.company_id and v.item_id = s.item_id
        and v.warehouse_id = s.warehouse_id and v.as_of = s.as_of
       when matched then update set quantity = s.quantity, value = s.value, updated_at = now()
       when not matched then insert (tenant_id, company_id, item_id, warehouse_id, as_of, quantity, value)
                             values (app.current_tenant(), s.company_id, s.item_id, s.warehouse_id,
                                     s.as_of, s.quantity, s.value)`;
  }

  // Rows that fell to zero must not linger from an earlier rebuild of the same date. app_rw holds no DELETE
  // on this table (§3.5.4), so they are zeroed, not removed — and a zero row is a true statement about the
  // date. The two arrays are positional and correct only because both are built from the same `rows` in the
  // same order.
  await tx`
    update app.stock_valuation
       set quantity = 0, value = 0, updated_at = now()
     where company_id = ${input.companyId} and as_of = ${input.asOf}::date
       and (item_id, warehouse_id) not in (
         select t.item_id, t.warehouse_id
           from unnest(${rows.map((r) => r.itemId)}::uuid[],
                       ${rows.map((r) => r.warehouseId)}::uuid[]) as t(item_id, warehouse_id))
       and (quantity <> 0 or value <> 0)`;

  const drift = await tx<DriftRow[]>`
    with from_layers as (
      select item_id, warehouse_id, sum(quantity) as qty
        from app.stock_valuation
       where company_id = ${input.companyId} and as_of = ${input.asOf}::date
       group by 1, 2
    ), from_movements as (
      select item_id, warehouse_id, sum(quantity) as qty
        from app.inventory_movement
       where company_id = ${input.companyId} and effective_date <= ${input.asOf}::date
       group by 1, 2
    ), live as (
      -- The CURRENT (not as-of) layer and movement totals. An open shortfall exists when the layers still
      -- hold more than the movements say, which is only possible through an authorised override issue whose
      -- uncovered quantity was valued but never consumed (ADR 0038 note 7).
      select coalesce(l.item_id, m.item_id) as item_id,
             coalesce(l.warehouse_id, m.warehouse_id) as warehouse_id,
             coalesce(l.qty, 0) - coalesce(m.qty, 0) as gap
        from (select item_id, warehouse_id, sum(qty_remaining) as qty from app.cost_layer
               where company_id = ${input.companyId} and invalidated_at is null group by 1, 2) l
        full outer join (select item_id, warehouse_id, sum(quantity) as qty from app.inventory_movement
                          where company_id = ${input.companyId} group by 1, 2) m
          on m.item_id = l.item_id and m.warehouse_id = l.warehouse_id
    )
    select coalesce(l.item_id, m.item_id)::text as item_id,
           coalesce(l.warehouse_id, m.warehouse_id)::text as warehouse_id,
           coalesce(l.qty, 0)::text as layer_qty, coalesce(m.qty, 0)::text as movement_qty,
           -- Which SIDE of the full outer join is absent — the two booleans ProjectionMismatch.side needs.
           (l.item_id is null) as layer_missing, (m.item_id is null) as movement_missing,
           coalesce((select v.gap > 0 from live v
                      where v.item_id = coalesce(l.item_id, m.item_id)
                        and v.warehouse_id = coalesce(l.warehouse_id, m.warehouse_id)), false)
             as shortfall_open
      from from_layers l
      full outer join from_movements m on m.item_id = l.item_id and m.warehouse_id = l.warehouse_id
     where coalesce(l.qty, 0) <> coalesce(m.qty, 0)
     order by 1, 2`;

  return {
    asOf: input.asOf,
    rowsWritten: rows.length,
    excluded: drift
      .filter((d) => d.shortfall_open)
      .map((d) => ({ itemId: d.item_id, warehouseId: d.warehouse_id })),
    mismatches: drift
      .filter((d) => !d.shortfall_open)
      .map((d) => ({
        projection: "stock_valuation" as const,
        key: { itemId: d.item_id, warehouseId: d.warehouse_id, asOf: input.asOf },
        // `side` is REQUIRED on ProjectionMismatch (1b:442-450) and is DERIVED from the join, never guessed:
        // the movement side absent means the projection carries a pair the rebuild does not
        // ("missing_in_rebuild"); the layer side absent is the converse; present on both and unequal is
        // "amount_differs". Read from the two booleans, not from a "0.000000" string compare.
        side: d.movement_missing
          ? ("missing_in_rebuild" as const)
          : d.layer_missing
            ? ("missing_in_projection" as const)
            : ("amount_differs" as const),
        detail: describeDrift(d, input.asOf),
      })),
  };
}

/**
 * The mismatch sentence, hoisted out of the map for one reason: `no-sql-concat` (§3.7.5) scans every
 * UNTAGGED template literal that interpolates, and a sentence reading "… the cost layers … the movements"
 * with the preposition spelled the obvious way contains a SQL keyword and is reported as constructed SQL.
 * The wording is therefore "by the cost layers" / "by the movements", and
 * `packages/db/test/costing/valuation.test.ts` pins it.
 */
function describeDrift(d: DriftRow, asOf: string): string {
  return `quantity ${d.layer_qty} by the cost layers does not equal ${d.movement_qty} by the movements for item ${d.item_id} in warehouse ${d.warehouse_id} as at ${asOf}`;
}

import type { Sql } from "postgres";

export interface SalesByItemParams {
  companyId: string;
  /** Inclusive, and on `effective_date` — never `posted_at` (spec:2039). */
  fromDate: string;
  toDate: string;
  itemId?: string | null;
  branchId?: string | null;
  cursor?: { itemCode: string } | null;
  limit: number;
}

export interface SalesByItemRow {
  itemId: string;
  itemCode: string;
  itemNameEn: string;
  /** Sum of the magnitudes of the DELIVERY_ORDER issues, a 6-dp string. */
  deliveredQuantity: string;
  /** Sum of `cost_consumption.value` for those movements — the ONE cost source. A 4-dp string. */
  cost: string;
  /**
   * 4A (contracts §4.16.3 amendment 13). Σ `round(document_line.amount × document.exchange_rate, 4)` over the
   * item lines of every document that POSTED in the range and whose PINNED policy credits (or, negated,
   * debits) `item.revenue_account` — a SALES_INVOICE and a SALES_CREDIT_NOTE today, 6A's POS_TICKET later —
   * in BASE currency, a 4-dp string: `app.item_revenue_rows`, the one definition `item_profitability` reads
   * too (code review B4). `ledger_entry` carries no item id and its `line_no` is the ledger ordinal with no join back
   * to `document_line`, so revenue cannot come from there; the conversion is the `base = value × rate`
   * identity the ledger CHECK enforces (spec:1816), computed in SQL on the document's OWN pinned rate — never
   * a current one (LEGACY-014). A credit note's `amount` is already negated (4A Task 8), so a return subtracts
   * by arithmetic and the query contains no sign logic.
   *
   * `cost` is cut on DELIVERIES and `revenue` on INVOICES, so a range with goods delivered and not yet
   * invoiced shows cost with no revenue — and that difference is exactly the `1250` balance (§4.15); goods
   * invoiced in the range but delivered before it show revenue at zero quantity and cost. 4B's
   * `item_profitability`, keyed per fiscal period, is the reconciling projection; 7B re-expresses this
   * report over it under the same code.
   */
  revenue: string;
  /** 4A — `revenue − cost`, in base, a 4-dp string. */
  margin: string;
}

/**
 * The `inventory.sales_by_item` dataset query (contracts §4.16.3). 3D shipped it as delivered quantity and
 * its cost per item, from DELIVERY_ORDER movements and `cost_consumption`, because no document type posted
 * revenue before 4A's SALES_INVOICE; 4A extends the SAME report code with `revenue` and `margin` in the PR
 * that ships that type, and 7B re-expresses it over 4B's `item_profitability`. A new code at either step
 * would break spec:2300's "ships continuously", which is why the register names one code for all three.
 *
 * The query is two aggregates keyed by item and FULL-joined, so an item appears when it has either half in
 * the range: `delivered` (3D's, unchanged) and `revenue` (4A's). Joining the revenue onto the movements
 * alone would drop an item invoiced in the range and delivered before it — and its revenue with it.
 *
 * Cost comes from `cost_consumption` and NOT from `document_line.cost`. Both hold the same figure for a
 * clean delivery, but only the consumptions are layer-accurate after a replay: 3B's `inventory.cost.replay`
 * rewrites them and posts a COST_ADJUSTMENT, and a report reading the document line would show the
 * pre-recost figure forever. `invalidated_at is null` is what keeps a superseded replay generation out.
 *
 * A movement admitted by an `inventory.negative_stock.override` has no consumption row for its uncovered
 * quantity (`cost_consumption.layer_id` is NOT NULL), so such a line contributes quantity and no cost — the
 * honest answer, not a gap, and the one acceptance test 7's tie-out is built on. The `left join` is
 * deliberate for exactly that reason: an inner join would silently drop the movement instead of reporting
 * it at zero cost.
 *
 * The consumptions are collapsed to ONE row per movement by a `left join lateral` before the aggregate, and
 * this is load-bearing rather than stylistic: one issue consumes as many layers as FEFO or AVCO needs, so a
 * flat join to `cost_consumption` multiplies the movement row once per layer and `sum(-m.quantity)` would
 * then report a delivery of six taken from two layers as twelve delivered. The `coalesce` inside the lateral
 * is what keeps the override case (no consumption at all) at a zero cost instead of a NULL that would
 * swallow the whole item's cost in the `sum`.
 *
 * Revenue counts a document that posted and was later REVERSED together with its reversal, where 3D's cost
 * half excludes both sides of a reversed delivery. The two rules agree whenever the pair falls inside the
 * range (it nets to nothing either way), and they differ on purpose when a range splits it: the invoice's
 * credit to revenue and its mirror's debit are both in the ledger on their own dates, and `revenue` must tie
 * to that ledger (4A Task 11). The one filter that must NOT be applied is 3D's `reverses_document_id is
 * null`: every 4A credit note carries it — a partial one from `creditNoteFrom` points at an invoice that is
 * still posted — so that filter would silently drop every return. `status = 'posted'` alone would be as
 * wrong the other way, counting a full reversal's mirror without the invoice it mirrors.
 */
export async function salesByItem(tx: Sql, params: SalesByItemParams): Promise<SalesByItemRow[]> {
  const itemId = params.itemId ?? null;
  const branchId = params.branchId ?? null;
  const cursorItem = params.cursor?.itemCode ?? null;

  const rows = await tx<
    {
      item_id: string;
      item_code: string;
      item_name_en: string;
      delivered_quantity: string;
      cost: string;
      revenue: string;
      margin: string;
    }[]
  >`
    with delivered as (
      select m.tenant_id,
             m.item_id,
             sum(-m.quantity) as delivered_quantity,
             sum(c.value)     as cost
        from app.inventory_movement m
        join app.document      d on d.tenant_id = m.tenant_id and d.id = m.document_id
        join app.document_type t on t.tenant_id = d.tenant_id and t.id = d.document_type_id
        left join lateral (
          select coalesce(sum(cc.value), 0) as value
            from app.cost_consumption cc
           where cc.tenant_id = m.tenant_id
             and cc.movement_id = m.id
             and cc.invalidated_at is null
        ) c on true
       where m.company_id = ${params.companyId}
         and t.code = 'DELIVERY_ORDER'
         and m.quantity < 0
         -- A delivery that was reversed is not a delivery, and the reversal document is itself a
         -- DELIVERY_ORDER (reversal.producesType) whose movement is POSITIVE, so the m.quantity < 0 filter
         -- alone kept the original's row and dropped the reversal's — a delivered-then-reversed order was
         -- still reported as delivered quantity and cost. Both sides of a reversal pair are excluded.
         and d.status <> 'reversed'
         and d.reverses_document_id is null
         and m.effective_date between ${params.fromDate}::date and ${params.toDate}::date
         and (${itemId}::uuid is null   or m.item_id   = ${itemId}::uuid)
         and (${branchId}::uuid is null or d.branch_id = ${branchId}::uuid)
       group by m.tenant_id, m.item_id
    ),
    revenue as (
      -- 4A: the item lines the pinned policy credits (or debits) to item.revenue_account, converted on the
      -- document's own rate (spec:1816's identity, LEGACY-014) — app.item_revenue_rows (0048 §3a), the ONE
      -- definition item_profitability reads too (code review B4), never a list of type codes. 'reversed' is a
      -- document that POSTED and was then reversed; its mirror is a posted SALES_CREDIT_NOTE with negated
      -- magnitudes, so the pair nets by arithmetic, exactly as its ledger rows do.
      select d.tenant_id,
             r.item_id,
             sum(r.revenue_base) as revenue
        from app.item_revenue_rows(${params.companyId}::uuid, ${params.fromDate}::date,
                                   ${params.toDate}::date) r
        join app.document d on d.id = r.document_id
       where (${itemId}::uuid is null   or r.item_id   = ${itemId}::uuid)
         and (${branchId}::uuid is null or d.branch_id = ${branchId}::uuid)
       group by d.tenant_id, r.item_id
    )
    select i.id::text as item_id,
           i.code     as item_code,
           i.name_en  as item_name_en,
           coalesce(dv.delivered_quantity, 0)::numeric(19,6)::text                   as delivered_quantity,
           coalesce(dv.cost, 0)::numeric(19,4)::text                                 as cost,
           coalesce(rv.revenue, 0)::numeric(19,4)::text                              as revenue,
           (coalesce(rv.revenue, 0) - coalesce(dv.cost, 0))::numeric(19,4)::text     as margin
      from delivered dv
      full join revenue rv on rv.tenant_id = dv.tenant_id and rv.item_id = dv.item_id
      join app.item i on i.tenant_id = coalesce(dv.tenant_id, rv.tenant_id)
                     and i.id = coalesce(dv.item_id, rv.item_id)
     where (${cursorItem}::text is null or i.code > ${cursorItem}::text)
     order by i.code
     limit ${params.limit}`;

  return rows.map((row) => ({
    itemId: row.item_id,
    itemCode: row.item_code,
    itemNameEn: row.item_name_en,
    deliveredQuantity: row.delivered_quantity,
    cost: row.cost,
    revenue: row.revenue,
    margin: row.margin,
  }));
}

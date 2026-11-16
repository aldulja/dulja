import { defineDataset, type Dataset, type DatasetColumn } from "../query";

/**
 * The inventory datasets (3A–3D's and 4B's sources). Same rules as `accounting.ts`: every `ref` is a literal
 * tagged template, dates and timestamps leave SQL as strings, numerics stay postgres.js strings.
 *
 * Stock ageing and stock valuation read `cost_layer` / `cost_consumption` / `stock_valuation` and NEVER
 * recompute a cost (spec:1222, 1228; SAH-055): these datasets expose the stored layer columns and 7B's
 * definitions group them; nothing here divides a value by a quantity. `item_profitability` is 4B's async
 * projection and is read, never re-derived (§4.6.1).
 *
 * The five stock tables carry 6C's Form C `branch_isolation` policy (0068), so a branch-restricted reader
 * sees only the rows of the warehouses its branches own — the datasets add no predicate of their own for it.
 */

/** The cost read code (3B): a column carrying a cost figure declares it as `requires` (second review,
 *  finding 5). The cost datasets are gated on it whole already; the declaration keeps a later widening of
 *  their gate sets from opening the figures. */
const COST_READ = "inventory.cost.read";
/** `column` with `requires: COST_READ` — a wrapper, so the column literal itself reads as every other does. */
const costRead = (column: DatasetColumn): DatasetColumn => ({ ...column, requires: COST_READ });
// ── item — the master row plus the four account columns the policy resolves through (§4.6.1) ─────────
const ITEM_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`it.id` },
  { field: "code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`it.kind` },
  { field: "barcode", kind: "text", ref: (tx) => tx`it.barcode` },
  { field: "base_unit_id", kind: "uuid", ref: (tx) => tx`it.base_unit_id` },
  { field: "base_unit_code", kind: "text", ref: (tx) => tx`u.code` },
  { field: "track_lots", kind: "boolean", ref: (tx) => tx`it.track_lots` },
  { field: "shelf_life_days", kind: "integer", ref: (tx) => tx`it.shelf_life_days` },
  { field: "tax_code_id", kind: "uuid", ref: (tx) => tx`it.tax_code_id` },
  { field: "revenue_account_code", kind: "text", ref: (tx) => tx`ra.code` },
  { field: "inventory_account_code", kind: "text", ref: (tx) => tx`ia.code` },
  { field: "cogs_account_code", kind: "text", ref: (tx) => tx`ca.code` },
  { field: "expense_account_code", kind: "text", ref: (tx) => tx`ea.code` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`it.archived_at` },
];

export const itemDataset: Dataset = defineDataset({
  id: "item",
  columns: ITEM_COLUMNS,
  company: (tx, companyId) => tx`it.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.item it
        join app.unit_of_measure u on u.id = it.base_unit_id
        left join app.account ra on ra.id = it.revenue_account_id
        left join app.account ia on ia.id = it.inventory_account_id
        left join app.account ca on ca.id = it.cogs_account_id
        left join app.account ea on ea.id = it.expense_account_id`,
  select: (
    tx,
  ) => tx`it.id as item_id, it.code as code, it.name_en as name_en, it.name_ar as name_ar,
         it.kind as kind, it.barcode as barcode, it.base_unit_id as base_unit_id, u.code as base_unit_code,
         it.track_lots as track_lots, it.shelf_life_days as shelf_life_days, it.tax_code_id as tax_code_id,
         ra.code as revenue_account_code, ia.code as inventory_account_code,
         ca.code as cogs_account_code, ea.code as expense_account_code,
         to_char(it.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`it.code asc`,
});

// ── lot — with the derived days_to_expiry the expiry list sorts on ──────────────────────────────────
const LOT_COLUMNS: readonly DatasetColumn[] = [
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`l.id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`l.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "code", kind: "text", ref: (tx) => tx`l.code` },
  { field: "expires_on", kind: "date", ref: (tx) => tx`l.expires_on` },
  { field: "manufactured_on", kind: "date", ref: (tx) => tx`l.manufactured_on` },
  // current_date is the render date, not the accounting date — this column is a shelf-life warning and is
  // never a figure a report ties to the ledger with (spec:2039 keeps effective_date the accounting date).
  { field: "days_to_expiry", kind: "integer", ref: (tx) => tx`(l.expires_on - current_date)` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`l.archived_at` },
];

export const lotDataset: Dataset = defineDataset({
  id: "lot",
  columns: LOT_COLUMNS,
  company: (tx, companyId) => tx`l.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.lot l join app.item it on it.id = l.item_id`,
  select: (
    tx,
  ) => tx`l.id as lot_id, l.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         l.code as code, to_char(l.expires_on, 'YYYY-MM-DD') as expires_on,
         to_char(l.manufactured_on, 'YYYY-MM-DD') as manufactured_on,
         (l.expires_on - current_date)::int as days_to_expiry,
         to_char(l.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`l.expires_on asc nulls last, it.code asc, l.code asc`,
});

// ── warehouse ───────────────────────────────────────────────────────────────────────────────────────
const WAREHOUSE_COLUMNS: readonly DatasetColumn[] = [
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`w.id` },
  { field: "code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`w.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`w.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`w.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`w.parent_id` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`w.archived_at` },
];

export const warehouseDataset: Dataset = defineDataset({
  id: "warehouse",
  columns: WAREHOUSE_COLUMNS,
  company: (tx, companyId) => tx`w.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.warehouse w join app.dimension_value bv on bv.id = w.branch_id`,
  select: (
    tx,
  ) => tx`w.id as warehouse_id, w.code as code, w.name_en as name_en, w.name_ar as name_ar,
         w.kind as kind, w.branch_id as branch_id, bv.code as branch_code, w.parent_id as parent_id,
         to_char(w.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`w.code asc`,
});

// ── price_list_line — the company key lives on price_list, so the join is the predicate's source ─────
const PRICE_LIST_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`pll.id` },
  { field: "price_list_id", kind: "uuid", ref: (tx) => tx`pll.price_list_id` },
  { field: "price_list_code", kind: "text", ref: (tx) => tx`pl.code` },
  { field: "price_list_currency", kind: "text", ref: (tx) => tx`pl.currency` },
  { field: "customer_kind", kind: "text", ref: (tx) => tx`pl.customer_kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`pl.branch_id` },
  { field: "valid_from", kind: "date", ref: (tx) => tx`pl.valid_from` },
  { field: "valid_to", kind: "date", ref: (tx) => tx`pl.valid_to` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`pll.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "unit_id", kind: "uuid", ref: (tx) => tx`pll.unit_id` },
  { field: "unit_code", kind: "text", ref: (tx) => tx`u.code` },
  { field: "min_quantity", kind: "numeric", ref: (tx) => tx`pll.min_quantity` },
  { field: "unit_price", kind: "numeric", ref: (tx) => tx`pll.unit_price` },
  // A replaced line is archived, never deleted (3A's replacePriceListLines); the list itself may be too.
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`pll.archived_at` },
  { field: "price_list_archived_at", kind: "timestamp", ref: (tx) => tx`pl.archived_at` },
];

export const priceListLineDataset: Dataset = defineDataset({
  id: "price_list_line",
  columns: PRICE_LIST_LINE_COLUMNS,
  company: (tx, companyId) => tx`pl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.price_list_line pll
        join app.price_list pl on pl.id = pll.price_list_id
        join app.item       it on it.id = pll.item_id
        left join app.unit_of_measure u on u.id = pll.unit_id`,
  select: (
    tx,
  ) => tx`pll.id as line_id, pll.price_list_id as price_list_id, pl.code as price_list_code,
         pl.currency as price_list_currency, pl.customer_kind as customer_kind, pl.branch_id as branch_id,
         to_char(pl.valid_from, 'YYYY-MM-DD') as valid_from, to_char(pl.valid_to, 'YYYY-MM-DD') as valid_to,
         pll.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         pll.unit_id as unit_id, u.code as unit_code, pll.min_quantity as min_quantity,
         pll.unit_price as unit_price,
         to_char(pll.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at,
         to_char(pl.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as price_list_archived_at`,
  defaultOrder: (tx) => tx`pl.code asc, it.code asc, pll.min_quantity asc`,
});

// ── promotion ───────────────────────────────────────────────────────────────────────────────────────
const PROMOTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "promotion_id", kind: "uuid", ref: (tx) => tx`pr.id` },
  { field: "code", kind: "text", ref: (tx) => tx`pr.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`pr.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`pr.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`pr.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`pr.branch_id` },
  { field: "starts_at", kind: "timestamp", ref: (tx) => tx`pr.starts_at` },
  { field: "ends_at", kind: "timestamp", ref: (tx) => tx`pr.ends_at` },
  {
    field: "definition",
    kind: "text",
    ref: (tx) => tx`pr.definition::text`,
    filterable: false,
    sortable: false,
  },
];

export const promotionDataset: Dataset = defineDataset({
  id: "promotion",
  columns: PROMOTION_COLUMNS,
  company: (tx, companyId) => tx`pr.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.promotion pr`,
  select: (
    tx,
  ) => tx`pr.id as promotion_id, pr.code as code, pr.name_en as name_en, pr.name_ar as name_ar,
         pr.kind as kind, pr.branch_id as branch_id,
         to_char(pr.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at,
         to_char(pr.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ends_at,
         pr.definition::text as definition`,
  defaultOrder: (tx) => tx`pr.starts_at desc nulls last, pr.code asc`,
});

// ── inventory_movement — append-only, signed; the movement register (§4.7.3) ─────────────────────────
const INVENTORY_MOVEMENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`m.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`m.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`m.line_no` },
  { field: "movement_no", kind: "integer", ref: (tx) => tx`m.movement_no` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`m.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`m.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "warehouse_kind", kind: "text", ref: (tx) => tx`w.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`m.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "unit_id", kind: "uuid", ref: (tx) => tx`m.unit_id` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`m.quantity` },
  // NOT `requires: COST_READ`: 7B's movement and transfer registers print and total it under
  // `inventory.stock.read` (3D's recorded design) — a known limit, recorded in ADR 0065's amendment.
  { field: "value", kind: "numeric", ref: (tx) => tx`m.value` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`m.effective_date` },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`m.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`m.posted_at` },
];

export const inventoryMovementDataset: Dataset = defineDataset({
  id: "inventory_movement",
  columns: INVENTORY_MOVEMENT_COLUMNS,
  company: (tx, companyId) => tx`m.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.inventory_movement m
        join app.document      d  on d.id  = m.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.item          it on it.id = m.item_id
        join app.warehouse     w  on w.id  = m.warehouse_id
        join app.lot           lo on lo.id = m.lot_id`,
  select: (
    tx,
  ) => tx`m.id as movement_id, m.document_id as document_id, dt.code as document_type_code,
         d.number::int as document_number, m.line_no as line_no, m.movement_no as movement_no,
         m.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         m.warehouse_id as warehouse_id, w.code as warehouse_code, w.kind as warehouse_kind,
         w.branch_id as branch_id, m.lot_id as lot_id, lo.code as lot_code, m.unit_id as unit_id,
         m.quantity as quantity, m.value as value,
         to_char(m.effective_date, 'YYYY-MM-DD') as effective_date, m.posting_seq::int as posting_seq,
         to_char(m.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at`,
  // The total chronological key of spec:1225 / §4.3.5, so a movement register reads in costing order.
  defaultOrder: (tx) =>
    tx`m.effective_date asc, m.posting_seq asc, m.line_no asc, m.movement_no asc`,
});

// ── stock_on_hand — the SYNCHRONOUS projection (D14); the minimal-set report 3D re-expresses ─────────
const STOCK_ON_HAND_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`h.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "item_name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`h.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "warehouse_kind", kind: "text", ref: (tx) => tx`w.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`h.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "expires_on", kind: "date", ref: (tx) => tx`lo.expires_on` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`h.quantity` },
  { field: "base_unit_code", kind: "text", ref: (tx) => tx`u.code` },
];

export const stockOnHandDataset: Dataset = defineDataset({
  id: "stock_on_hand",
  columns: STOCK_ON_HAND_COLUMNS,
  company: (tx, companyId) => tx`h.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.stock_on_hand h
        join app.item            it on it.id = h.item_id
        join app.warehouse       w  on w.id  = h.warehouse_id
        join app.lot             lo on lo.id = h.lot_id
        join app.unit_of_measure u  on u.id  = it.base_unit_id`,
  select: (tx) => tx`h.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         it.name_ar as item_name_ar, h.warehouse_id as warehouse_id, w.code as warehouse_code,
         w.kind as warehouse_kind, w.branch_id as branch_id, h.lot_id as lot_id, lo.code as lot_code,
         to_char(lo.expires_on, 'YYYY-MM-DD') as expires_on, h.quantity as quantity, u.code as base_unit_code`,
  defaultOrder: (tx) => tx`it.code asc, w.code asc, lo.code asc`,
});

// ── cost_layer — read as stored. SAH-055: stock ageing reads layers, it never recomputes a cost ──────
const COST_LAYER_COLUMNS: readonly DatasetColumn[] = [
  { field: "layer_id", kind: "uuid", ref: (tx) => tx`cl.id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`cl.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`cl.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`cl.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`cl.movement_id` },
  { field: "qty_in", kind: "numeric", ref: (tx) => tx`cl.qty_in` },
  { field: "qty_remaining", kind: "numeric", ref: (tx) => tx`cl.qty_remaining` },
  costRead({ field: "unit_cost", kind: "numeric", ref: (tx) => tx`cl.unit_cost` }),
  // The layer's exact receipt value, STORED by migration 0118 (ADR 0039's approved amendment) — read here,
  // never qty × unit_cost.
  costRead({ field: "value", kind: "numeric", ref: (tx) => tx`cl.value` }),
  { field: "effective_at", kind: "date", ref: (tx) => tx`cl.effective_at` },
  { field: "sequence", kind: "integer", ref: (tx) => tx`cl.sequence` },
  { field: "invalidated_at", kind: "timestamp", ref: (tx) => tx`cl.invalidated_at` },
  // The age bucket a stock-ageing report groups on. It is a DATE difference, never a cost calculation.
  { field: "age_days", kind: "integer", ref: (tx) => tx`(current_date - cl.effective_at)` },
];

export const costLayerDataset: Dataset = defineDataset({
  id: "cost_layer",
  columns: COST_LAYER_COLUMNS,
  company: (tx, companyId) => tx`cl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.cost_layer cl
        join app.item      it on it.id = cl.item_id
        join app.warehouse w  on w.id  = cl.warehouse_id
        join app.lot       lo on lo.id = cl.lot_id`,
  select: (
    tx,
  ) => tx`cl.id as layer_id, cl.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         cl.warehouse_id as warehouse_id, w.code as warehouse_code, w.branch_id as branch_id,
         cl.lot_id as lot_id, lo.code as lot_code,
         cl.movement_id as movement_id, cl.qty_in as qty_in, cl.qty_remaining as qty_remaining,
         cl.unit_cost as unit_cost, cl.value as value, to_char(cl.effective_at, 'YYYY-MM-DD') as effective_at,
         cl.sequence::int as sequence,
         to_char(cl.invalidated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as invalidated_at,
         (current_date - cl.effective_at)::int as age_days`,
  defaultOrder: (tx) => tx`it.code asc, w.code asc, cl.effective_at asc, cl.sequence asc`,
});

// ── cost_consumption — which layer paid for which issue ─────────────────────────────────────────────
const COST_CONSUMPTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "consumption_id", kind: "uuid", ref: (tx) => tx`cc.id` },
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`cc.movement_id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`m.document_id` },
  { field: "layer_id", kind: "uuid", ref: (tx) => tx`cc.layer_id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`m.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`m.warehouse_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`m.lot_id` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`cc.quantity` },
  costRead({ field: "unit_cost", kind: "numeric", ref: (tx) => tx`cc.unit_cost` }),
  costRead({ field: "value", kind: "numeric", ref: (tx) => tx`cc.value` }),
  { field: "effective_date", kind: "date", ref: (tx) => tx`m.effective_date` },
  { field: "invalidated_at", kind: "timestamp", ref: (tx) => tx`cc.invalidated_at` },
];

export const costConsumptionDataset: Dataset = defineDataset({
  id: "cost_consumption",
  columns: COST_CONSUMPTION_COLUMNS,
  company: (tx, companyId) => tx`cc.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.cost_consumption cc
        join app.inventory_movement m  on m.id  = cc.movement_id
        join app.item               it on it.id = m.item_id`,
  select: (
    tx,
  ) => tx`cc.id as consumption_id, cc.movement_id as movement_id, m.document_id as document_id,
         cc.layer_id as layer_id, m.item_id as item_id, it.code as item_code,
         m.warehouse_id as warehouse_id, m.lot_id as lot_id, cc.quantity as quantity,
         cc.unit_cost as unit_cost, cc.value as value,
         to_char(m.effective_date, 'YYYY-MM-DD') as effective_date,
         to_char(cc.invalidated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as invalidated_at`,
  defaultOrder: (tx) => tx`m.effective_date asc, m.posting_seq asc, cc.id asc`,
});

// ── stock_valuation — 3B's ASYNC projection; read, never re-derived (spec:1204) ──────────────────────
const STOCK_VALUATION_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`sv.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "item_name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`sv.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "as_of", kind: "date", ref: (tx) => tx`sv.as_of` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`sv.quantity` },
  costRead({ field: "value", kind: "numeric", ref: (tx) => tx`sv.value` }),
];

export const stockValuationDataset: Dataset = defineDataset({
  id: "stock_valuation",
  columns: STOCK_VALUATION_COLUMNS,
  company: (tx, companyId) => tx`sv.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.stock_valuation sv
        join app.item      it on it.id = sv.item_id
        join app.warehouse w  on w.id  = sv.warehouse_id`,
  select: (tx) => tx`sv.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         it.name_ar as item_name_ar, sv.warehouse_id as warehouse_id, w.code as warehouse_code,
         w.branch_id as branch_id, to_char(sv.as_of, 'YYYY-MM-DD') as as_of,
         sv.quantity as quantity, sv.value as value`,
  defaultOrder: (tx) => tx`sv.as_of desc, it.code asc, w.code asc`,
});

// ── item_profitability — 4B's ASYNC projection. 7B's profit-by-item report reads THIS, never a recompute ──
const ITEM_PROFITABILITY_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`ip.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "item_name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`ip.fiscal_period_id` },
  {
    field: "fiscal_period_code",
    kind: "text",
    ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')`,
  },
  { field: "quantity_sold", kind: "numeric", ref: (tx) => tx`ip.quantity_sold` },
  { field: "revenue_base", kind: "numeric", ref: (tx) => tx`ip.revenue_base` },
  // NOT `requires: COST_READ`: 3D/4A's `inventory.sales_by_item` shows cost and margin under
  // `inventory.stock.read` by recorded design — a known limit (ADR 0065's amendment).
  { field: "cogs_base", kind: "numeric", ref: (tx) => tx`ip.cogs_base` },
  { field: "margin_base", kind: "numeric", ref: (tx) => tx`ip.margin_base` },
];

export const itemProfitabilityDataset: Dataset = defineDataset({
  id: "item_profitability",
  columns: ITEM_PROFITABILITY_COLUMNS,
  company: (tx, companyId) => tx`ip.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.item_profitability ip
        join app.item          it on it.id = ip.item_id
        join app.fiscal_period fp on fp.id = ip.fiscal_period_id`,
  select: (tx) => tx`ip.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         it.name_ar as item_name_ar, ip.fiscal_period_id as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM') as fiscal_period_code,
         ip.quantity_sold as quantity_sold, ip.revenue_base as revenue_base, ip.cogs_base as cogs_base,
         ip.margin_base as margin_base`,
  defaultOrder: (tx) => tx`fp.starts_on desc, ip.margin_base desc, it.code asc`,
});

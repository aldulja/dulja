// packages/db/src/projections/index.ts — the home of a projection that belongs to no single module.
// party_ageing lives under ar-ap/ because §4.8.2 places ageing in the AR/AP interface family;
// item_profitability is not an AR/AP concept at all — §4.6.1 registers it beside stock_valuation and it reads
// inventory_movement, cost_consumption and cost_layer — so it lives here (4B amendment 6).
export {
  ITEM_PROFITABILITY_CHECK,
  NON_SALE_MOVEMENT_TYPES,
  SALE_MOVEMENT_TYPES,
  compareItemProfitability,
  itemProfitabilityRows,
  rebuildItemProfitability,
  type ItemProfitabilityRow,
} from "./item-profitability";

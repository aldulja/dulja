import { PERMISSION } from "@dulja/contracts";

/**
 * The five codes §3.6.2 assigns slice 3A plus 3B's `inventory.cost.read`, named once so every inventory
 * route imports the constant rather
 * than repeating a string. This file is also what keeps the `permission-catalogue` lint green from THIS task
 * onward instead of from Task 11: the rule fails the build when a catalogue code has no reference in
 * `apps/api`, `apps/worker`, `apps/pos`, `packages/sync` or `packages/db/src` (§3.6.3), and the five
 * `PERMISSION[…]` reads below are those references. Tasks 11 and 12 then use the constant in their gates.
 *
 * Warehouses, units and unit conversions are maintained under `itemManage` — there is no separate warehouse
 * code, because §3.6.1 closes the vocabulary and spec:2159/2160 give neither `warehouse` nor `branch_manager`
 * any catalogue authority ("head office owns the catalogue"). Recorded as a contract addition to §3.6.2.
 */
export const INVENTORY_PERMISSION = {
  itemRead: PERMISSION["inventory.item.read"],
  itemManage: PERMISSION["inventory.item.manage"],
  priceManage: PERMISSION["inventory.price.manage"],
  stockRead: PERMISSION["inventory.stock.read"],
  negativeStockOverride: PERMISSION["inventory.negative_stock.override"],
  /** 3B — the valuation and cost-layer reads (§3.6.2). Non-mutating, so `auditor` may hold it (R7). */
  costRead: PERMISSION["inventory.cost.read"],
} as const;

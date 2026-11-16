-- 0042_add_inventory_report_index.sql — the one index the three minimal inventory reports need (spec:2300).
-- No table, no column, no constraint: this file touches a single index, so `lintSchema`'s table rules are
-- unaffected and the contracts §3.5.3 sets are unchanged.
-- Not `create index concurrently`: contracts §3.4.3 runs each migration file whole in one transaction.

-- ── 1. cost_consumption, covered for inventory.sales_by_item ──────────────────────────────────────────
-- `inventory.sales_by_item` aggregates cost_consumption per movement over a date range. cost_consumption
-- has no date of its own (it hangs off the movement), so the join is `movement_id` and the range lives on
-- inventory_movement, whose chronological index 3A already provides (migration 0031).
--
-- Migration 0034 (slice 3B) already created `cost_consumption_movement_idx` on exactly this key and
-- predicate WITHOUT an `include` list, so the report's join is already served and this file only widens
-- that index into a covering one: with `quantity` and `value` in the leaf, the per-movement sum is answered
-- from the index instead of heap-fetching every consumption row. A second index on the same key would be a
-- pure duplicate — write amplification on every posting transaction for nothing — so the existing one is
-- replaced rather than joined. 0042.down.sql restores 3B's definition exactly, byte for byte.
drop index app.cost_consumption_movement_idx;
create index cost_consumption_movement_idx
  on app.cost_consumption (movement_id)
  include (quantity, value)
  where invalidated_at is null;   -- a replay's superseded rows are never reported (spec:1223)

-- No index is added to app.stock_on_hand. Contracts §4.7.3 declares that table with
-- `primary key (company_id, item_id, warehouse_id, lot_id)` and `quantity` as its only other data column,
-- so the index an earlier draft of this file proposed was the primary key's own index plus an `include` of
-- the one column left over. `stockOnHand`'s keyset orders by `item.code, warehouse.code, lot.code` — codes
-- on the JOINED tables — and no index on this projection's uuid columns can order by those. The ordered
-- page's real cost is that sort, accepted deliberately at Phase 3 volumes.

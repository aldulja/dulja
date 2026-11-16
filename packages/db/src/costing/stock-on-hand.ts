import type { Sql } from "postgres";

export interface StockKey {
  itemId: string;
  warehouseId: string;
  lotId: string;
}

/**
 * **The one place the `stock:` advisory locks are taken, so both users of them take the same keys in the same
 * order.** Transaction-scoped (`pg_advisory_xact_lock`), de-duplicated, and acquired in sorted order — sorted
 * so two transactions touching an overlapping set queue behind one another instead of deadlocking. Re-locking
 * a key the same transaction already holds is a no-op that returns immediately, which is what lets step 9 and
 * step 12 both call this without either having to know whether the other did.
 *
 * **Two invariants depend on it, and each would be silently broken without it.**
 *
 * 1. **Step 9 — `assert_stock_available` (contracts §4.7.3).** The trigger computes availability as
 *    `sum(quantity)` over `app.inventory_movement` for the (company, item, warehouse, lot) key. §4.3.2 step 1
 *    takes `select … from app.document where id = $1 for update`, which serialises posters of ONE DOCUMENT
 *    and nothing more: two different documents issuing the same stock key hold different row locks, so under
 *    READ COMMITTED (§4.2.2; this plan's assumption 16) both read the same committed sum, both satisfy the
 *    trigger and both commit — leaving stock negative with no `inventory.negative_stock.override` event
 *    anywhere. That is acceptance test 18's claim falsified by concurrency alone. Holding the key's lock
 *    across the read-and-insert is what makes the second transaction read the first's committed row and be
 *    refused.
 * 2. **Step 12 — the MERGE.** 1A's amendment A4, applied to the second projection; 1A's own step-12 comment
 *    names this slice as the copier. `MERGE … WHEN NOT MATCHED THEN INSERT` is not `INSERT … ON CONFLICT`: it
 *    does not re-check the target when a concurrent transaction inserts the same key, so two posts that both
 *    find no `stock_on_hand` row take the NOT MATCHED branch and the second raises 23505 on the first's
 *    commit. The production `withTenant` retries only 40001 and 40P01 (§4.2.2), so that would surface as
 *    ERR_CONFLICT_UNIQUE on a legitimate post.
 */
export async function lockStockKeys(
  tx: Sql,
  companyId: string,
  keys: readonly StockKey[],
): Promise<void> {
  // Two grains, both taken, sorted together so two posters queue in one order. The per-LOT key is what
  // assert_stock_available's read-then-insert needs. The per-(item, warehouse) key is the COST LAYER's
  // scope: layers are read (openLayersFor) and rewritten (absolute qty_remaining) per item and warehouse
  // with no lot in the key, so two concurrent issues of one item from one warehouse but DIFFERENT lots
  // took disjoint lot locks, both read the same open layers, and the last writer silently overwrote the
  // other's consumption — a layer saying 50 remain while the movements said -10, caught only by the
  // nightly COST_LAYER_CHECK. Phase 3 review pass.
  const lockKeys = [
    ...new Set([
      ...keys.map((k) => `stock:${companyId}/${k.itemId}/${k.warehouseId}/${k.lotId}`),
      ...keys.map((k) => `layers:${companyId}/${k.itemId}/${k.warehouseId}`),
    ]),
  ].toSorted();
  for (const key of lockKeys) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}

/**
 * `postDocument` step 12's stock half — contracts §4.7.3's MERGE, verbatim, in the posting transaction (D14).
 *
 * The locks come first, through `lockStockKeys`. Step 9's `applyMovements` has already taken exactly these
 * keys, so in the ordinary posting path this call re-acquires locks the transaction holds and returns at once;
 * the call stays because a future caller of `mergeStockOnHand` that did not go through step 9 must not depend
 * on someone else having locked for it.
 */
export async function mergeStockOnHand(
  tx: Sql,
  input: {
    tenantId: string;
    companyId: string;
    documentId: string;
    keys: readonly StockKey[];
  },
): Promise<void> {
  await lockStockKeys(tx, input.companyId, input.keys);

  await tx`
    merge into app.stock_on_hand h
    using (select ${input.tenantId}::uuid as tenant_id, ${input.companyId}::uuid as company_id,
                  m.item_id, m.warehouse_id, m.lot_id, sum(m.quantity) as quantity
             from app.inventory_movement m where m.document_id = ${input.documentId}::uuid
            group by m.item_id, m.warehouse_id, m.lot_id) s
       on h.company_id = s.company_id and h.item_id = s.item_id
      and h.warehouse_id = s.warehouse_id and h.lot_id = s.lot_id
     when matched then update set quantity = h.quantity + s.quantity, updated_at = now()
     when not matched then insert (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
                           values (s.tenant_id, s.company_id, s.item_id, s.warehouse_id, s.lot_id, s.quantity)`;
}

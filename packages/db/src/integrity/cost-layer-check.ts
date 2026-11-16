import type { Sql } from "postgres";
// The types come from `./types` and NOTHING is imported from `./index` — `index.ts` imports this file to run
// the registration, so importing the barrel back would close a cycle. That is why 1B's ACCOUNT_BALANCE_CHECK
// and 3A's STOCK_ON_HAND_CHECK both take their types from `./types` and leave `registerProjectionCheck` to
// the barrel. This file follows them; it does not register itself.
import type { ProjectionCheck, ProjectionMismatch } from "./types";

/**
 * `cost_layer`'s one pure invariant: a valid layer's residue is what came in, less what valid consumptions
 * took out. Nothing else about a layer can be checked by aggregation — its `unit_cost` is arithmetic over an
 * immutable movement value and its date and sequence are copies — which is exactly why this, and not
 * `stock_valuation`, is the registered check (ADR 0039).
 *
 * Invalidated layers are SKIPPED, deliberately: between `invalidateFrom` and the replay's forward pass a
 * layer is legitimately mid-flight, and a nightly job that fired during a replay would otherwise raise an
 * incident about work in progress. The replay's own restart test is what covers that window.
 *
 * `run` takes the transaction and NOTHING else: `ProjectionCheck.run` is `(tx: Sql) => Promise<…>` and a
 * function with an extra required parameter is not assignable to it, so a `companyId` argument would make
 * `registerProjectionCheck(COST_LAYER_CHECK)` fail to compile. It needs none — the invariant is per-layer,
 * and the statement runs inside `withTenant`, which has already reduced the table to one tenant. That is why
 * 1B's `account_balance` and 3A's `stock_on_hand` checks take no company either.
 *
 * So the statement below carries **no `company_id` predicate**: there is no `companyId` binding in scope and
 * adding one would be a `TS2304` at `bun run typecheck`. A tenant's layers across all its companies is the
 * correct scan set for a per-layer invariant, and the mismatch's `key` names the layer, which resolves to its
 * company for anyone reading the incident.
 */
export const COST_LAYER_CHECK: ProjectionCheck = {
  name: "cost_layer",
  async run(tx: Sql): Promise<ProjectionMismatch[]> {
    const drift = await tx<
      { id: string; qty_remaining: string; qty_in: string; consumed: string }[]
    >`
      select l.id::text as id, l.qty_remaining::text as qty_remaining, l.qty_in::text as qty_in,
             coalesce((select sum(c.quantity) from app.cost_consumption c
                        where c.tenant_id = l.tenant_id and c.layer_id = l.id
                          and c.invalidated_at is null), 0)::text as consumed
        from app.cost_layer l
       where l.invalidated_at is null
         and l.qty_remaining <> l.qty_in - coalesce((select sum(c.quantity) from app.cost_consumption c
                                                      where c.tenant_id = l.tenant_id and c.layer_id = l.id
                                                        and c.invalidated_at is null), 0)
       order by l.effective_at, l.sequence`;
    return drift.map((d) => ({
      projection: "cost_layer" as const,
      key: { layerId: d.id },
      // `side` is required. Every row here is "amount_differs" by construction: the layer is present on both
      // sides of the comparison — it IS the row — and only its residue disagrees with the sum of its own
      // consumptions. The other two variants cannot arise from this query.
      side: "amount_differs" as const,
      detail: `layer ${d.id}: qty_remaining ${d.qty_remaining} does not equal qty_in ${d.qty_in} minus the ${d.consumed} its valid consumptions took`,
    }));
  },
};

# ADR 0034 — The per-item sentinel lot, and why `lot_id` is NOT NULL on every stock row

**Status:** PROPOSED — this fixes a primary-key shape and a NOT NULL on three stock tables, so spec:95 sends it to the owner before it is relied on. It is implemented ahead of approval, as ADR 0020 was and as Phase 2's 0026, 0027 and 0029-0031 were, and this line says so.
**Date:** 2026-09-20
**Deciders:** architect
**Slice:** 3A
**Supersedes:** nothing. **Related:** contracts §4.7.3, spec:1022, Part I LEGACY-050

## Context

`app.stock_on_hand`'s primary key is `(company_id, item_id, warehouse_id, lot_id)` and
`app.inventory_movement.lot_id` is NOT NULL (contracts §4.7.3). But the user need not enter a lot:
`document_line.lot_id` is deliberately nullable, and a great many lines — services, non-food goods,
a quick counter sale — legitimately carry none.

LEGACY-050 is what happens when the aggregate key admits NULL. `MtoJob = NULL` is unknown, so the old
system's increment matched no row, reported `ROW_COUNT = 0` and inserted a fresh one; the decrement
matched no row either and there was **no `ROW_COUNT = 0` fallback on the decrement**, so the row
stayed. Every NULL-job line accumulated one orphan, and the repair procedure grouped by the same
NULL and folded them all into one row the trigger could never find again.

## Decision

Every `app.item` insert creates one companion `app.lot` row with `code = 'NONE'`, no expiry, by an
AFTER INSERT trigger `item_sentinel_lot` (migration 0029). `applyMovements` (contracts §4.7.2)
resolves a null `document_line.lot_id` to that row before the movement insert. `lot_id` is therefore
NOT NULL on `inventory_movement`, on `stock_on_hand` and on `cost_layer` alike, the `MERGE` of
§4.7.3 always matches on a full key, and no aggregate row can ever be orphaned by an unknown value.

The sentinel is a real row, not a magic uuid: it has a tenant, a company, an audit trail and an FK
like any other lot, and `app.pick_lots_fefo` orders `expires_on nulls last`, so it is picked only
when no dated lot can satisfy the quantity.

## Consequences

- `document_line.lot_id` stays nullable and no wire contract requires a lot (contracts §4.6.1).
- A lot-tracked item's **receipt** without a lot is refused (`ERR_POLICY_REQUIRES_MISSING`), because
  pooling two food batches under `NONE` would defeat spec:1022's whole point. Issues resolve the
  sentinel and then usually fail loudly on `ERR_STOCK_INSUFFICIENT`, which is the correct answer.
- `SENTINEL_LOT_CODE` is exported from `@dulja/db` so the literal `'NONE'` is typed in exactly one
  place; the migration's SQL is the only other occurrence.
- Dropping the trigger silently breaks the step-12 `MERGE`, so `sentinelLotId` throws with a message
  naming this ADR rather than returning null.

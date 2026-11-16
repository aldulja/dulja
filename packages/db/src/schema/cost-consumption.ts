import { index, numeric, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.7.3 plus amendment A23 — what an issue consumed (3B, migration 0034). There is no natural
 * unique key: an AVCO issue takes a proportional slice of EVERY open layer, so one movement legitimately
 * produces many rows, and a recost marks the whole set `invalidated_at` and inserts a fresh one rather
 * than deleting anything (`app_rw` holds no DELETE — §3.5.4, spec:2049).
 *
 * `quantity`, `unit_cost` and `value` are MAGNITUDES; the movement carries the sign. Their three CHECKs
 * (`quantity > 0`, `unit_cost >= 0`, `value >= 0`) and the composite `(tenant_id, company_id)` key to
 * `app.company` are amendment A23, not §4.7.3's block — see migration 0034's header.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const costConsumption = app.table(
  "cost_consumption",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    movementId: uuid("movement_id").notNull(),
    layerId: uuid("layer_id").notNull(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 19, scale: 4 }).notNull(),
    value: numeric("value", { precision: 19, scale: 4 }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("cost_consumption_tenant_id_id_key").on(table.tenantId, table.id),
    // Both indexes are partial in migration 0034 (`where invalidated_at is null`); the predicate stays
    // there for the reason `cost_layer`'s mirror records — a `.where(...)` needs the `sql` tag that
    // `no-bare-db` refuses under `packages/*/src`. The three A23 CHECKs take the same split.
    index("cost_consumption_movement_idx").on(table.movementId),
    index("cost_consumption_layer_idx").on(table.layerId),
  ],
);

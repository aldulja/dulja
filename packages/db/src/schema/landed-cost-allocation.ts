import { index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Mirror of app.landed_cost_allocation (migration 0038). Reads only — every write goes through
 * packages/db/src/costing/landed-cost.ts (3C Task 8), which is inside the one directory contracts §4.3.2
 * licenses to touch costing state, and the draft-only and same-document rules live in the
 * `landed_cost_allocation_draft_only` trigger rather than here.
 *
 * There is deliberately NO `weight` column: the basis of a share is `method` plus the target line's own
 * `amount`, `quantity` or `custom_fields.weight_kg` (SAH-017, SAH-018).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const landedCostAllocation = app.table(
  "landed_cost_allocation",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    shipmentDocumentId: uuid("shipment_document_id").notNull(),
    costLineId: uuid("cost_line_id").notNull(),
    targetLineId: uuid("target_line_id").notNull(),
    method: text("method").notNull().$type<"by_value" | "by_quantity" | "by_weight">(),
    allocatedAmount: numeric("allocated_amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("landed_cost_allocation_tenant_id_id_key").on(table.tenantId, table.id),
    unique("landed_cost_allocation_cost_line_id_target_line_id_key").on(
      table.costLineId,
      table.targetLineId,
    ),
    index("landed_cost_allocation_document_idx").on(table.shipmentDocumentId),
    index("landed_cost_allocation_target_idx").on(table.targetLineId),
  ],
);

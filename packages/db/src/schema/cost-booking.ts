import { index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * What the ledger carries for one issue movement's cost, and whether that figure is settled — the cost replay's
 * durable restart state (migration 0115, ADR 0038 decisions 4 and 5, code review 2 findings C1 and C2).
 * `booked_value` is a MAGNITUDE; `pending` is null (settled), `'recost'` (the consumption set must be
 * recomputed) or `'booking'` (recomputed, the difference not yet posted). Derived and AUDIT_EXEMPT, like
 * `cost_layer` and `cost_consumption`, and written only by `packages/db/src/costing/`.
 *
 * The `pending` CHECK, the `booked_value >= 0` CHECK and the partial index's `where pending is not null` stay in
 * the migration, for the reason `cost_consumption`'s mirror records: a `.where(...)` needs the `sql` tag that
 * `no-bare-db` refuses under a package's `src/`.
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const costBooking = app.table(
  "cost_booking",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    movementId: uuid("movement_id").notNull(),
    bookedValue: numeric("booked_value", { precision: 19, scale: 4 }).notNull(),
    pending: text("pending", { enum: ["recost", "booking"] }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("cost_booking_tenant_id_movement_id_key").on(table.tenantId, table.movementId),
    unique("cost_booking_tenant_id_id_key").on(table.tenantId, table.id),
    index("cost_booking_pending_idx").on(table.companyId, table.pending),
  ],
);

import { bigint, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the exact-rational unit conversion (3A, migration 0028). "1 <unit> =
 * numerator / denominator base units" (spec:2043). SAH-066: the legacy `MatUnits.Exchange` was
 * `double precision` against `numeric(18,4)` quantities, so ten boxes round-tripped to 9.9999…
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const unitConversion = app.table(
  "unit_conversion",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    // `mode: "bigint"` and not "number": a conversion factor is exact and must never round (SAH-066).
    numerator: bigint("numerator", { mode: "bigint" }).notNull(),
    denominator: bigint("denominator", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("unit_conversion_item_id_unit_id_key").on(table.itemId, table.unitId),
    unique("unit_conversion_tenant_id_id_key").on(table.tenantId, table.id),
  ],
);

import { index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the warehouse tree (3A, migration 0029). `branch_id` is a BRANCH
 * `dimension_value` and is NOT NULL (spec:1023): a head-office store carries the head-office value,
 * which is what makes 6C's Form A″ `branch_isolation` policy total. `kind` is closed to
 * `stock | in_transit` by `warehouse_kind_check`; the `in_transit` waypoint is 3D's two-step
 * transfer (spec:1053). `parent_id` makes the tree, and `app.warehouse_no_cycle()` — one recursive
 * CTE, in one function — is what keeps it acyclic (SAH-071).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const warehouse = app.table(
  "warehouse",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    code: text("code").notNull(),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar"),
    kind: text("kind").notNull().default("stock").$type<"stock" | "in_transit">(),
    branchId: uuid("branch_id").notNull(),
    parentId: uuid("parent_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("warehouse_company_id_code_key").on(table.companyId, table.code),
    unique("warehouse_tenant_id_id_key").on(table.tenantId, table.id),
    // The migration declares this one `where parent_id is not null`. The predicate is not repeated
    // here: Drizzle spells a partial index with its `sql` tag, which `no-bare-db` refuses outside a
    // `tx`, and `item_barcode_idx` (Task 1) and `attachment_document_idx` (2C) are mirrored the same
    // way — the migration owns the predicate.
    index("warehouse_parent_idx").on(table.parentId),
    index("warehouse_branch_idx").on(table.companyId, table.branchId),
  ],
);

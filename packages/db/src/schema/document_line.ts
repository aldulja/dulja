import { index, integer, jsonb, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";
import { taxCode } from "./tax-code";

/**
 * contracts §4.3.4 — the Phase 1 base line table plus the ten columns of the 2A row (migration 0019).
 * Later slices add nullable or defaulted columns (3A warehouse/lot/unit, 3D count quantities, 5A the
 * tax-code FK); nothing is renamed. There is deliberately no branch key: the line is branch-isolated
 * through its document.
 */
export const documentLine = app.table(
  "document_line",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    description: text("description"),
    accountId: uuid("account_id"),
    debit: numeric("debit", { precision: 19, scale: 4 }).notNull(),
    credit: numeric("credit", { precision: 19, scale: 4 }).notNull(),
    dimensions: jsonb("dimensions").notNull(),
    customFields: jsonb("custom_fields").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 2A, migration 0019. `kind`'s $type is the full six-label union 6A's 0061 writes into
    // `document_line_kind_check` — 2A's four plus 'tender' and 'payroll' — and 8B's 0087 writes the identical
    // list, so the two phases may run in either order (contracts §4.3.4). The CHECK itself lives only in the
    // migration, as every mirror's does; the $type is what keeps TypeScript to the same six labels.
    // item_id / tax_code_id are FK slots: 3A's 0032 and 5A's 0055 add the keys.
    kind: text("kind")
      .notNull()
      .$type<"account" | "item" | "tax" | "text" | "tender" | "payroll">(),
    itemId: uuid("item_id"),
    quantity: numeric("quantity", { precision: 19, scale: 6 }),
    unitPrice: numeric("unit_price", { precision: 19, scale: 4 }),
    discount: numeric("discount", { precision: 19, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    taxCodeId: uuid("tax_code_id").references(() => taxCode.id),
    taxAmount: numeric("tax_amount", { precision: 19, scale: 4 }).notNull(),
    totalInclTax: numeric("total_incl_tax", { precision: 19, scale: 4 }).notNull(),
    cost: numeric("cost", { precision: 19, scale: 4 }),
    // 3A, migration 0032 — contracts §4.3.4's 3A row. All four are nullable: the deploy is the expand
    // half of expand/contract (spec:2057). `unit_id`/`unit_quantity` are the entered display pair
    // (spec:2043) from which app.document_line_base_quantity() derives `quantity` in the base unit.
    warehouseId: uuid("warehouse_id"),
    lotId: uuid("lot_id"), // nullable by design — applyMovements resolves the item's NONE sentinel
    unitId: uuid("unit_id"),
    unitQuantity: numeric("unit_quantity", { precision: 19, scale: 6 }),
    // 3D, migration 0040 — contracts §4.3.4. Both nullable; on a line that carries them `quantity` is the
    // signed variance (counted_quantity - expected_quantity), never a second stored number (SAH-018).
    countedQuantity: numeric("counted_quantity", { precision: 19, scale: 6 }),
    expectedQuantity: numeric("expected_quantity", { precision: 19, scale: 6 }),
  },
  (table) => [
    unique("document_line_document_id_line_no_key").on(table.documentId, table.lineNo),
    index("document_line_item_idx").on(table.itemId),
    // 0032's index is PARTIAL (`where warehouse_id is not null`); the predicate lives in the migration,
    // which is the authority for it, and the mirror records the name and the column.
    index("document_line_warehouse_idx").on(table.warehouseId),
  ],
);

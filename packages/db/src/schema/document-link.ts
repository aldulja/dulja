import { index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * contracts §4.6.1 — the order ↔ fulfilment link (3C, migration 0037). Mirror of app.document_link.
 * Reads only: every write goes through packages/db/src/documents/link.ts (3C Task 4), and the
 * over-fulfilment invariant lives in the `document_link_open_quantity` trigger, not here.
 *
 * `quantity` and `amount` are nullable because a header-only link (`source_line_id is null`) carries
 * neither; the migration's CHECKs pin the rest (`quantity > 0`, `amount >= 0`, the line/header pairing
 * and `source_document_id <> target_document_id`).
 *
 * This mirror is the diff source for the next slice that alters the table (ADR-0002, contracts §3.4.9).
 */
export const documentLink = app.table(
  "document_link",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    sourceDocumentId: uuid("source_document_id").notNull(),
    sourceLineId: uuid("source_line_id"),
    targetDocumentId: uuid("target_document_id").notNull(),
    targetLineId: uuid("target_line_id"),
    linkKind: text("link_kind")
      .notNull()
      .$type<"fulfils" | "converts_to" | "receives_against" | "returns" | "settles">(),
    quantity: numeric("quantity", { precision: 19, scale: 6 }),
    amount: numeric("amount", { precision: 19, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("document_link_tenant_id_id_key").on(table.tenantId, table.id),
    index("document_link_target_document_idx").on(table.targetDocumentId),
    // The two pair keys (`document_link_line_pair_key`, `document_link_header_pair_key`) and
    // `document_link_source_line_idx` are PARTIAL unique indexes in migration 0037. Their predicates
    // (`where source_line_id is not null` / `is null`) stay in the migration, as `cost_layer_open_idx`'s
    // and `document_line_warehouse_idx`'s do: a Drizzle `.where(...)` needs the `sql` tag, which
    // `no-bare-db` refuses anywhere under `packages/*/src` outside a `withTenant` tx.
  ],
);

import { integer, numeric, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/**
 * Mirror of the app.document_open_quantity VIEW (migration 0037). `.existing()` — Drizzle never emits its
 * DDL, which matters here more than usual: the view is created `with (security_invoker = true)` and a
 * Drizzle-generated replacement would silently drop that option and turn the view into a cross-tenant read
 * of every order in the database (ADR 0040 decision 5).
 *
 * `open_quantity` is `ordered − Σ linked`, recomputed on every read. It is never a column on
 * `document_line` and never will be (SAH-017, SAH-018).
 */
export const documentOpenQuantity = app
  .view("document_open_quantity", {
    tenantId: uuid("tenant_id"),
    companyId: uuid("company_id"),
    documentId: uuid("document_id"),
    documentLineId: uuid("document_line_id"),
    lineNo: integer("line_no"),
    itemId: uuid("item_id"),
    orderedQuantity: numeric("ordered_quantity", { precision: 19, scale: 6 }),
    linkedQuantity: numeric("linked_quantity", { precision: 19, scale: 6 }),
    openQuantity: numeric("open_quantity", { precision: 19, scale: 6 }),
  })
  .existing();

import { index, numeric, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** Mirror of app.document_event (migration 0021, contracts §4.5.2). READS ONLY — every write goes through a
 *  trigger (the status triggers of 0022) or the override door (0021). `from_status`/`to_status` are mirrored
 *  the way `document.ts` mirrors `status`: as text, never as a second `pgEnum("document_status")`. */
export const documentEvent = app.table(
  "document_event",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id").notNull(),
    eventKind: text("event_kind").notNull().$type<"transition" | "override">(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    overrideCode: text("override_code"),
    actorId: uuid("actor_id").notNull(),
    attributedTo: uuid("attributed_to"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // Migration 0045 (code review 2026-09-29): the base total a credit-limit override approved, stamped by
    // app.stamp_credit_override(); null on every other event.
    approvedBaseTotal: numeric("approved_base_total", { precision: 19, scale: 4 }),
    // Migration 0114 (code review 2): the stock content a negative-stock override approved, stamped by
    // app.stamp_stock_override() as app.document_stock_digest(); null on every other event.
    approvedStockDigest: text("approved_stock_digest"),
  },
  (t) => [
    unique("document_event_tenant_id_id_key").on(t.tenantId, t.id),
    index("document_event_document_idx").on(t.documentId, t.occurredAt),
    // 7B, migration 0077 (LEGACY-070) — report-filter indexes the 7B EXPLAIN gate found unserved.
    index("document_event_company_time_idx").on(t.companyId, t.occurredAt),
  ],
);

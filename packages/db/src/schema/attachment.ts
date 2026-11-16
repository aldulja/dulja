import { bigint, customType, index, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** `bytea` has no first-class Drizzle column; the driver hands back a Buffer either way. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Mirror of app.attachment (migration 0025, contracts §4.5.8). `lot_id` is 3A's (migration 0031). */
export const attachment = app.table(
  "attachment",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    documentId: uuid("document_id"),
    // 3A, migration 0031 — spec:1067 "linked to a document or a lot". `attachment_owner_check`
    // (`num_nonnulls(document_id, lot_id) = 1`) stays in the migration: a Drizzle CHECK needs the
    // `sql` tag `no-bare-db` refuses outside a `tx`, the same split `lot_expiry_idx` takes.
    lotId: uuid("lot_id"),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: bytea("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("attachment_object_key_key").on(t.objectKey),
    unique("attachment_tenant_id_id_key").on(t.tenantId, t.id),
    index("attachment_document_idx").on(t.documentId),
    index("attachment_company_idx").on(t.companyId, t.createdAt),
    // 3A, migration 0031. Its `where lot_id is not null` predicate stays in the migration, as
    // `attachment_document_idx`'s does — the mirror carries the columns, the migration the predicate.
    index("attachment_lot_idx").on(t.lotId),
  ],
);

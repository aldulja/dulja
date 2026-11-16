// packages/db/src/schema/einvoice-transmission.ts
import { customType, integer, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** `bytea` has no first-class Drizzle column; the mirror is a read model and `Buffer` is what
 *  postgres.js hands back for it, so the custom type states that rather than pretending it is text. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const einvoiceTransmission = app.table("einvoice_transmission", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  documentId: uuid("document_id").notNull(),
  transmitter: text("transmitter").notNull(),
  profileVersion: integer("profile_version"),
  externalId: text("external_id"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error"),
  requestSha256: bytea("request_sha256"),
  response: jsonb("response"),
  qrPayload: text("qr_payload"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  polledAt: timestamp("polled_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

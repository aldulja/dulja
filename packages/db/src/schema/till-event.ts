// packages/db/src/schema/till-event.ts — a READ mirror (§3.4.9) of migration 0070's app.till_event.
import { index, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const tillEvent = app.table(
  "till_event",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    terminalId: uuid("terminal_id").notNull(),
    shiftId: uuid("shift_id").notNull(),
    kind: text("kind").notNull(),
    ticketDocumentId: uuid("ticket_document_id"),
    cashierPrincipalId: uuid("cashier_principal_id").notNull(),
    supervisorPrincipalId: uuid("supervisor_principal_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // 0070, under the recorded void correction: the till's free-text reason, NULL when it sent none. A void's
    // reason is also what its override and its reversal record.
    reason: text("reason"),
    clientRef: uuid("client_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("till_event_tenant_id_id_key").on(t.tenantId, t.id),
    // §4.6.1 declares client_ref globally unique: re-sending a till event is idempotent with no company in hand.
    clientRef: unique("till_event_client_ref_key").on(t.clientRef),
    shiftIdx: index("till_event_shift_idx").on(t.shiftId, t.occurredAt),
  }),
);

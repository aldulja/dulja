// packages/db/src/schema/terminal-request-guard.ts — a READ mirror (§3.4.9) of migration 0060's signed-request
// replay guard (PR 12 review, extra finding E1; ADR 0055 decision 7). Its one writer is `claimSignedRequest`
// (packages/db/src/sync/identity.ts), a tagged template; nothing reads it through Drizzle. The table is
// AUDIT_EXEMPT and carries no branch key: one row per terminal, `seen` mapping the sha256 (hex) of each signed
// message the terminal has spent to that message's X-Terminal-Timestamp.
import { jsonb, pgSchema, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

export const terminalRequestGuard = app.table(
  "terminal_request_guard",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    terminalId: uuid("terminal_id").notNull(),
    seen: jsonb("seen").$type<Record<string, string>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tenantRow: unique("terminal_request_guard_tenant_id_id_key").on(t.tenantId, t.id),
    // `terminal_id uuid not null unique` in the SQL — a UNIQUE CONSTRAINT, declared as unique() for the same
    // reason `terminal_enrolment.code_hash` is: index() would make the Drizzle diff report a change every run.
    terminal: unique("terminal_request_guard_terminal_id_key").on(t.terminalId),
  }),
);

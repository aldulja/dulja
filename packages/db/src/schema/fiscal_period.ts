import { date, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { app } from "./tenant";

/** The fiscal period (0001 §5), plus the Phase 1 reopen_reason of ADR 0023 (spec:2179). */
export const fiscalPeriod = app.table(
  "fiscal_period",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: text("status").notNull(),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // 1A, spec:2179 — the audited reopen reason; the most recent one, history is in app.audit_log.
    reopenReason: text("reopen_reason"),
  },
  (table) => [
    // 1B, migration 0016 (SAH-070) — accounting.period.month_end scans (company_id, status, ends_on);
    // nothing on this table serves a scalar `ends_on < $1`.
    index("fiscal_period_company_status_ends_idx").on(table.companyId, table.status, table.endsOn),
  ],
);

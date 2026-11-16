import { date, pgSchema, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { bytea } from "./tax-transaction";

const app = pgSchema("app");

/** Mirror of app.tax_return (0054). */
export const taxReturn = app.table(
  "tax_return",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    companyId: uuid("company_id").notNull(),
    regimeId: uuid("regime_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").notNull().$type<"draft" | "generated" | "filed">(),
    payload: text("payload"),
    payloadSha256: bytea("payload_sha256"),
    generatedBy: uuid("generated_by"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    attachmentId: uuid("attachment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    perPeriod: unique("tax_return_company_id_regime_id_period_start_key").on(
      t.companyId,
      t.regimeId,
      t.periodStart,
    ),
  }),
);

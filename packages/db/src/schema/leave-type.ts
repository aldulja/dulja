import { boolean, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const app = pgSchema("app");

/** 8D, migration 0096 — ⚠️ OD-13 (answered build). READS ONLY (ADR 0002): every write goes through
 *  packages/db/src/hr/leave.ts's tagged templates. */
export const leaveType = app.table("leave_type", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").$type<"annual" | "sick" | "unpaid" | "other">().notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  paid: boolean("paid").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
